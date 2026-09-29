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
 * Native Google Gemini adapter (`generateContent` / `streamGenerateContent`),
 * implementing the same `LLM` interface as the OpenAI-compatible client
 * (roadmap 3.3). The loop never learns this wire format.
 *
 * Translation notes:
 * - system messages become `systemInstruction`;
 * - assistant `tool_calls` become `functionCall` parts, and the next `tool`
 *   messages become `functionResponse` parts in a `user` turn — consecutive
 *   ones merge into one turn;
 * - Gemini has no tool-call ids, so stable ones are synthesized;
 * - "thought" parts (Gemini thinking) map to `reasoning` and are never sent
 *   back, like with every other transport.
 */

export interface GoogleOptions {
  apiKey: string
  /** Base URL including the version segment. Defaults to `https://generativelanguage.googleapis.com/v1beta`. */
  baseURL?: string
  model: string
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

interface GeminiPart {
  text?: string
  thought?: boolean
  functionCall?: { name?: string; args?: unknown }
  functionResponse?: { name?: string; response?: unknown }
  inlineData?: { mimeType?: string; data?: string }
}

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
  usageMetadata?: GeminiUsage
  error?: { code?: number; message?: string }
}

/** Parts a message contributes to the Gemini wire, in order. */
function messageParts(message: ChatMessage): GeminiPart[] {
  if (message.role === 'tool') {
    return [
      {
        functionResponse: {
          name: message.name ?? '',
          response: { result: message.content ?? '' },
        },
      },
    ]
  }
  const parts: GeminiPart[] = []
  if (Array.isArray(message.content)) {
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'text') parts.push({ text: block.text })
      // `thought` parts are agent-local: never sent back.
      if (block.type === 'image') {
        parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } })
      }
    }
  } else {
    const text = textOfContent(message.content)
    if (text) parts.push({ text })
  }
  if (message.role === 'assistant') {
    for (const call of message.tool_calls ?? []) {
      let args: unknown = {}
      try {
        args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
      } catch {
        args = {}
      }
      parts.push({ functionCall: { name: call.name, args } })
    }
  }
  return parts
}

/** Convert our history into Gemini `contents` (+ systemInstruction). */
export function toGeminiRequest(messages: readonly ChatMessage[]): {
  systemInstruction?: { parts: GeminiPart[] }
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>
} {
  const systemParts: string[] = []
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textOfContent(message.content)
      if (text) systemParts.push(text)
      continue
    }
    const parts = messageParts(message)
    if (parts.length === 0) continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    // Consecutive functionResponses merge into one user turn.
    const previous = contents.at(-1)
    if (previous && previous.role === role && parts[0]?.functionResponse) {
      previous.parts.push(...parts)
    } else {
      contents.push({ role, parts })
    }
  }

  return {
    ...(systemParts.length > 0 ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } } : {}),
    contents,
  }
}

function parseGeminiResponse(payload: GeminiResponse): LLMResponse {
  const candidate = payload.candidates?.[0]
  let content = ''
  let reasoning = ''
  const toolCalls: ToolCall[] = []
  for (const part of candidate?.content?.parts ?? []) {
    if (typeof part.text === 'string') {
      if (part.thought === true) reasoning += part.text
      else content += part.text
    }
    if (part.functionCall?.name) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      })
    }
  }
  const usage = payload.usageMetadata
  return {
    content: content === '' ? null : content,
    ...(reasoning !== '' ? { reasoning } : {}),
    toolCalls,
    ...(usage
      ? {
          usage: {
            promptTokens: usage.promptTokenCount,
            completionTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount,
          },
        }
      : {}),
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

export class GoogleLLM implements LLM {
  readonly model: string
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly maxTokens: number | undefined
  private readonly temperature: number | undefined
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: GoogleOptions) {
    if (!options.apiKey) throw new LLMError('Missing API key')
    this.model = options.model
    this.baseURL = (options.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.maxTokens = options.maxTokens
    this.temperature = options.temperature
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[]): Record<string, unknown> {
    const { systemInstruction, contents } = toGeminiRequest(messages)
    const generationConfig: Record<string, unknown> = {}
    if (this.maxTokens !== undefined) generationConfig.maxOutputTokens = this.maxTokens
    if (this.temperature !== undefined) generationConfig.temperature = this.temperature
    return {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    }
  }

  private endpoint(stream: boolean): string {
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    return `${this.baseURL}/models/${encodeURIComponent(this.model)}:${action}`
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs)
    const payload = await this.requestJson(this.buildBody(messages, tools), signal, options.signal)
    return parseGeminiResponse(payload)
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamEvent, void> {
    const idle = startIdleTimeout(this.timeoutMs)
    const onExternalAbort = (): void => idle.controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onExternalAbort, { once: true })

    let content = ''
    let reasoning = ''
    let usage: GeminiUsage | undefined
    let finishReason: string | null = null
    let toolCallCount = 0

    try {
      const response = await this.send(
        this.buildBody(messages, tools),
        idle.signal,
        options.signal,
        true,
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
            let event: GeminiResponse
            try {
              event = JSON.parse(line.slice(5).trim()) as GeminiResponse
            } catch {
              throw new LLMError('Model returned invalid JSON in stream')
            }
            if (event.error?.message) {
              throw new LLMError(`Model returned an error: ${event.error.message}`)
            }
            const candidate = event.candidates?.[0]
            if (candidate?.finishReason) finishReason = candidate.finishReason
            if (event.usageMetadata) usage = event.usageMetadata
            for (const part of candidate?.content?.parts ?? []) {
              if (typeof part.text !== 'string') continue
              if (part.thought === true) {
                reasoning += part.text
                yield { type: 'reasoning', delta: part.text }
              } else {
                content += part.text
                yield { type: 'delta', delta: part.text }
              }
            }
            // Gemini delivers function calls as whole parts; yield immediately.
            for (const part of candidate?.content?.parts ?? []) {
              if (part.functionCall?.name) {
                toolCallCount++
                yield {
                  type: 'tool_call',
                  call: {
                    id: `call_${toolCallCount}`,
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                  },
                }
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

    yield {
      type: 'done',
      content,
      finishReason,
      ...(usage
        ? {
            usage: {
              promptTokens: usage.promptTokenCount,
              completionTokens: usage.candidatesTokenCount,
              totalTokens: usage.totalTokenCount,
            },
          }
        : {}),
    }
  }

  private async send(
    body: Record<string, unknown>,
    signal: AbortSignal,
    cancel: AbortSignal | undefined,
    stream: boolean,
  ): Promise<Response> {
    const attempts = this.maxRetries + 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.requestOnce(body, signal, cancel, stream)
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
    stream: boolean,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint(stream), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (cancel?.aborted) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new LLMError(`Request to ${this.endpoint(stream)} failed: ${reason}`)
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
    cancel: AbortSignal | undefined,
  ): Promise<GeminiResponse> {
    const response = await this.send(body, signal, cancel, false)
    const text = await response.text()
    let parsed: GeminiResponse
    try {
      parsed = JSON.parse(text) as GeminiResponse
    } catch {
      throw new LLMError(`Model returned invalid JSON: ${truncate(text, 500)}`)
    }
    if (parsed.error?.message) {
      throw new LLMError(`Model returned an error: ${parsed.error.message}`)
    }
    return parsed
  }
}
