import type {
  AgentEvent,
  ChatMessage,
  LLM,
  RunResult,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
} from './types.ts'
import { ToolRegistry } from './tools/registry.ts'

export const DEFAULT_SYSTEM_PROMPT = [
  'You are hi-agent, a general-purpose assistant that solves tasks by calling tools.',
  '',
  'Rules:',
  '- Think step by step, but keep your visible replies short.',
  '- Call a tool whenever it would give you a fact you are unsure about; never guess.',
  '- You may call several tools in one turn when they are independent.',
  '- After the tools have given you enough information, reply with the final answer as plain text.',
  '- If a tool returns an error, read it carefully and try a different approach.',
].join('\n')

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

  private readonly llm: LLM
  private readonly registry: ToolRegistry
  private readonly maxSteps: number
  private readonly root: string
  private readonly toolTimeoutMs: number
  private readonly onEvent: ((event: AgentEvent) => void) | undefined
  private readonly signal: AbortSignal | undefined

  constructor(options: AgentOptions) {
    this.llm = options.llm
    this.registry = new ToolRegistry(options.tools ?? [])
    this.maxSteps = Math.max(1, options.maxSteps ?? 12)
    this.root = options.root ?? process.cwd()
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000
    this.onEvent = options.onEvent
    this.signal = options.signal

    const systemPrompt =
      options.systemPrompt === undefined ? DEFAULT_SYSTEM_PROMPT : options.systemPrompt
    if (systemPrompt) {
      this.history.push({ role: 'system', content: systemPrompt })
    }
    if (this.registry.names().length > 0) {
      // Nudge the model with an explicit inventory of what it can call.
      this.history.push({
        role: 'system',
        content: `Available tools: ${this.registry.names().join(', ')}.`,
      })
    }
  }

  /** Clear the conversation, keeping the system prompt(s). */
  reset(): void {
    const systemMessages = this.history.filter((message) => message.role === 'system')
    this.history.length = 0
    this.history.push(...systemMessages)
  }

  /**
   * Run one turn: give the agent an input and let it work until it answers.
   * Never throws for model/tool failures that the model can recover from.
   */
  async run(input: string): Promise<RunResult> {
    this.history.push({ role: 'user', content: input })
    const definitions = this.registry.definitions()

    let lastContent = ''
    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.signal?.aborted) {
        return this.finish(lastContent, step - 1, 'aborted')
      }
      this.emit({ type: 'step', step })

      const reply = await this.llm.chat(this.history, definitions, { signal: this.signal })
      lastContent = reply.content ?? ''
      this.emit({ type: 'assistant', content: lastContent, toolCalls: reply.toolCalls })

      this.history.push({
        role: 'assistant',
        content: lastContent,
        ...(reply.toolCalls.length > 0 ? { tool_calls: reply.toolCalls } : {}),
      })

      if (reply.toolCalls.length === 0) {
        const content = lastContent.trim()
        this.emit({ type: 'final', content })
        return this.finish(content, step, 'final')
      }

      // Run the requested tools. Independent calls could be parallelized here,
      // but sequential execution keeps ordering deterministic for the model.
      for (const call of reply.toolCalls) {
        const observation = await this.executeTool(call)
        this.history.push({
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
   * Execute one tool call and turn every outcome — including bad JSON, unknown
   * tools, throws and timeouts — into an observation string.
   */
  private async executeTool(call: ToolCall): Promise<{ content: string; isError: boolean }> {
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

    const ctx: ToolContext = {
      root: this.root,
      ...(this.signal ? { signal: this.signal } : {}),
      log: (message: string) => this.emit({ type: 'log', message }),
    }

    try {
      const result = await withTimeout(
        Promise.resolve(tool.execute(parsedArgs as Record<string, unknown>, ctx)),
        this.toolTimeoutMs,
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
