import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent } from '../src/agent.ts'
import { createTaskTool } from '../src/tools/task.ts'
import type { LLM, LLMResponse, Tool } from '../src/types.ts'
import { ScriptedLLM, reply, toolCall } from './helpers.ts'
import { textOfContent } from '../src/context.ts'


const riskyTool: Tool<Record<string, never>> = {
  name: 'risky',
  description: 'Asks for approval.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const ok = await ctx.approve?.('do the risky thing')
    if (!ok) throw new Error('denied')
    return 'ran'
  },
}

test('the sub-agent final answer becomes the task observation', async () => {
  const llm = new ScriptedLLM([
    // Parent step 1: delegate.
    reply(null, toolCall('task', { prompt: 'scan the tree' }, 'call_parent')),
    // The sub-agent's single step.
    reply('the sub answer'),
    // Parent step 2: done.
    reply('done'),
  ])
  const agent = new Agent({ llm, tools: [createTaskTool({ getLLM: () => llm })], stream: false })
  const result = await agent.run('research it')

  assert.equal(result.content, 'done')
  const observation = agent.history.find((m) => m.role === 'tool')
  assert.equal(observation?.content, 'the sub answer')
  // Three model round-trips total: parent, sub, parent.
  assert.equal(llm.requests.length, 3)
})

test('the default sub-agent tool set has no writers and no shell', async () => {
  const llm = new ScriptedLLM([
    reply(null, toolCall('task', { prompt: 'write a file' }, 'c1')),
    reply(null, toolCall('write_file', { path: 'x.txt', content: 'nope' }, 'c2')),
    reply('I could not write: unknown tool "write_file"'),
    reply('done'),
  ])
  const agent = new Agent({ llm, tools: [createTaskTool({ getLLM: () => llm })], stream: false })
  await agent.run('try to write')

  // The write_file call was rejected inside the sub-agent (its own history),
  // and the sub-agent reported that failure in its final answer.
  const observation = agent.history.find((m) => m.role === 'tool')
  assert.match(textOfContent(observation?.content), /unknown tool "write_file"/)
})

test('approvals propagate from the sub-agent to the parent approver', async () => {
  const llm = new ScriptedLLM([
    reply(null, toolCall('task', { prompt: 'do the risky thing' }, 'c1')),
    reply(null, toolCall('risky', {})),
    reply('the sub saw it approved'),
    reply('done'),
  ])
  const asked: string[] = []
  const agent = new Agent({
    llm,
    tools: [createTaskTool({ getLLM: () => llm, tools: [riskyTool] })],
    approver: async (request) => {
      asked.push(request)
      return true
    },
    stream: false,
  })
  await agent.run('go')

  assert.deepEqual(asked, ['do the risky thing'])
  const observation = agent.history.find((m) => m.role === 'tool')
  assert.equal(observation?.content, 'the sub saw it approved')
})

test('a sub-agent that hits maxSteps reports the stop reason as the observation', async () => {
  const llm = new ScriptedLLM([
    reply(null, toolCall('task', { prompt: 'loop forever' }, 'c1')),
    // The sub-agent burns its single step on a tool call and never answers.
    reply(null, toolCall('grep', { pattern: 'x' })),
    reply('done'),
  ])
  const agent = new Agent({
    llm,
    tools: [createTaskTool({ getLLM: () => llm, maxSteps: 1 })],
    stream: false,
  })
  await agent.run('go')

  const observation = agent.history.find((m) => m.role === 'tool')
  assert.match(textOfContent(observation?.content), /Stopped after 1 steps without a final answer/)
})

test('a mid-run cancellation reaches the sub-agent and becomes an error observation', async () => {
  const controller = new AbortController()
  const abortingLLM: LLM = {
    model: 'aborting-sub',
    async chat(): Promise<LLMResponse> {
      controller.abort(new Error('interrupted'))
      return reply('never used')
    },
  }
  // The parent uses a scripted LLM; the sub-agent gets the aborting one.
  const parentLLM = new ScriptedLLM([
    reply(null, toolCall('task', { prompt: 'go' }, 'c1')),
    reply('done'),
  ])
  const agent = new Agent({
    llm: parentLLM,
    tools: [createTaskTool({ getLLM: () => abortingLLM })],
    signal: controller.signal,
    stream: false,
  })

  const result = await agent.run('go')
  assert.equal(result.stopReason, 'aborted')
  const observation = agent.history.find((m) => m.role === 'tool')
  assert.equal(observation?.content, 'Error: the task was cancelled')
})

test('the task tool owns a long timeout, not the 30s default', () => {
  const llm = new ScriptedLLM([])
  assert.equal(createTaskTool({ getLLM: () => llm }).timeoutMs, 600_000)
})
