import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnthropicLLM, toAnthropicRequest } from '../src/llm-anthropic.ts'
import { GoogleLLM, toGeminiRequest } from '../src/llm-google.ts'
import { createLLM, OpenAICompatibleLLM } from '../src/llm.ts'
import type { ChatMessage, ToolDefinition } from '../src/types.ts'
import { serveFakeProvider } from './helpers.ts'

const calcTool: ToolDefinition = {
  name: 'calc',
  description: 'Do math.',
  parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

test('Anthropic chat: system extracted, tools declared, reply parsed', async () => {
  await serveFakeProvider(
    () => ({
      payload: {
        content: [{ type: 'text', text: 'Hello there' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
    async (baseURL, captured) => {
      const llm = new AnthropicLLM({ apiKey: 'secret', baseURL, model: 'claude-x' })
      const reply = await llm.chat(
        [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'hi' },
        ],
        [calcTool],
      )

      assert.equal(reply.content, 'Hello there')
      assert.deepEqual(reply.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 })

      const body = captured[0]!.body as Record<string, unknown>
      assert.equal(captured[0]!.url, '/v1/messages')
      assert.equal(captured[0]!.headers['x-api-key'], 'secret')
      assert.equal(captured[0]!.headers['anthropic-version'], '2023-06-01')
      assert.equal(body.system, 'Be terse.')
      assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      assert.deepEqual(body.tools, [
        { name: 'calc', description: 'Do math.', input_schema: calcTool.parameters },
      ])
      assert.ok(typeof body.max_tokens === 'number')
    },
  )
})

test('Anthropic chat: tool_calls become tool_use, tool results merge into one user turn', async () => {
  await serveFakeProvider(
    () => ({
      payload: {
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'Using the tool.' },
          { type: 'tool_use', id: 'toolu_2', name: 'calc', input: { expression: '2+2' } },
        ],
      },
    }),
    async (baseURL, captured) => {
      const llm = new AnthropicLLM({ apiKey: 'secret', baseURL, model: 'claude-x' })
      const history: ChatMessage[] = [
        { role: 'user', content: 'compute' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'toolu_1', name: 'calc', arguments: '{"expression":"1+1"}' }],
        },
        { role: 'tool', content: '2', tool_call_id: 'toolu_1', name: 'calc' },
        { role: 'tool', content: 'still 2', tool_call_id: 'toolu_1', name: 'calc' },
      ]
      const reply = await llm.chat(history, [calcTool])

      // The reply: thinking -> reasoning, text -> content, tool_use -> toolCalls.
      assert.equal(reply.reasoning, 'pondering')
      assert.equal(reply.content, 'Using the tool.')
      assert.deepEqual(reply.toolCalls, [
        { id: 'toolu_2', name: 'calc', arguments: '{"expression":"2+2"}' },
      ])

      // The request: assistant tool_calls became a tool_use part with a parsed
      // input object; the two consecutive tool messages merged into ONE user
      // turn of tool_result blocks.
      const body = captured[0]!.body as { messages: Array<{ role: string; content: unknown[] }> }
      assert.equal(body.messages.length, 3)
      assert.deepEqual(body.messages[1]!.content, [
        { type: 'tool_use', id: 'toolu_1', name: 'calc', input: { expression: '1+1' } },
      ])
      assert.deepEqual(body.messages[2]!.content, [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '2' },
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'still 2' },
      ])
    },
  )
})

test('Anthropic stream: text/thinking/tool_use deltas map to normalized events', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"calc"}}',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n\n')
  await serveFakeProvider(
    () => ({ raw: sse, headers: { 'content-type': 'text/event-stream' } }),
    async (baseURL) => {
      const llm = new AnthropicLLM({ apiKey: 'secret', baseURL, model: 'claude-x' })
      const events: Array<Record<string, unknown>> = []
      for await (const event of llm.stream([{ role: 'user', content: 'q' }], [calcTool])) {
        events.push(event as Record<string, unknown>)
      }
      assert.deepEqual(events[0], { type: 'reasoning', delta: 'hmm' })
      assert.deepEqual(events[1], { type: 'delta', delta: 'Hi' })
      assert.deepEqual(events[2], {
        type: 'tool_call',
        call: { id: 'toolu_1', name: 'calc', arguments: '{"x":1}' },
      })
      const done = events.at(-1) as { type: string; content: string; usage: Record<string, number>; finishReason: string }
      assert.equal(done.type, 'done')
      assert.equal(done.content, 'Hi')
      assert.equal(done.finishReason, 'tool_use')
      assert.deepEqual(done.usage, { promptTokens: 9, completionTokens: 4, totalTokens: 13 })
    },
  )
})

test('toAnthropicRequest skips reasoning and block thinking, keeps image blocks', () => {
  const { system, messages } = toAnthropicRequest([
    { role: 'system', content: 's1' },
    { role: 'assistant', content: 'earlier', reasoning: 'not sent' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ],
    },
  ])
  assert.equal(system, 's1')
  assert.equal(messages.length, 2)
  assert.equal(messages[0]!.content[0]!.text, 'earlier')
  assert.deepEqual(messages[1]!.content, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ])
})

// ---------------------------------------------------------------------------
// Google adapter
// ---------------------------------------------------------------------------

test('Google chat: systemInstruction, key header, usage normalization', async () => {
  await serveFakeProvider(
    () => ({
      payload: {
        candidates: [{ content: { parts: [{ text: 'G day' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      },
    }),
    async (baseURL, captured) => {
      const llm = new GoogleLLM({ apiKey: 'g-key', baseURL, model: 'gemini-x' })
      const reply = await llm.chat(
        [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hi' },
        ],
        [calcTool],
      )

      assert.equal(reply.content, 'G day')
      assert.deepEqual(reply.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 })

      assert.match(captured[0]!.url, /\/models\/gemini-x:generateContent$/)
      assert.equal(captured[0]!.headers['x-goog-api-key'], 'g-key')
      const body = captured[0]!.body as Record<string, unknown>
      assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }] })
      assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }])
      assert.deepEqual(body.tools, [
        { functionDeclarations: [{ name: 'calc', description: 'Do math.', parameters: calcTool.parameters }] },
      ])
    },
  )
})

test('Google chat: functionCall/functionResponse round trip, thought parts are reasoning', async () => {
  await serveFakeProvider(
    () => ({
      payload: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'unspoken', thought: true },
                { text: 'Calling.' },
                { functionCall: { name: 'calc', args: { expression: '2+2' } } },
              ],
            },
          },
        ],
      },
    }),
    async (baseURL, captured) => {
      const llm = new GoogleLLM({ apiKey: 'g-key', baseURL, model: 'gemini-x' })
      const history: ChatMessage[] = [
        { role: 'user', content: 'compute' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', name: 'calc', arguments: '{"expression":"1+1"}' }],
        },
        { role: 'tool', content: '2', tool_call_id: 'c1', name: 'calc' },
        { role: 'tool', content: 'still 2', tool_call_id: 'c1', name: 'calc' },
      ]
      const reply = await llm.chat(history, [calcTool])

      assert.equal(reply.reasoning, 'unspoken')
      assert.equal(reply.content, 'Calling.')
      assert.deepEqual(reply.toolCalls, [
        { id: 'call_0', name: 'calc', arguments: '{"expression":"2+2"}' },
      ])

      const body = captured[0]!.body as { contents: Array<{ role: string; parts: unknown[] }> }
      assert.equal(body.contents.length, 3)
      assert.deepEqual(body.contents[1]!.parts, [{ functionCall: { name: 'calc', args: { expression: '1+1' } } }])
      assert.deepEqual(body.contents[2]!.parts, [
        { functionResponse: { name: 'calc', response: { result: '2' } } },
        { functionResponse: { name: 'calc', response: { result: 'still 2' } } },
      ])
    },
  )
})

test('Google stream: text/thought/functionCall parts map to normalized events', async () => {
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"secret","thought":true},{"text":"Go"}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"calc","args":{"expression":"1+1"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}',
    '',
  ].join('\n\n')
  await serveFakeProvider(
    () => ({ raw: sse, headers: { 'content-type': 'text/event-stream' } }),
    async (baseURL) => {
      const llm = new GoogleLLM({ apiKey: 'g-key', baseURL, model: 'gemini-x' })
      const events: Array<Record<string, unknown>> = []
      for await (const event of llm.stream([{ role: 'user', content: 'q' }], [calcTool])) {
        events.push(event as Record<string, unknown>)
      }
      assert.deepEqual(events[0], { type: 'reasoning', delta: 'secret' })
      assert.deepEqual(events[1], { type: 'delta', delta: 'Go' })
      assert.deepEqual(events[2], {
        type: 'tool_call',
        call: { id: 'call_1', name: 'calc', arguments: '{"expression":"1+1"}' },
      })
      const done = events.at(-1) as { type: string; content: string; usage: Record<string, number>; finishReason: string }
      assert.equal(done.type, 'done')
      assert.equal(done.content, 'Go')
      assert.equal(done.finishReason, 'STOP')
      assert.deepEqual(done.usage, { promptTokens: 5, completionTokens: 2, totalTokens: 7 })
    },
  )
})

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

test('createLLM selects the protocol adapter', () => {
  const base = { apiKey: 'k', model: 'm' } as const
  assert.ok(createLLM({ ...base }) instanceof OpenAICompatibleLLM)
  assert.ok(createLLM({ ...base, protocol: 'anthropic' }) instanceof AnthropicLLM)
  assert.ok(createLLM({ ...base, protocol: 'google' }) instanceof GoogleLLM)
})
