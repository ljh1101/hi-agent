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
