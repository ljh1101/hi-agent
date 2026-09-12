import type {
  ChatMessage,
  ChatOptions,
  LLM,
  LLMResponse,
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
  /** Injectable for tests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch
}

/** Error raised for transport failures and non-2xx responses. */
export class LLMError extends Error {
  readonly status: number | undefined
  readonly body: string | undefined

  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'LLMError'
    this.status = status
    this.body = body
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
 * Client for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Zero runtime dependencies: it uses the global `fetch` built into Node 18+.
 * Works with OpenAI, DeepSeek, Moonshot, Groq, Ollama, vLLM, LM Studio, ...
 */
export class OpenAICompatibleLLM implements LLM {
  readonly model: string
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly temperature: number | undefined
  private readonly maxTokens: number | undefined
  private readonly timeoutMs: number
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
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
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

    const signal = combineSignals(options.signal, AbortSignal.timeout(this.timeoutMs))

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
      if (options.signal?.aborted) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new LLMError(`Request to ${this.endpoint} failed: ${reason}`)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new LLMError(
        `Model request failed with HTTP ${response.status}: ${truncate(text, 500)}`,
        response.status,
        text,
      )
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
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

/** Combine an external abort signal with a timeout, without leaking listeners. */
function combineSignals(
  external: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  if (!external) return timeout
  const anySignal = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  return typeof anySignal === 'function' ? anySignal([external, timeout]) : external
}
