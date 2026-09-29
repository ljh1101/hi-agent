import type {
  ChatMessage,
  ChatOptions,
  ContentBlock,
  LLM,
  LLMResponse,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from './types.ts'
import { textOfContent } from './context.ts'
import { LLMError, backoffDelay, isRetryable, parseRetryAfter, startIdleTimeout } from './llm.ts'

/**
 * Native Anthropic Messages API adapter (`/v1/messages`), implementing the
 * same `LLM` interface as the OpenAI-compatible client (roadmap 3.3). The
 * loop never learns this wire format; the adapter translates at the boundary.
 *
 * Translation notes:
 * - system messages become the top-level `system` parameter;
 * - a run of `tool` messages becomes ONE user turn of `tool_result` blocks
 *   (Anthropic rejects them any other way);
 * - assistant `tool_calls` become `tool_use` content blocks, and the parsed
 *   `input` object is re-serialized — arguments on our side are always the
 *   JSON string form;
 * - `thinking` response blocks map to `reasoning`, text blocks to `content`;
 *   reasoning is never sent back, like with every other transport.
 */

export interface AnthropicOptions {
  apiKey: string
  /** Base URL including the version segment. Defaults to `https://api.anthropic.com/v1`. */
  baseURL?: string
  model: string
  /** Anthropic requires `max_tokens` on every request. Defaults to 4096. */
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  /** Maximum retry attempts on top of the first try. Defaults to 2. */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Injectable for tests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch
}

const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentPart {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
}

interface AnthropicResponse {
  content?: AnthropicContentPart[]
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

interface AnthropicStreamEvent {
  type?: string
  index?: number
  message?: { usage?: AnthropicUsage }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

/** Blocks a message contributes to the Anthropic wire, in order. */
function messageParts(message: ChatMessage): AnthropicContentPart[] {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: textOfContent(message.content),
      },
    ]
  }
  const parts: AnthropicContentPart[] = []
  if (Array.isArray(message.content)) {
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text })
      // Thinking blocks are agent-local: never sent back (same rule as the
      // `reasoning` field).
      if (block.type === 'image') {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: block.mimeType, data: block.data },
        })
      }
    }
  } else {
    const text = textOfContent(message.content)
    if (text) parts.push({ type: 'text', text })
  }
  if (message.role === 'assistant') {
    for (const call of message.tool_calls ?? []) {
      let input: unknown = {}
      try {
        input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
      } catch {
        input = {}
      }
      parts.push({ type: 'tool_use', id: call.id, name: call.name, input })
    }
  }
  return parts
}

/** Convert our history into Anthropic Messages format. */
export function toAnthropicRequest(messages: readonly ChatMessage[]): {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentPart[] }>
} {
  const systemParts: string[] = []
  const converted: Array<{ role: 'user' | 'assistant'; content: AnthropicContentPart[] }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textOfContent(message.content)
      if (text) systemParts.push(text)
      continue
    }
    const parts = messageParts(message)
    if (parts.length === 0) continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    // Consecutive tool results merge into one user turn of tool_result blocks.
    const previous = converted.at(-1)
    if (previous && previous.role === role && parts[0]?.type === 'tool_result') {
      previous.content.push(...parts)
    } else {
      converted.push({ role, content: parts })
    }
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: converted,
  }
}

function fromToolCall(part: AnthropicContentPart, index: number): ToolCall {
  return {
    id: typeof part.id === 'string' && part.id !== '' ? part.id : `call_${index}`,
    name: part.name ?? '',
    arguments: JSON.stringify(part.input ?? {}),
  }
}

function parseAnthropicResponse(payload: AnthropicResponse): LLMResponse {
  let content = ''
  let reasoning = ''
  const toolCalls: ToolCall[] = []
  for (const [index, part] of (payload.content ?? []).entries()) {
    if (part.type === 'text' && part.text) content += part.text
    if (part.type === 'thinking' && part.thinking) reasoning += part.thinking
    if (part.type === 'tool_use') toolCalls.push(fromToolCall(part, index))
  }
  const usage = payload.usage
  return {
    content: content === '' ? null : content,
    ...(reasoning !== '' ? { reasoning } : {}),
    toolCalls,
    ...(usage && ((usage.input_tokens ?? 0) > 0 || (usage.output_tokens ?? 0) > 0)
      ? {
          usage: {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          },
        }
      : {}),
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

export class AnthropicLLM implements LLM {
  readonly model: string
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly maxTokens: number
  private readonly temperature: number | undefined
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: AnthropicOptions) {
    if (!options.apiKey) throw new LLMError('Missing API key')
    this.model = options.model
    this.apiKey = options.apiKey
    this.endpoint = `${(options.baseURL ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '')}/messages`
    this.maxTokens = options.maxTokens ?? 4096
    this.temperature = options.temperature
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  private buildBody(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    stream: boolean,
  ): Record<string, unknown> {
    const { system, messages: converted } = toAnthropicRequest(messages)
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: converted,
      ...(system !== undefined ? { system } : {}),
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(stream ? { stream: true } : {}),
    }
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs)
    const payload = await this.requestJson(this.buildBody(messages, tools, false), signal)
    return parseAnthropicResponse(payload)
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamEvent, void> {
    // The deadline is pushed back on every SSE event (the same policy as the
    // OpenAI client): a hung connection is bounded, long thinking is not cut.
    const idle = startIdleTimeout(this.timeoutMs)
    const onExternalAbort = (): void => idle.controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onExternalAbort, { once: true })

    let content = ''
    let reasoning = ''
    let promptTokens: number | undefined
    let completionTokens: number | undefined
    let finishReason: string | null = null
    /** Tool calls under construction, keyed by content-block index. */
    const toolSlots = new Map<number, { id: string; name: string; arguments: string }>()

    try {
      const response = await this.send(
        this.buildBody(messages, tools, true),
        idle.signal,
        options.signal,
      )
      if (!response.body) throw new LLMError('Streaming response had no body')

      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body) {
        idle.keepAlive()
        buffer += decoder.decode(chunk, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            let event: AnthropicStreamEvent
            try {
              event = JSON.parse(line.slice(5).trim()) as AnthropicStreamEvent
            } catch {
              throw new LLMError('Model returned invalid JSON in stream')
            }

            if (event.type === 'error') {
              throw new LLMError(
                `Model returned an error: ${event.error?.message ?? 'unknown stream error'}`,
              )
            }
            if (event.type === 'message_start') {
              promptTokens = event.message?.usage?.input_tokens
            } else if (event.type === 'message_delta') {
              completionTokens = event.usage?.output_tokens
              if (event.delta?.stop_reason) finishReason = event.delta.stop_reason
            } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              const index = event.index ?? 0
              toolSlots.set(index, {
                id: event.content_block.id ?? `call_${index}`,
                name: event.content_block.name ?? '',
                arguments: '',
              })
            } else if (event.type === 'content_block_delta') {
              const delta = event.delta
              if (delta?.type === 'text_delta' && delta.text) {
                content += delta.text
                yield { type: 'delta', delta: delta.text }
              } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                reasoning += delta.thinking
                yield { type: 'reasoning', delta: delta.thinking }
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                const slot = toolSlots.get(event.index ?? 0)
                if (slot) slot.arguments += delta.partial_json
              }
            }
          }
        }
      }
    } catch (error) {
      if (!options.signal?.aborted && !(error instanceof LLMError)) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new LLMError(`Reading the model response failed: ${reason}`)
      }
      throw error
    } finally {
      idle.dispose()
      options.signal?.removeEventListener('abort', onExternalAbort)
    }

    for (const call of toolSlots.values()) {
      yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: call.arguments } }
    }
    yield {
      type: 'done',
      content,
      finishReason,
      ...(promptTokens !== undefined || completionTokens !== undefined
        ? {
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
            },
          }
        : {}),
    }
  }

  private async send(
    body: Record<string, unknown>,
    signal: AbortSignal,
    cancel: AbortSignal | undefined,
  ): Promise<Response> {
    const attempts = this.maxRetries + 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.requestOnce(body, signal, cancel)
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt === attempts - 1) throw error
        if (cancel?.aborted || signal.aborted) throw error
        const retryAfterMs = (error as LLMError).retryAfterMs
        const delay = retryAfterMs ?? backoffDelay(attempt, this.baseDelayMs, this.maxDelayMs)
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }
    throw lastError
  }

  private async requestOnce(
    body: Record<string, unknown>,
    signal: AbortSignal,
    cancel: AbortSignal | undefined,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
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

  private async requestJson(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AnthropicResponse> {
    const response = await this.send(body, signal, undefined)
    const text = await response.text()
    let parsed: AnthropicResponse
    try {
      parsed = JSON.parse(text) as AnthropicResponse
    } catch {
      throw new LLMError(`Model returned invalid JSON: ${truncate(text, 500)}`)
    }
    if (parsed.error?.message) {
      throw new LLMError(`Model returned an error: ${parsed.error.message}`)
    }
    return parsed
  }
}
