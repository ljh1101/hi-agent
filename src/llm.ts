import type {
  ChatMessage,
  ChatOptions,
  LLM,
  LLMResponse,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from './types.ts'

export interface OpenAICompatibleOptions {
  apiKey: string
  /** Base URL including the version segment, e.g. `https://api.openai.com/v1`. */
  baseURL?: string
  model: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /**
   * Maximum retry attempts on top of the first try (so `2` means up to 3 total
   * requests). Only retryable failures (429, 5xx, network/timeout) are retried.
   * Defaults to 2, matching the OpenAI SDK.
   */
  maxRetries?: number
  /** Base of the exponential backoff, in milliseconds. Defaults to 500. */
  baseDelayMs?: number
  /** Upper bound for the backoff delay, in milliseconds. Defaults to 30000. */
  maxDelayMs?: number
  /** Injectable for tests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch
}

/** Error raised for transport failures and non-2xx responses. */
export class LLMError extends Error {
  readonly status: number | undefined
  readonly body: string | undefined
  /** Parsed from the `Retry-After` header, when the provider supplied one. */
  readonly retryAfterMs: number | undefined

  constructor(message: string, status?: number, body?: string, retryAfterMs?: number) {
    super(message)
    this.name = 'LLMError'
    this.status = status
    this.body = body
    this.retryAfterMs = retryAfterMs
  }
}

interface WireToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface WireMessage {
  role: string
  content?: string
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

interface WireChoice {
  message?: WireMessage
  finish_reason?: string
}

interface WireResponse {
  choices?: WireChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

interface WireStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/** Convert our history into the OpenAI wire format. */
function toWireMessage(message: ChatMessage): WireMessage {
  const wire: WireMessage = { role: message.role, content: message.content ?? '' }
  if (message.tool_calls?.length) {
    wire.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  if (message.tool_call_id) {
    wire.tool_call_id = message.tool_call_id
  }
  return wire
}

function toToolCall(raw: WireToolCall, index: number): ToolCall {
  const name = raw.function?.name
  if (!name) {
    throw new LLMError('Model returned a tool call without a function name')
  }
  return {
    // Some providers omit ids; synthesize a stable one so results can be linked.
    id: raw.id ?? `call_${index}`,
    name,
    arguments: raw.function?.arguments ?? '{}',
  }
}

/**
 * Parse an OpenAI-compatible Server-Sent Events stream into chunks.
 *
 * The wire format is a sequence of `data: {json}\n\n` frames, terminated by
 * `data: [DONE]`. We decode incrementally (the `TextDecoder` `stream` flag
 * keeps multi-byte characters from being split across chunks) and buffer until
 * a blank line marks the end of a frame.
 */
async function* parseSSE(response: Response): AsyncGenerator<WireStreamChunk, void> {
  if (!response.body) {
    throw new LLMError('Streaming response had no body', response.status)
  }
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trimStart()
        if (data === '[DONE]') return
        let parsed: WireStreamChunk
        try {
          parsed = JSON.parse(data) as WireStreamChunk
        } catch {
          throw new LLMError('Model returned invalid JSON in stream', response.status, data)
        }
        yield parsed
      }
    }
  }

  // Flush any trailing frame without a final blank line.
  if (buffer.trim() !== '') {
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trimStart()
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data) as WireStreamChunk
      } catch {
        // Same contract as the frames above: a malformed chunk is a provider
        // error, not a raw SyntaxError escaping as an untyped crash.
        throw new LLMError('Model returned invalid JSON in stream', response.status, data)
      }
    }
  }
}

/**
 * Client for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Uses the global `fetch` built into Node 18+. Works with OpenAI, DeepSeek,
 * Moonshot, Groq, Ollama, vLLM, LM Studio, ...
 */
export class OpenAICompatibleLLM implements LLM {
  readonly model: string
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly temperature: number | undefined
  private readonly maxTokens: number | undefined
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: OpenAICompatibleOptions) {
    if (!options.apiKey) {
      throw new LLMError('Missing API key')
    }
    this.model = options.model
    this.apiKey = options.apiKey
    this.endpoint = `${(options.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`
    this.temperature = options.temperature
    this.maxTokens = options.maxTokens
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
    const body = this.buildBody(messages, tools)
    // Non-streaming has no progress to observe until the whole answer is ready,
    // so the bound has to cover the generation itself: a total timeout, not an
    // inactivity one.
    const response = await this.fetchWithRetry(
      body,
      combineSignals(options.signal, AbortSignal.timeout(this.timeoutMs)),
      options.signal,
    )

    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw this.toLLMError(error, options.signal, false)
    }

    let parsed: WireResponse
    try {
      parsed = JSON.parse(text) as WireResponse
    } catch {
      throw new LLMError(`Model returned invalid JSON: ${truncate(text, 500)}`, response.status, text)
    }

    if (parsed.error?.message) {
      throw new LLMError(`Model returned an error: ${parsed.error.message}`, response.status, text)
    }

    const message = parsed.choices?.[0]?.message
    if (!message) {
      throw new LLMError('Model returned no choices', response.status, text)
    }

    return {
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map(toToolCall),
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.prompt_tokens,
            completionTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens,
          }
        : undefined,
    }
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamEvent, void> {
    const body = this.buildBody(messages, tools)
    body.stream = true
    // Ask the provider to report usage on the final chunk when it supports it.
    body.stream_options = { include_usage: true }

    // A stream is measured by *silence*, not by total duration: a reasoning
    // model can legitimately spend minutes producing one answer, and a total
    // timeout killed it mid-sentence while the connection was perfectly
    // healthy (measured: a provider trickling a body was cut off at the
    // configured 300ms). Every chunk therefore pushes the deadline out.
    const idle = startIdleTimeout(this.timeoutMs)
    const onExternalAbort = (): void => idle.controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onExternalAbort, { once: true })

    let content = ''
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason: string | null = null
    let usage: LLMResponse['usage']

    try {
      const response = await this.fetchWithRetry(
        body,
        idle.signal,
        options.signal,
        () => idle.keepAlive(),
      )

      for await (const chunk of parseSSE(response)) {
        idle.keepAlive()
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) {
          content += delta.content
          yield { type: 'delta', delta: delta.content }
        }
        if (delta?.tool_calls) {
          for (const raw of delta.tool_calls) {
            const index = raw.index ?? 0
            const existing = toolCalls.get(index) ?? { id: `call_${index}`, name: '', arguments: '' }
            if (raw.id) existing.id = raw.id
            if (raw.function?.name) existing.name = raw.function.name
            if (raw.function?.arguments) existing.arguments += raw.function.arguments
            toolCalls.set(index, existing)
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          }
        }
      }
    } catch (error) {
      throw this.toLLMError(error, options.signal, idle.timedOut())
    } finally {
      idle.dispose()
      options.signal?.removeEventListener('abort', onExternalAbort)
    }

    for (const call of toolCalls.values()) {
      yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: call.arguments } }
    }
    yield { type: 'done', content, finishReason, usage }
  }

  /** Build the request body shared by chat and stream. */
  private buildBody(messages: ChatMessage[], tools: ToolDefinition[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWireMessage),
    }
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
      body.tool_choice = 'auto'
    }
    if (this.temperature !== undefined) body.temperature = this.temperature
    if (this.maxTokens !== undefined) body.max_tokens = this.maxTokens
    return body
  }

  /**
   * Issue the request, retrying transient failures, and return the response.
   *
   * `cancel` is the caller's own signal, kept separate from the bound being
   * enforced: when *it* fires the run is being cancelled and the abort is passed
   * through untouched, while a timeout we imposed is wrapped as an `LLMError`
   * like any other transport failure.
   *
   * `onAttempt` runs before every try — the streaming path uses it to give each
   * attempt its own inactivity deadline, so a retry is not measured against the
   * time the previous attempt already spent.
   */
  private async fetchWithRetry(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    cancel: AbortSignal | undefined,
    onAttempt?: () => void,
  ): Promise<Response> {
    const attempts = this.maxRetries + 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      onAttempt?.()
      try {
        return await this.requestOnce(body, signal, cancel)
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt === attempts - 1) throw error
        if (cancel?.aborted || signal?.aborted) throw error
        const retryAfterMs = (error as LLMError).retryAfterMs
        const delay = retryAfterMs ?? backoffDelay(attempt, this.baseDelayMs, this.maxDelayMs)
        await delayOrAbort(delay, signal)
      }
    }
    // Unreachable, but keeps TypeScript's control-flow happy.
    throw lastError
  }

  /**
   * Give a failure the right type.
   *
   * Errors raised while reading the response body are not caught by
   * `requestOnce`, so they used to escape as bare `DOMException`s: the CLI's
   * status hints never fired and the message reached the user as
   * "The operation was aborted due to timeout". An external abort is left
   * alone — the caller is cancelling the run and checks the signal itself.
   */
  private toLLMError(error: unknown, external: AbortSignal | undefined, timedOut: boolean): unknown {
    if (external?.aborted) return error
    if (error instanceof LLMError) return error
    if (timedOut) {
      return new LLMError(`Model stalled for ${this.timeoutMs}ms with no data; giving up`)
    }
    const reason = error instanceof Error ? error.message : String(error)
    return new LLMError(`Reading the model response failed: ${reason}`)
  }

  /**
   * Issue a single HTTP request; throws on transport failure and non-2xx.
   *
   * The signal handed in is the only bound on the request, including the body:
   * callers decide whether that is a total timeout (`chat`) or an inactivity
   * deadline they push back as data arrives (`stream`).
   */
  private async requestOnce(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    cancel: AbortSignal | undefined,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      // The caller cancelled the run: the agent checks its own signal and turns
      // this into an aborted stop, so it must not be re-typed here.
      if (cancel?.aborted) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new LLMError(`Request to ${this.endpoint} failed: ${reason}`)
    }

    if (!response.ok) {
      const text = await response.text()
      throw new LLMError(
        `Model request failed with HTTP ${response.status}: ${truncate(text, 500)}`,
        response.status,
        text,
        parseRetryAfter(response.headers.get('retry-after')),
      )
    }
    return response
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

/**
 * Whether a failure is worth retrying. 429 and 5xx are transient; 4xx
 * (bad key, bad request) is the caller's mistake and will not improve on retry.
 * Transport errors without a status (network, timeout) are retryable too.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof LLMError)) return false
  if (error.status === undefined) return true
  return error.status === 429 || error.status >= 500
}

/**
 * Exponential backoff with full jitter, clamped to `maxDelay`. The random
 * source is injectable so tests can assert on deterministic bounds.
 */
export function backoffDelay(
  attempt: number,
  base: number,
  max: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(max, base * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - now)
  return undefined
}

/** Sleep for `ms`, but abort early if the external signal fires. */
function delayOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      },
      { once: true },
    )
  })
}

/**
 * An abort signal that fires after `timeoutMs` without a `keepAlive()` call.
 *
 * Used for streaming: the deadline is pushed back on every chunk, so it
 * measures silence rather than total duration. `timedOut` distinguishes "the
 * model went quiet" from "the user cancelled" when the abort surfaces as an
 * error, which is the difference between a clear message and a bare
 * `DOMException`.
 */
export interface IdleTimeout {
  signal: AbortSignal
  /** The signal the caller aborts to cancel the request (not the timer). */
  controller: AbortController
  /** Push the deadline out. Call on every sign of progress. */
  keepAlive: () => void
  /** Stop the timer; the signal stops firing. */
  dispose: () => void
  /** Whether the deadline has fired. */
  timedOut: () => boolean
}

export function startIdleTimeout(ms: number): IdleTimeout {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let fired = false

  const keepAlive = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fired = true
      controller.abort(new Error(`idle for ${ms}ms`))
    }, ms)
  }

  const idle: IdleTimeout = {
    signal: controller.signal,
    controller,
    keepAlive,
    dispose: () => {
      if (timer) clearTimeout(timer)
    },
    timedOut: () => fired,
  }
  keepAlive()
  return idle
}

/**
 * Combine an external abort signal with a timeout.
 *
 * `AbortSignal.any` is required by the engine range in `package.json` (>= 22.18,
 * where it has existed since 20.3). The previous hand-rolled fallback returned
 * just the external signal when `any` was missing, silently dropping the
 * timeout — the only bound on a hung request.
 */
function combineSignals(external: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([external, timeout]) : timeout
}
