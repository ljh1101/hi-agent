import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent, DEFAULT_SYSTEM_PROMPT } from '../src/agent.ts'
import { calculatorTool } from '../src/tools/calculator.ts'
import type { AgentEvent, Tool } from '../src/types.ts'
import { ScriptedLLM, StreamingLLM, reply, streamText, toolCall } from './helpers.ts'

const echoTool: Tool<{ text: string }> = {
  name: 'echo',
  description: 'Echo text back.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  execute({ text }) {
    return `echo: ${text}`
  },
}

test('returns the model answer when no tools are called', async () => {
  const llm = new ScriptedLLM([reply('Hello there.')])
  const agent = new Agent({ llm, tools: [] })
  const result = await agent.run('hi')

  assert.equal(result.stopReason, 'final')
  assert.equal(result.content, 'Hello there.')
  assert.equal(result.steps, 1)
  assert.equal(llm.requests.length, 1)
})

test('executes a tool call and feeds the observation back to the model', async () => {
  const llm = new ScriptedLLM([
    reply('I will compute that.', toolCall('calculator', { expression: '6 * 7' })),
    reply('The answer is 42.'),
  ])
  const agent = new Agent({ llm, tools: [calculatorTool] })
  const result = await agent.run('what is 6 * 7?')

  assert.equal(result.stopReason, 'final')
  assert.equal(result.content, 'The answer is 42.')
  assert.equal(result.steps, 2)
  assert.equal(llm.requests.length, 2)

  // The tool message must carry the observation and link back to the call.
  const toolMessage = agent.history.find((message) => message.role === 'tool')
  assert.ok(toolMessage)
  assert.equal(toolMessage.name, 'calculator')
  assert.equal(toolMessage.tool_call_id, 'call_calculator')
  assert.equal(toolMessage.content, '6 * 7 = 42')

  // ...and the model must actually see it on the following request.
  const lastRequest = llm.requests[1]!
  assert.equal(lastRequest.messages.at(-1)?.role, 'tool')
  assert.equal(lastRequest.messages.at(-1)?.content, '6 * 7 = 42')

  // The assistant turn that requested the tool is preserved as well.
  const assistantMessages = agent.history.filter((message) => message.role === 'assistant')
  assert.equal(assistantMessages.length, 2)
  assert.equal(assistantMessages[0]?.tool_calls?.[0]?.name, 'calculator')
})

test('runs several tool calls requested in one turn', async () => {
  const llm = new ScriptedLLM([
    reply(null, toolCall('echo', { text: 'a' }, 'call_a'), toolCall('echo', { text: 'b' }, 'call_b')),
    reply('Both done.'),
  ])
  const agent = new Agent({ llm, tools: [echoTool] })
  const result = await agent.run('do both')

  assert.equal(result.content, 'Both done.')
  const observations = agent.history.filter((message) => message.role === 'tool')
  assert.deepEqual(
    observations.map((message) => [message.tool_call_id, message.content]),
    [
      ['call_a', 'echo: a'],
      ['call_b', 'echo: b'],
    ],
  )
})

test('recovers from an unknown tool by reporting it as an observation', async () => {
  const llm = new ScriptedLLM([reply(null, toolCall('nope', {})), reply('Recovered.')])
  const agent = new Agent({ llm, tools: [echoTool] })
  const result = await agent.run('go')

  assert.equal(result.stopReason, 'final')
  assert.equal(result.content, 'Recovered.')
  const observation = agent.history.find((message) => message.role === 'tool')
  assert.match(observation?.content ?? '', /unknown tool "nope"/)
  assert.match(observation?.content ?? '', /echo/)
})

test('recovers from malformed tool arguments', async () => {
  const llm = new ScriptedLLM([
    reply(null, { id: 'call_1', name: 'echo', arguments: '{"text": ' }),
    reply('Fixed.'),
  ])
  const agent = new Agent({ llm, tools: [echoTool] })
  const result = await agent.run('go')

  assert.equal(result.content, 'Fixed.')
  const observation = agent.history.find((message) => message.role === 'tool')
  assert.match(observation?.content ?? '', /not valid JSON/)
})

test('turns a throwing tool into an error observation and keeps going', async () => {
  const boom: Tool<Record<string, never>> = {
    name: 'boom',
    description: 'Always fails.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute() {
      throw new Error('kaboom')
    },
  }
  const events: AgentEvent[] = []
  const llm = new ScriptedLLM([reply(null, toolCall('boom', {})), reply('That failed, but I can continue.')])
  const agent = new Agent({ llm, tools: [boom], onEvent: (event) => events.push(event) })
  const result = await agent.run('go')

  assert.equal(result.content, 'That failed, but I can continue.')
  const observation = agent.history.find((message) => message.role === 'tool')
  assert.equal(observation?.content, 'Error: kaboom')

  const toolResult = events.find((event) => event.type === 'tool_result')
  assert.ok(toolResult && toolResult.type === 'tool_result' && toolResult.isError)
})

test('stops at maxSteps when the model never stops calling tools', async () => {
  const llm = new ScriptedLLM(
    Array.from({ length: 5 }, () => reply(null, toolCall('echo', { text: 'again' }))),
  )
  const agent = new Agent({ llm, tools: [echoTool], maxSteps: 3 })
  const result = await agent.run('loop forever')

  assert.equal(result.stopReason, 'max_steps')
  assert.equal(result.steps, 3)
  assert.equal(llm.requests.length, 3)
  assert.match(result.content, /Stopped after 3 steps/)
})

test('emits progress events in order', async () => {
  const types: string[] = []
  const llm = new ScriptedLLM([reply(null, toolCall('echo', { text: 'x' })), reply('done')])
  const agent = new Agent({
    llm,
    tools: [echoTool],
    onEvent: (event) => types.push(event.type),
  })
  await agent.run('go')

  assert.deepEqual(types, [
    'step',
    'assistant',
    'tool_call',
    'tool_result',
    'step',
    'assistant',
    'final',
  ])
})

test('seeds the system prompt and tool inventory, and reset() keeps system messages', async () => {
  const llm = new ScriptedLLM([reply('ok')])
  const agent = new Agent({ llm, tools: [echoTool] })

  assert.equal(agent.history.length, 2)
  assert.equal(agent.history[0]?.content, DEFAULT_SYSTEM_PROMPT)
  assert.match(agent.history[1]?.content ?? '', /Available tools: echo/)

  await agent.run('hi')
  assert.equal(agent.history.length, 4)

  agent.reset()
  assert.equal(agent.history.length, 2)
  assert.ok(agent.history.every((message) => message.role === 'system'))
})

test('systemPrompt: null disables the prompt entirely', async () => {
  const llm = new ScriptedLLM([reply('ok')])
  const agent = new Agent({ llm, tools: [], systemPrompt: null })

  assert.equal(agent.history.length, 0)
  await agent.run('hi')
  assert.equal(agent.history[0]?.role, 'user')
})

test('rejects bad JSON object shapes and non-object arguments', async () => {
  const llm = new ScriptedLLM([
    reply(null, { id: 'call_1', name: 'echo', arguments: '[1,2]' }),
    reply('Noted.'),
  ])
  const agent = new Agent({ llm, tools: [echoTool] })
  await agent.run('go')

  const observation = agent.history.find((message) => message.role === 'tool')
  assert.match(observation?.content ?? '', /must be a JSON object/)
})

test('rejects duplicate tool names in the registry', () => {
  assert.throws(() => new Agent({ llm: new ScriptedLLM([]), tools: [echoTool, echoTool] }), /Duplicate tool name/)
})

test('setLLM swaps the model mid-session without losing history', async () => {
  const first = new ScriptedLLM([reply('first model')])
  const second = new ScriptedLLM([reply('second model')])
  const agent = new Agent({ llm: first, tools: [] })

  const one = await agent.run('hi')
  assert.equal(one.content, 'first model')

  agent.setLLM(second)
  const two = await agent.run('again')
  assert.equal(two.content, 'second model')
  assert.equal(second.requests.length, 1)

  // History was preserved across the swap (system prompt + both user turns + answers).
  assert.equal(agent.history.filter((m) => m.role === 'user').length, 2)
})

test('streams tokens and returns the accumulated content', async () => {
  const events: string[] = []
  const llm = new StreamingLLM([streamText('hello')])
  const agent = new Agent({
    llm,
    tools: [],
    stream: true,
    onEvent: (event) => {
      if (event.type === 'token') events.push(event.delta)
    },
  })

  const result = await agent.run('hi')
  assert.equal(result.content, 'hello')
  assert.equal(events.join(''), 'hello')
  assert.equal(result.stopReason, 'final')
})

test('collects streamed tool calls and feeds observations back', async () => {
  const llm = new StreamingLLM([
    [
      { type: 'done', content: '', finishReason: 'tool_calls' },
      { type: 'tool_call', call: toolCall('echo', { text: 'hi' }, 'call_1') },
    ],
    streamText('echoed'),
  ])
  const agent = new Agent({ llm, tools: [echoTool], stream: true })

  const result = await agent.run('go')
  assert.equal(result.content, 'echoed')
  const observation = agent.history.find((m) => m.role === 'tool')
  assert.equal(observation?.content, 'echo: hi')
})
