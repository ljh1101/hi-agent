import type {
  AgentEvent,
  ChatMessage,
  LLM,
  LLMResponse,
  RunResult,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  UndoResult,
} from './types.ts'
import { ChangeJournal } from './changes.ts'
import { ToolRegistry } from './tools/registry.ts'
import {
  contextUsage,
  findCutPoint,
  projectHistory,
  projectRequestView,
  resolveCompactionOptions,
  resolveContextOptions,
  serializeForSummary,
  shouldCompact,
  SUMMARY_PROMPT,
  type CompactionOptions,
  type ContextOptions,
  type ResolvedCompactionOptions,
} from './context.ts'
import { buildDefaultSystemPrompt } from './prompts/system.ts'

export { DEFAULT_SYSTEM_PROMPT, buildDefaultSystemPrompt, buildToolsSection } from './prompts/system.ts'

/** Per-run knobs. */
export interface RunOptions {
  /**
   * Cancel *this* turn (a UI's Ctrl+C) without tearing down the agent. Falls
   * back to the signal given to the constructor.
   */
  signal?: AbortSignal
}

export interface AgentOptions {
  llm: LLM
  tools?: readonly Tool[]
  /** `null` disables the system prompt entirely. */
  systemPrompt?: string | null
  /** Hard cap on model round-trips per `run()` call. */
  maxSteps?: number
  /** Directory tools resolve relative paths against. Defaults to `process.cwd()`. */
  root?: string
  /** Progress sink for the UI. Never seen by the model. */
  onEvent?: (event: AgentEvent) => void
  /** Aborts the current run and any in-flight model request. */
  signal?: AbortSignal
  /** Per-tool execution timeout. Defaults to 30s. */
  toolTimeoutMs?: number
  /**
   * Approval hook for risky tool executions. When provided, tools with a
   * `permission` of `write` or `dangerous` call it (via `ToolContext.approve`)
   * and a `false` result turns into an observation, not a crash. Tools that
   * never ask (e.g. `read`) run without approval regardless.
   */
  approver?: (request: string, command?: string) => Promise<boolean>
  /**
   * Prefer `llm.stream()` when available, emitting `token` events as text
   * arrives. Defaults to true; set to false to use `chat()` (non-streaming).
   */
  stream?: boolean
  /**
   * How the request view is derived from the history. Old tool results beyond
   * these budgets are pruned in the projection (the history itself is never
   * modified). See `src/context.ts`.
   */
  contextOptions?: ContextOptions
  /**
   * Compaction: when the estimated context crosses the threshold, the agent
   * summarizes the old part of the conversation with an LLM call and replaces
   * it in the history. Disabled unless `contextWindow` is set. See
   * `src/context.ts`.
   */
  compaction?: CompactionOptions
  /**
   * Persistence hooks. `onAppend` fires after every message the run loop adds
   * (user / assistant / tool); `onReplace` fires when compaction rewrote the
   * whole history. A session layer can use these to keep a JSONL file in
   * sync without the agent knowing about files.
   */
  onAppend?: (message: ChatMessage) => void
  onReplace?: (history: readonly ChatMessage[]) => void
}

/**
 * The agent loop.
 *
 * One iteration is: send the conversation to the model, append its reply, then
 * run every requested tool and append each result as an observation. The loop
 * ends when the model replies without tool calls (its answer), when `maxSteps`
 * is reached, or when aborted.
 *
 * The loop is intentionally provider-agnostic and framework-free — this is the
 * whole core.
 */
export class Agent {
  /** The live conversation. Grows across `run()` calls, which gives multi-turn memory. */
  readonly history: ChatMessage[] = []

  private llm: LLM
  private readonly registry: ToolRegistry
  private readonly maxSteps: number
  private readonly root: string
  private readonly toolTimeoutMs: number
  private readonly onEvent: ((event: AgentEvent) => void) | undefined
  private readonly signal: AbortSignal | undefined
  private readonly stream: boolean
  private readonly contextOptions: ReturnType<typeof resolveContextOptions>
  private persistenceOnAppend: ((message: ChatMessage) => void) | undefined
  private persistenceOnReplace: ((history: readonly ChatMessage[]) => void) | undefined
  private readonly compactionOptions: ResolvedCompactionOptions
  /** Provider-reported usage, anchored at the assistant message it produced. */
  private readonly usages = new Map<number, { totalTokens?: number }>()
  private approver: ((request: string, command?: string) => Promise<boolean>) | undefined
  /** What each turn wrote, so `undoLastTurn()` can put it back. */
  private readonly journal = new ChangeJournal()

  constructor(options: AgentOptions) {
    this.llm = options.llm
    this.registry = new ToolRegistry(options.tools ?? [])
    this.maxSteps = Math.max(1, options.maxSteps ?? 12)
    this.root = options.root ?? process.cwd()
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000
    this.onEvent = options.onEvent
    this.signal = options.signal
    this.stream = options.stream ?? true
    this.approver = options.approver
    this.contextOptions = resolveContextOptions(options.contextOptions)
    this.compactionOptions = resolveCompactionOptions(options.compaction)
    this.persistenceOnAppend = options.onAppend
    this.persistenceOnReplace = options.onReplace

    // One system message assembled from identity, the tools section (built
    // from each tool's promptSnippet/promptGuidelines), and behavior rules.
    // A user-supplied prompt replaces the whole assembly.
    const systemPrompt =
      options.systemPrompt === undefined
        ? buildDefaultSystemPrompt(this.registry.list())
        : options.systemPrompt
    if (systemPrompt) {
      this.history.push({ role: 'system', content: systemPrompt })
    }
  }

  /**
   * Clear the conversation, keeping the system prompt(s).
   *
   * The persistence hook fires: a session that is cleared in memory but left
   * intact on disk comes back on the next resume, which reads as the clear
   * silently not working.
   */
  reset(): void {
    const systemMessages = this.history.filter((message) => message.role === 'system')
    this.history.length = 0
    this.history.push(...systemMessages)
    this.usages.clear()
    // Undo marks index into a history that no longer exists.
    this.journal.clear()
    this.persistenceOnReplace?.(this.history)
  }

  /**
   * Current context-size estimate (tokens) for the next request.
   *
   * Deliberately the *ordinary* projection, not the emergency one the request
   * may fall back to: this number drives compaction and is what the UI reports,
   * and both should reflect what the conversation actually demands. Measuring
   * the degraded view here would report "under budget" whenever the emergency
   * pass squeezed under it, so compaction would stop being attempted and the
   * destructive projection would quietly become the steady state.
   */
  estimateContextTokens(): number {
    return contextUsage(projectHistory(this.history, this.contextOptions), this.usages).tokens
  }

  /**
   * What the model sees. The projection rules live in `src/context.ts`; this
   * only supplies the history, the budgets and the usage anchors.
   */
  private requestView(): ChatMessage[] {
    return projectRequestView(this.history, this.contextOptions, this.compactionOptions, this.usages)
  }

  /**
   * Compact the conversation: summarize everything before the cut point with
   * an LLM call and replace it in the history, keeping the system prompt(s)
   * and the most recent turns verbatim.
   *
   * This is the one operation that intentionally rewrites stored history —
   * the detail loss is the explicit trade for being able to continue. On
   * summarization failure nothing is changed and the run proceeds (the next
   * request may then hit the provider's window limit, which is safer than
   * corrupting the conversation).
   */
  async compact(signal: AbortSignal | undefined = this.signal): Promise<boolean> {
    const { keepFrom } = findCutPoint(this.history, this.compactionOptions.keepRecentTokens)
    // The user's system prompt(s) survive every compaction; a previous summary
    // is not one of them — it is replaced by the new one below. Keeping both
    // apart matters: stacking them left every older summary in the history
    // forever, so the model saw several stale "Next Steps" at once and the
    // system prefix grew with every compaction until it could no longer be
    // compacted away.
    const systemMessages = this.history.filter(
      (message) => message.role === 'system' && message.summary !== true,
    )
    const previousSummaries = this.history.filter(
      (message) => message.role === 'system' && message.summary === true,
    )
    const compacted = this.history.slice(0, keepFrom).filter((message) => message.role !== 'system')
    if (compacted.length === 0) {
      // Nothing eligible to compact: the whole history fits in the keep budget.
      // Not an error — report it so UIs can say "nothing to compact" instead
      // of a misleading "compacted".
      this.emit({ type: 'compaction', summaryTokens: 0, keptFrom: keepFrom, ok: true })
      return true
    }

    const transcript = serializeForSummary(compacted)
    try {
      const summaryReply = await this.llm.chat(
        [
          ...systemMessages,
          // The summarizer does see the previous summary, so replacing it
          // loses nothing: whatever it captured is carried into the new one.
          ...previousSummaries,
          { role: 'user', content: `${transcript}\n\n---\n\n${SUMMARY_PROMPT}` },
        ],
        [], // no tools: the summarizer must only summarize
        { signal },
      )
      const summary = summaryReply.content?.trim()
      if (!summary) return false

      const kept = this.history.slice(keepFrom)
      this.history.length = 0
      this.history.push(
        ...systemMessages,
        { role: 'system', content: `Summary of the earlier conversation:\n\n${summary}`, summary: true },
        ...kept,
      )
      // Usage anchors refer to old indices; drop them (estimates take over).
      this.usages.clear()
      // A compaction rewrote history: the persistence layer needs the snapshot.
      this.persistenceOnReplace?.(this.history)

      this.emit({
        type: 'compaction',
        summaryTokens: Math.ceil(summary.length / 4),
        keptFrom: keepFrom,
        ok: true,
      })
      return true
    } catch {
      // Provider failure during summarization: leave history untouched.
      this.emit({ type: 'compaction', summaryTokens: 0, keptFrom: keepFrom, ok: false })
      return false
    }
  }

  /** Swap the model/provider mid-session without losing the conversation. */
  setLLM(llm: LLM): void {
    this.llm = llm
  }

  /**
   * Replace the whole history (resuming a saved session). Does not fire the
   * persistence hooks: the session layer owns what lands on disk.
   */
  restoreHistory(history: readonly ChatMessage[]): void {
    this.history.length = 0
    this.history.push(...history)
    this.usages.clear()
    // A resumed conversation has no journal: the changes it made were recorded
    // in the process that made them.
    this.journal.clear()
  }

  /** Attach or replace the approval hook for risky tool executions. */
  setApprover(approver: (request: string, command?: string) => Promise<boolean>): void {
    this.approver = approver
  }

  /**
   * Attach or replace the persistence hooks after construction (used by the
   * CLI, which wires the session store after building the agent).
   */
  setPersistenceHooks(
    onAppend: (message: ChatMessage) => void,
    onReplace: (history: readonly ChatMessage[]) => void,
  ): void {
    this.persistenceOnAppend = onAppend
    this.persistenceOnReplace = onReplace
  }

  /**
   * Run one turn: give the agent an input and let it work until it answers.
   * Never throws for model/tool failures that the model can recover from.
   */
  async run(input: string, options: RunOptions = {}): Promise<RunResult> {
    // A per-run signal lets a UI cancel *this* turn (Ctrl+C at the prompt)
    // without tearing down the agent; the constructor's signal still applies as
    // the default, which is what library users pass once for the whole session.
    const signal = options.signal ?? this.signal

    // Where an undo of this turn rewinds the conversation to: the message that
    // was last before the user's request, so the rewind drops the request too.
    this.journal.beginTurn(this.history.at(-1) ?? null)
    this.append({ role: 'user', content: input })
    const definitions = this.registry.definitions()

    let lastContent = ''
    let compactionFailed = false
    for (let step = 1; step <= this.maxSteps; step++) {
      if (signal?.aborted) {
        return this.finish(lastContent, step - 1, 'aborted')
      }
      this.emit({ type: 'step', step })

      // Auto-compaction: when the estimate crosses the threshold, compress
      // before the request goes out. Disabled unless a contextWindow was given.
      // After a failed compaction we stop retrying within this run: retrying
      // every step would burn an LLM call per step on a doomed summarization.
      if (
        !compactionFailed &&
        shouldCompact(this.estimateContextTokens(), this.compactionOptions)
      ) {
        const ok = await this.compact(signal)
        if (!ok) compactionFailed = true
      }

      this.emit({ type: 'context_usage', tokens: this.estimateContextTokens() })

      const reply = await this.askModel(definitions, signal)
      lastContent = reply.content ?? ''
      this.emit({ type: 'assistant', content: lastContent, toolCalls: reply.toolCalls })

      // The stream may have been aborted mid-reply; treat it as a stop, not a final answer.
      if (signal?.aborted) {
        return this.finish(lastContent, step, 'aborted')
      }

      this.append({
        role: 'assistant',
        content: lastContent,
        ...(reply.toolCalls.length > 0 ? { tool_calls: reply.toolCalls } : {}),
      })
      // Anchor the provider-reported usage at this assistant message: the
      // request that produced it covered the whole history up to here.
      if (reply.usage?.totalTokens) {
        this.usages.set(this.history.length - 1, reply.usage)
      }

      if (reply.toolCalls.length === 0) {
        const content = lastContent.trim()
        this.emit({ type: 'final', content })
        return this.finish(content, step, 'final')
      }

      // Run the requested tools. Independent calls could be parallelized here,
      // but sequential execution keeps ordering deterministic for the model.
      //
      // Every call gets a result even after an abort, because the history must
      // stay replayable: an assistant message whose tool_calls have no matching
      // tool messages is rejected by every provider on the *next* request. An
      // aborted call therefore reports the abort as its observation.
      for (const call of reply.toolCalls) {
        const observation = await this.executeTool(call, signal)
        this.append({
          role: 'tool',
          content: observation.content,
          tool_call_id: call.id,
          name: call.name,
        })
      }
    }

    this.emit({ type: 'max_steps', steps: this.maxSteps })
    const content = `Stopped after ${this.maxSteps} steps without a final answer. Last message: ${lastContent.trim() || '(none)'}`
    return this.finish(content, this.maxSteps, 'max_steps')
  }

  /**
   * Undo the last turn: put back the files it changed and drop its messages.
   *
   * Both halves matter. Restoring the files without the conversation leaves a
   * model that believes its edits are on disk; dropping the conversation
   * without the files leaves a session describing code that no longer exists.
   * Returns `undefined` when there is nothing left to undo.
   */
  async undoLastTurn(): Promise<UndoResult | undefined> {
    const undone = await this.journal.undo(this.root)
    if (!undone) return undefined

    // Rewind to just after the boundary message. When the boundary is gone the
    // history was rewritten underneath the turn (compaction summarized it away),
    // and the pre-turn state no longer exists: the files are still restored, but
    // the conversation is left alone rather than truncated to a guess.
    const boundaryIndex = undone.boundary ? this.history.indexOf(undone.boundary) : -1
    const rewound = undone.boundary === null || boundaryIndex >= 0
    const keep = undone.boundary === null ? 0 : boundaryIndex + 1
    const dropped = rewound ? this.history.length - keep : 0

    if (rewound) {
      this.history.length = keep
      // Usage anchors point at indices that no longer exist.
      this.usages.clear()
      // The conversation on disk has to agree, or the next resume replays the
      // turn that was just undone.
      this.persistenceOnReplace?.(this.history)
    }

    return {
      restored: undone.restored,
      removed: undone.removed,
      droppedMessages: dropped,
      rewound,
    }
  }

  /**
   * Ask the model for one reply. Prefers streaming when the LLM supports it,
   * emitting `token` events as text arrives; otherwise falls back to `chat()`.
   *
   * The model never sees `history` directly: it sees a projection where old
   * tool results are pruned, while the stored history keeps full fidelity.
   */
  private async askModel(
    definitions: ToolDefinition[],
    signal: AbortSignal | undefined,
  ): Promise<LLMResponse> {
    const view = this.requestView()
    if (this.stream && this.llm.stream) {
      let content = ''
      const toolCalls: ToolCall[] = []
      let usage: LLMResponse['usage']
      try {
        for await (const event of this.llm.stream(view, definitions, { signal })) {
          if (event.type === 'delta') {
            content += event.delta
            this.emit({ type: 'token', delta: event.delta })
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.call)
          } else {
            content = event.content
            usage = event.usage
          }
        }
      } catch (error) {
        // A mid-stream abort means the run is being cancelled; surface it as an
        // aborted stop instead of a provider exception.
        if (signal?.aborted) {
          return { content, toolCalls, usage }
        }
        throw error
      }
      return { content, toolCalls, usage }
    }
    return this.llm.chat(view, definitions, { signal })
  }

  /**
   * Execute one tool call and turn every outcome — including bad JSON, unknown
   * tools, throws and timeouts — into an observation string.
   */
  private async executeTool(
    call: ToolCall,
    signal: AbortSignal | undefined,
  ): Promise<{ content: string; isError: boolean }> {
    const startedAt = Date.now()
    let parsedArgs: unknown = {}

    try {
      parsedArgs = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return this.observeTool(call, `Error: arguments were not valid JSON (${reason}).`, true, startedAt)
    }

    this.emit({ type: 'tool_call', id: call.id, name: call.name, args: parsedArgs })

    const tool = this.registry.get(call.name)
    if (!tool) {
      const available = this.registry.names().join(', ') || '(none)'
      return this.observeTool(
        call,
        `Error: unknown tool "${call.name}". Available tools: ${available}.`,
        true,
        startedAt,
      )
    }

    if (parsedArgs === null || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
      return this.observeTool(call, 'Error: arguments must be a JSON object.', true, startedAt)
    }

    // Already cancelled before starting: report it instead of launching work.
    if (signal?.aborted) {
      return this.observeTool(call, 'Error: the run was cancelled before this call ran.', true, startedAt)
    }

    const ctx: ToolContext = {
      root: this.root,
      ...(signal ? { signal } : {}),
      log: (message: string) => this.emit({ type: 'log', message }),
      ...(this.approver ? { approve: this.approver } : {}),
      recordChange: (change) => this.journal.record(change),
    }

    try {
      const result = await withTimeout(
        Promise.resolve(tool.execute(parsedArgs as Record<string, unknown>, ctx)),
        tool.timeoutMs ?? this.toolTimeoutMs,
        tool.name,
      )
      return this.observeTool(call, result, false, startedAt)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return this.observeTool(call, `Error: ${reason}`, true, startedAt)
    }
  }

  private observeTool(
    call: ToolCall,
    content: string,
    isError: boolean,
    startedAt: number,
  ): { content: string; isError: boolean } {
    this.emit({
      type: 'tool_result',
      id: call.id,
      name: call.name,
      result: content,
      isError,
      durationMs: Date.now() - startedAt,
    })
    return { content, isError }
  }

  private finish(content: string, steps: number, stopReason: StopReason): RunResult {
    return { content, steps, stopReason, messages: this.history }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event)
  }

  /** Append to the history and notify the persistence hook if present. */
  private append(message: ChatMessage): void {
    this.history.push(message)
    this.persistenceOnAppend?.(message)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tool "${label}" timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
