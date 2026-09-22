/**
 * Context projection: what the model sees vs. what the history stores.
 *
 * The agent keeps a full-fidelity `history` (the source of truth, and the base
 * for future persistence/rewind), but never sends it verbatim to the provider.
 * Instead `projectHistory()` builds the request view, applying age-based
 * pruning of old tool results so a long session cannot blow the context
 * window with stale command output.
 *
 * This mirrors the tool-result-pruner approach of dsh and opencode: cheap,
 * deterministic, model-free truncation that runs before every request. Heavy
 * LLM summarization (compaction) is a separate, later stage.
 */

import type { ChatMessage } from './types.ts'

export interface ContextOptions {
  /**
   * A tool result longer than this many characters becomes eligible for
   * pruning once its turn is old enough. Default 2000.
   */
  pruneThresholdChars?: number
  /** Characters kept from the head of a pruned result. Default 300. */
  pruneHeadChars?: number
  /** Characters kept from the tail of a pruned result. Default 300. */
  pruneTailChars?: number
  /**
   * The most recent N user turns whose tool results are never pruned. The
   * model most likely still needs those. Default 3.
   */
  protectedTurns?: number
}

const DEFAULTS = {
  pruneThresholdChars: 2000,
  pruneHeadChars: 300,
  pruneTailChars: 300,
  protectedTurns: 3,
}

/** Marker inserted where content was removed, mirroring dsh's PRUNE_MARKER. */
const PRUNE_MARKER = (removed: number): string => `\n[... ${removed} characters pruned ...]\n`

export interface ResolvedContextOptions {
  pruneThresholdChars: number
  pruneHeadChars: number
  pruneTailChars: number
  protectedTurns: number
}

export function resolveContextOptions(options: ContextOptions = {}): ResolvedContextOptions {
  return {
    pruneThresholdChars: options.pruneThresholdChars ?? DEFAULTS.pruneThresholdChars,
    pruneHeadChars: options.pruneHeadChars ?? DEFAULTS.pruneHeadChars,
    pruneTailChars: options.pruneTailChars ?? DEFAULTS.pruneTailChars,
    protectedTurns: options.protectedTurns ?? DEFAULTS.protectedTurns,
  }
}

/**
 * Build the message view for the next model request.
 *
 * Rules:
 * - system / user / assistant messages are passed through untouched
 * - a tool message is pruned only when BOTH apply:
 *   1. it is longer than the threshold, and
 *   2. it belongs to a user turn older than the `protectedTurns` most recent
 *      turns (turns are delimited by user messages)
 * - pruning keeps the head and tail and marks the removed middle, so the model
 *   knows content existed and roughly how much
 */
export function projectHistory(
  history: readonly ChatMessage[],
  options: ResolvedContextOptions,
): ChatMessage[] {
  const cutoff = protectedCutoff(history, options.protectedTurns)
  return history.map((message, index) => {
    if (message.role !== 'tool') return message
    if (index >= cutoff) return message
    // Tool messages always carry a string content (only assistant may be null).
    const content = message.content ?? ''
    if (content.length <= options.pruneThresholdChars) return message
    return { ...message, content: pruneMiddle(content, options) }
  })
}

/**
 * Index before which tool messages may be pruned. Everything from the message
 * that starts the Nth-to-last user turn onward is protected.
 */
function protectedCutoff(history: readonly ChatMessage[], protectedTurns: number): number {
  if (protectedTurns <= 0) return history.length
  let cutoff = history.length
  let turns = 0
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.role === 'user') {
      turns++
      if (turns >= protectedTurns) return index
    }
    cutoff = index
  }
  // Fewer user turns than the protection window: protect everything.
  return turns > 0 ? 0 : cutoff
}

/** Keep head and tail, replace the middle with a size marker. */
export function pruneMiddle(text: string, options: ResolvedContextOptions): string {
  const keep = options.pruneHeadChars + options.pruneTailChars
  if (text.length <= keep) return text
  const head = text.slice(0, options.pruneHeadChars)
  const tail = text.slice(text.length - options.pruneTailChars)
  return `${head}${PRUNE_MARKER(text.length - keep)}${tail}`
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/**
 * Rough per-message token estimate: characters / 4. Conservative by design
 * (overestimates for most languages), same heuristic pi and opencode use.
 */
export function estimateTokens(message: ChatMessage): number {
  let chars = message.content?.length ?? 0
  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      chars += call.name.length + call.arguments.length
    }
  }
  return Math.ceil(chars / 4)
}

export interface ContextUsage {
  /** Best estimate of the tokens the next request will carry. */
  tokens: number
  /** True when the estimate is grounded in a real usage report. */
  hasUsageBasis: boolean
}

/**
 * Estimate the context size of a message list using the hybrid strategy:
 * the last message with a real usage report anchors the count, and anything
 * after it is estimated with chars/4. Without any usage, everything is
 * estimated. This mirrors pi's `estimateContextTokens`.
 *
 * `usages` maps a message index to the usage the provider reported for the
 * request that ended at that assistant message.
 */
export function contextUsage(
  messages: readonly ChatMessage[],
  usages: ReadonlyMap<number, TokenUsage>,
): ContextUsage {
  let anchorIndex = -1
  let anchorTokens = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = usages.get(index)
    if (usage && (usage.totalTokens ?? 0) > 0) {
      // totalTokens covers the whole request that produced this message:
      // everything before it plus the message itself.
      anchorIndex = index
      anchorTokens = usage.totalTokens ?? 0
      break
    }
  }

  if (anchorIndex === -1) {
    let total = 0
    for (const message of messages) total += estimateTokens(message)
    return { tokens: total, hasUsageBasis: false }
  }

  let trailing = 0
  for (let index = anchorIndex + 1; index < messages.length; index++) {
    trailing += estimateTokens(messages[index]!)
  }
  return { tokens: anchorTokens + trailing, hasUsageBasis: true }
}

// ---------------------------------------------------------------------------
// Compaction (stage 3)
// ---------------------------------------------------------------------------

export interface CompactionOptions {
  /**
   * Total context window of the model in tokens. Auto-compaction is disabled
   * when unknown (0). There is no reliable cross-provider way to discover this,
   * so it must be supplied by the caller.
   */
  contextWindow?: number
  /**
   * Compaction triggers when usage exceeds `contextWindow * thresholdRatio`.
   * A ratio scales across windows from 8k local models to 1M models, where a
   * fixed token reserve cannot (a 16k reserve is 200% of an 8k window — the
   * threshold goes negative and compaction never stops firing). Default 0.8.
   */
  thresholdRatio?: number
  /**
   * After compaction, keep this fraction of the context window verbatim.
   * Default 0.2.
   */
  retainRatio?: number
  /**
   * Explicit token overrides, taking precedence over the ratios. Prefer the
   * ratios unless you know the exact budget you want.
   */
  reserveTokens?: number
  keepRecentTokens?: number
}

const COMPACTION_DEFAULTS = {
  thresholdRatio: 0.8,
  retainRatio: 0.2,
}

export interface ResolvedCompactionOptions {
  contextWindow: number
  thresholdRatio: number
  retainRatio: number
  /** Derived: window - window*ratio, or the explicit override. */
  thresholdTokens: number
  /** Derived: window * retainRatio, or the explicit override. */
  keepRecentTokens: number
}

export function resolveCompactionOptions(options: CompactionOptions = {}): ResolvedCompactionOptions {
  const contextWindow = options.contextWindow ?? 0
  const thresholdRatio = options.thresholdRatio ?? COMPACTION_DEFAULTS.thresholdRatio
  const retainRatio = options.retainRatio ?? COMPACTION_DEFAULTS.retainRatio
  // Never let the threshold go non-positive: a tiny window must still be able
  // to reach it, or compaction would fire on every step forever.
  const thresholdTokens =
    options.reserveTokens !== undefined
      ? options.reserveTokens
      : Math.max(1, Math.floor(contextWindow * thresholdRatio))
  const keepRecentTokens =
    options.keepRecentTokens !== undefined
      ? options.keepRecentTokens
      : Math.max(1, Math.floor(contextWindow * retainRatio))
  return { contextWindow, thresholdRatio, retainRatio, thresholdTokens, keepRecentTokens }
}

/** Whether the estimated usage crosses the compaction threshold. */
export function shouldCompact(
  estimatedTokens: number,
  options: ResolvedCompactionOptions,
): boolean {
  if (options.contextWindow <= 0) return false
  return estimatedTokens > options.thresholdTokens
}

export interface CutPoint {
  /**
   * Index of the first message to keep. Everything before it (except system
   * messages) is compacted away. 0 means "keep everything" (no cut).
   */
  keepFrom: number
}

/**
 * Find the cut point that keeps approximately `keepRecentTokens` of the newest
 * history. Walks backwards accumulating estimates, then advances to the next
 * user/assistant boundary so a tool result is never separated from its call.
 */
export function findCutPoint(
  messages: readonly ChatMessage[],
  keepRecentTokens: number,
): CutPoint {
  let accumulated = 0
  let cut = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === 'system') continue
    accumulated += estimateTokens(message)
    if (accumulated >= keepRecentTokens) {
      cut = index
      break
    }
    cut = index
  }

  // Advance to a boundary that never splits a tool result from its call:
  // the cut must land on a user message (a turn start), or on an assistant
  // message whose tool calls (and therefore results) follow it.
  while (cut < messages.length) {
    const role = messages[cut]!.role
    if (role === 'user') return { keepFrom: cut }
    if (role === 'assistant') {
      // An assistant with tool_calls may be followed by tool results; keep them
      // together by cutting *at* the assistant (results come after, kept).
      return { keepFrom: cut }
    }
    cut++ // tool or other: move forward to the next boundary
  }
  return { keepFrom: messages.length }
}

/**
 * Serialize the messages being compacted away into the transcript the
 * summarizer model reads. Two budgets keep the summarization request itself
 * inside the window: each tool result is capped (`maxToolChars`) and the whole
 * transcript is capped (`maxTotalChars`) by dropping the OLDEST lines first —
 * the tail carries the most recent, most relevant context. A drop marker
 * records what was removed.
 */
export function serializeForSummary(
  messages: readonly ChatMessage[],
  maxToolChars = 2000,
  maxTotalChars = 60_000,
): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      lines.push(`[User]: ${message.content ?? ''}`)
    } else if (message.role === 'assistant') {
      if (message.content) lines.push(`[Assistant]: ${message.content}`)
      for (const call of message.tool_calls ?? []) {
        lines.push(`[Assistant tool call]: ${call.name}(${call.arguments})`)
      }
    } else if (message.role === 'tool') {
      const content = message.content ?? ''
      const shown =
        content.length <= maxToolChars
          ? content
          : `${content.slice(0, maxToolChars)}\n[truncated]`
      lines.push(`[Tool result]: ${shown}`)
    }
  }

  let text = lines.join('\n')
  if (text.length <= maxTotalChars) return text

  // Over budget: drop oldest lines until it fits, with a marker up front.
  const kept: string[] = []
  let total = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (total + line.length > maxTotalChars - 100) break
    kept.unshift(line)
    total += line.length
  }
  const dropped = lines.length - kept.length
  return `[... ${dropped} oldest lines dropped to fit the summarization budget ...]\n${kept.join('\n')}`
}

/** Prompt for the summarization call, asking for a structured checkpoint. */
export const SUMMARY_PROMPT = `Summarize the conversation transcript above. Another instance of the assistant will continue the work using only your summary, so preserve what matters to continue.

Use this format:

## Goal
What the user is trying to accomplish.

## Constraints & Preferences
Any requirements, preferences, or constraints mentioned by the user.

## Progress
- Done: completed steps and changes (mention exact file paths)
- In progress: what was being worked on
- Blocked: anything preventing progress

## Key Decisions
Decisions made and why.

## Next Steps
What should happen next, in order.

Keep each section concise. Preserve exact file paths, commands, and error messages. Reply with the summary only.`
