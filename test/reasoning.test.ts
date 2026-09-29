import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Agent } from '../src/agent.ts'
import {
  estimateTokens,
  projectHistory,
  resolveContextOptions,
  serializeForSummary,
} from '../src/context.ts'
import { OpenAICompatibleLLM } from '../src/llm.ts'
import { appendMessage, createSession, flushSessions, loadSession } from '../src/session.ts'
import type { ChatMessage, Tool } from '../src/types.ts'
import { ScriptedLLM, StreamingLLM, reply, serveFakeProvider, streamText, toolCall } from './helpers.ts'

test('llm.chat captures reasoning_content into the reply', async () => {
  await serveFakeProvider(
    () => ({
      payload: {
        choices: [{ message: { role: 'assistant', content: 'Answer', reasoning_content: 'think step by step' } }],
      },
    }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      const reply = await llm.chat([{ role: 'user', content: 'q' }], [])
      assert.equal(reply.content, 'Answer')
      assert.equal(reply.reasoning, 'think step by step')
    },
  )
})

test('llm.stream emits reasoning deltas', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}',
    'data: {"choices":[{"delta":{"content":"Answer"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  await serveFakeProvider(
    () => ({ raw: sse, headers: { 'content-type': 'text/event-stream' } }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      const events: string[] = []
      for await (const event of llm.stream([{ role: 'user', content: 'q' }], [])) {
        if (event.type === 'reasoning') events.push(event.delta)
      }
      assert.deepEqual(events, ['think ', 'hard'])
    },
  )
})

test('the projection strips reasoning; the stored history keeps it', () => {
  const options = resolveContextOptions()
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'Answer', reasoning: 'secret thoughts' },
  ]
  const view = projectHistory(history, options)
  assert.equal(view[2]!.reasoning, undefined, 'the request view must not carry reasoning')
  assert.equal(history[2]!.reasoning, 'secret thoughts', 'history keeps full fidelity')
  // A message without reasoning passes through untouched.
  assert.equal(view[0], history[0])
})

test('the token estimate ignores reasoning and flattens blocks', () => {
  const plain: ChatMessage = { role: 'assistant', content: 'abcd' }
  const withReasoning: ChatMessage = { role: 'assistant', content: 'abcd', reasoning: 'x'.repeat(1000) }
  const blocked: ChatMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }, { type: 'thinking', text: 'z'.repeat(999) }],
  }
  assert.equal(estimateTokens(withReasoning), estimateTokens(plain))
  // Blocks join their text with newlines, so the estimate matches the joined form.
  assert.equal(estimateTokens(blocked), estimateTokens({ role: 'assistant', content: 'ab\ncd' }))
})

test('serializeForSummary flattens block content and skips reasoning', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'What?' }] },
    {
      role: 'assistant',
      content: [{ type: 'thinking', text: 'internal' }, { type: 'text', text: 'So.' }],
      reasoning: 'echoed reasoning',
    },
  ]
  const transcript = serializeForSummary(messages)
  assert.match(transcript, /\[User\]: What\?/)
  assert.match(transcript, /\[Assistant\]: So\./)
  assert.ok(!transcript.includes('internal'))
  assert.ok(!transcript.includes('echoed reasoning'))
})

test('the agent stores reasoning on the assistant message and never resends it', async () => {
  // ScriptedLLM keeps this loop-level; reasoning arrives via LLMResponse.
  const scripted = new ScriptedLLM([
    { content: 'Working.', reasoning: 'let me think', toolCalls: [toolCall('noop', {})] },
    reply('Done.'),
  ])
  const noop: Tool = {
    name: 'noop',
    description: 'No-op.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => 'ok',
  }
  const agent = new Agent({ llm: scripted, tools: [noop], stream: false })
  await agent.run('go')

  const assistant = agent.history.find((message) => message.role === 'assistant' && message.content === 'Working.')
  assert.equal(assistant?.reasoning, 'let me think')
  // The follow-up request carries the reasoning-free projection.
  const followUp = scripted.requests[1]!.messages
  assert.ok(followUp.every((message) => message.reasoning === undefined))
})

test('streaming reasoning accumulates into the assistant message', async () => {
  const llm = new StreamingLLM([
    [
      { type: 'reasoning', delta: 'hmm ' },
      { type: 'reasoning', delta: 'ok' },
      ...streamText('answer'),
    ],
  ])
  const events: string[] = []
  const agent = new Agent({
    llm,
    tools: [],
    onEvent: (event) => {
      if (event.type === 'reasoning') events.push(event.delta)
    },
  })
  const result = await agent.run('go')
  assert.equal(result.content, 'answer')
  assert.equal(agent.history.find((m) => m.role === 'assistant')?.reasoning, 'hmm ok')
  assert.deepEqual(events, ['hmm ', 'ok'])
})

test('session files round-trip block content and reasoning unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), '.tmp-session-'))
  try {
    const id = 'blocks-test'
    await createSession(dir, id, 'm')
    const message: ChatMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'look at this' }],
      reasoning: 'why not',
    }
    await appendMessage(dir, id, message)
    await flushSessions()
    const loaded = await loadSession(dir, id)
    assert.deepEqual(loaded?.history, [message])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
