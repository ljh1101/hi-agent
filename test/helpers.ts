import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { ChatMessage, LLM, LLMResponse, ToolCall, ToolDefinition } from '../src/types.ts'

export interface RecordedRequest {
  messages: ChatMessage[]
  tools: ToolDefinition[]
}

/**
 * A deterministic `LLM` for tests: replays a fixed script of replies and
 * records every request so tests can assert what the agent sent.
 */
export class ScriptedLLM implements LLM {
  readonly model = 'scripted'
  readonly requests: RecordedRequest[] = []
  private readonly replies: LLMResponse[]

  constructor(replies: LLMResponse[]) {
    this.replies = [...replies]
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMResponse> {
    this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) })
    const reply = this.replies.shift()
    if (!reply) throw new Error('ScriptedLLM ran out of scripted replies')
    return reply
  }
}

/** Build a tool call, serializing object arguments to JSON. */
export function toolCall(name: string, args: unknown, id = `call_${name}`): ToolCall {
  return {
    id,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  }
}

/** Build a model reply. */
export function reply(content: string | null, ...calls: ToolCall[]): LLMResponse {
  return { content, toolCalls: calls }
}

export interface CapturedRequest {
  url: string
  method: string
  headers: IncomingHttpHeaders
  /** The parsed JSON request body, exactly as sent over the wire. */
  body: Record<string, unknown>
}

export interface FakeProviderResponse {
  status?: number
  payload?: unknown
  raw?: string
  delayMs?: number
}

/**
 * Boot a throwaway HTTP server that impersonates an OpenAI-compatible endpoint,
 * so the wire format can be verified without network access or an API key.
 */
export async function serveFakeProvider(
  responder: (body: Record<string, unknown>, requestIndex: number) => FakeProviderResponse,
  run: (baseURL: string, captured: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const index = captured.length
      captured.push({
        url: request.url ?? '',
        method: request.method ?? '',
        headers: request.headers,
        body,
      })
      const fake = responder(body, index)
      const send = (): void => {
        response.writeHead(fake.status ?? 200, { 'content-type': 'application/json' })
        response.end(fake.raw ?? JSON.stringify(fake.payload ?? {}))
      }
      if (fake.delayMs) setTimeout(send, fake.delayMs)
      else send()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, captured)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

/** Shorthand for a chat-completions reply body. */
export function completion(
  message: { content?: string | null; tool_calls?: unknown[] },
  usage?: Record<string, number>,
): Record<string, unknown> {
  return { choices: [{ message: { role: 'assistant', ...message } }], usage }
}
