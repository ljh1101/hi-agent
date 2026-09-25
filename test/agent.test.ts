import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Agent, DEFAULT_SYSTEM_PROMPT } from '../src/agent.ts'
import { calculatorTool } from '../src/tools/calculator.ts'
import type { AgentEvent, ChatMessage, ChatOptions, LLM, LLMResponse, StreamEvent, Tool, ToolDefinition } from '../src/types.ts'
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
    'context_usage',
    'assistant',
    'tool_call',
    'tool_result',
    'step',
    'context_usage',
    'assistant',
    'final',
  ])
})

test('seeds an assembled system prompt (identity, tools section, rules)', async () => {
  const llm = new ScriptedLLM([reply('ok')])
  const agent = new Agent({ llm, tools: [echoTool] })

  // One system message now: identity + tools section + rules.
  assert.equal(agent.history.length, 1)
  const prompt = agent.history[0]!.content ?? ''
  assert.match(prompt, /You are hi-agent/)
  assert.match(prompt, /# Tools/)
  assert.match(prompt, /- echo\b/)
  assert.match(prompt, /# Rules/)

  await agent.run('hi')
  assert.equal(agent.history.length, 3)

  agent.reset()
  assert.equal(agent.history.length, 1)
  assert.equal(agent.history[0]!.role, 'system')
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

test('a stream aborted mid-reply stops with reason "aborted", not "final"', async () => {
  const controller = new AbortController()

  // A streaming LLM that aborts the run right after the first delta.
  const abortingLLM: LLM = {
    model: 'aborting',
    async chat(): Promise<LLMResponse> {
      throw new Error('unused')
    },
    async *stream(): AsyncGenerator<StreamEvent, void> {
      yield { type: 'delta', delta: 'hel' }
      controller.abort()
      yield { type: 'delta', delta: 'lo' }
      yield { type: 'done', content: 'hello', finishReason: 'stop' }
    },
  }

  const agent = new Agent({ llm: abortingLLM, tools: [], stream: true, signal: controller.signal })
  const result = await agent.run('hi')
  assert.equal(result.stopReason, 'aborted')
})

test('passes the approver into a tool via ToolContext', async () => {
  const approving = async () => true
  let received: ((request: string) => Promise<boolean>) | undefined

  const captureTool: Tool<Record<string, never>> = {
    name: 'capture',
    description: 'Captures the approve hook.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, ctx) {
      received = ctx.approve
      return 'captured'
    },
  }

  const llm = new ScriptedLLM([reply(null, toolCall('capture', {})), reply('done')])
  const agent = new Agent({ llm, tools: [captureTool], approver: approving })
  await agent.run('go')

  assert.equal(received, approving)
})

test('a denied risky action becomes an observation, not a crash', async () => {
  const riskyTool: Tool<Record<string, never>> = {
    name: 'risky',
    description: 'Asks for approval.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'dangerous',
    async execute(_args, ctx) {
      const ok = await ctx.approve?.('do the risky thing')
      if (!ok) throw new Error('denied')
      return 'ran'
    },
  }

  const llm = new ScriptedLLM([reply(null, toolCall('risky', {})), reply('understood')])
  const agent = new Agent({ llm, tools: [riskyTool], approver: async () => false })
  const result = await agent.run('go')

  assert.equal(result.content, 'understood')
  const observation = agent.history.find((m) => m.role === 'tool')
  assert.equal(observation?.content, 'Error: denied')
})

test('the model sees pruned tool results while history keeps full fidelity', async () => {
  const bigOutput = 'y'.repeat(5000)
  const budgets = { pruneThresholdChars: 100, pruneHeadChars: 10, pruneTailChars: 10, protectedTurns: 1 }

  const llm = new ScriptedLLM([
    reply(null, toolCall('echo', { text: bigOutput })), // turn 1: big tool result
    reply('ok'),
    reply('second answer'), // turn 2: no tools
  ])
  const agent = new Agent({ llm, tools: [echoTool], contextOptions: budgets })

  await agent.run('go') // turn 1 (tool call + result)
  await agent.run('again') // turn 2 — turn 1's tool result is now old

  // The turn-2 request shows the turn-1 tool result pruned...
  const turnTwoRequest = llm.requests[llm.requests.length - 1]!
  const toolInView = turnTwoRequest.messages.find((m) => m.role === 'tool')
  assert.match(toolInView?.content ?? '', /characters pruned/)
  assert.ok((toolInView?.content ?? '').length < 100)

  // ...while the stored history keeps everything.
  assert.match(agent.history.find((m) => m.role === 'tool')?.content ?? '', /echo: /)
})

test('emits context_usage grounded in reported usage once available', async () => {
  const llm = new ScriptedLLM([
    { ...reply('first'), usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } },
    reply('second'),
  ])
  const seen: number[] = []
  const agent = new Agent({
    llm,
    tools: [],
    onEvent: (event) => {
      if (event.type === 'context_usage') seen.push(event.tokens)
    },
  })

  await agent.run('go') // step 1: no usage yet (estimated)
  await agent.run('again') // step 2: anchored on step 1's usage

  // Step 2's estimate = 1000 (reported) + tail estimate of the 2nd user msg.
  assert.equal(seen.length, 2)
  assert.ok(seen[0]! > 0, 'first estimate is chars/4 based')
  assert.ok(seen[1]! >= 1000, 'second estimate is anchored on reported usage')
  // After the final reply is appended, the running estimate only grows.
  assert.ok(agent.estimateContextTokens() >= seen[1]!)
})

// ---------------------------------------------------------------------------
// Compaction (stage 3)
// ---------------------------------------------------------------------------

test('compact replaces old history with an LLM summary, keeping recent turns', async () => {
  const summary = '## Goal\nfinish the thing'
  const oldWork = 'x'.repeat(4000) // ~1000 tokens so the cut actually separates
  // Script: turn 1 (tool loop), then the summarization call, then turn 2.
  const llm = new ScriptedLLM([
    reply(null, toolCall('echo', { text: oldWork })),
    reply('first done'),
    // The compaction call: no tools offered, returns the summary.
    reply(summary),
    reply('second done'),
  ])
  const agent = new Agent({
    llm,
    tools: [echoTool],
    maxSteps: 4,
    // Keep budget smaller than the tool result, so the cut separates old/recent.
    compaction: { contextWindow: 100_000, keepRecentTokens: 100 },
  })

  await agent.run('go') // turn 1 with a tool call
  const historyBefore = agent.history.length

  const ok = await agent.compact()
  assert.equal(ok, true)
  assert.ok(agent.history.length < historyBefore, 'history shrank')

  // System prompt + summary + recent tail survive.
  const roles = agent.history.map((m) => m.role)
  assert.equal(roles[0], 'system')
  const summaryMessage = agent.history.find((m) => m.role === 'system' && /Summary of the earlier conversation/.test(m.content ?? ''))
  assert.ok(summaryMessage, 'summary message present')
  assert.match(summaryMessage!.content ?? '', /finish the thing/)
  // The summary sits before any kept conversation message.
  const firstNonSystem = agent.history.findIndex((m) => m.role !== 'system')
  assert.ok(agent.history.indexOf(summaryMessage!) < firstNonSystem)
  // The compacted tool result is gone from history (it lives in the summary).
  assert.ok(!agent.history.some((m) => m.role === 'tool'))

  // The summarization request itself carried no tools.
  const summaryRequest = llm.requests[2]!
  assert.equal(summaryRequest.tools.length, 0)
})

test('repeated compaction replaces the summary instead of stacking it', async () => {
  // Before this, every compaction kept all previous summaries as system
  // messages: measured, three compactions left four system messages, so the
  // model saw several stale "Next Steps" at once and the system prefix grew
  // without bound (it can never be compacted away, being a system message).
  const oldWork = 'x'.repeat(4000)
  const llm = new ScriptedLLM([
    reply(null, toolCall('echo', { text: oldWork })),
    reply('first done'),
    reply('SUMMARY-ROUND-1'),
    reply(null, toolCall('echo', { text: oldWork })),
    reply('second done'),
    reply('SUMMARY-ROUND-2'),
    reply(null, toolCall('echo', { text: oldWork })),
    reply('third done'),
    reply('SUMMARY-ROUND-3'),
  ])
  const agent = new Agent({
    llm,
    tools: [echoTool],
    maxSteps: 4,
    compaction: { contextWindow: 100_000, keepRecentTokens: 100 },
  })

  for (let round = 1; round <= 3; round++) {
    await agent.run(`turn ${round}`)
    assert.equal(await agent.compact(), true)
    const summaries = agent.history.filter((m) => m.summary === true)
    assert.equal(summaries.length, 1, `round ${round}: exactly one summary`)
    assert.match(summaries[0]!.content ?? '', new RegExp(`SUMMARY-ROUND-${round}`))
    // The real system prompt survives every round and stays first.
    assert.equal(agent.history[0]!.role, 'system')
    assert.equal(agent.history[0]!.summary, undefined)
  }

  // Each summarization call carries the previous summary (it is offered as a
  // system message), so replacing the old one loses nothing it captured.
  const summaryRequests = llm.requests.filter((request) => request.tools.length === 0)
  assert.equal(summaryRequests.length, 3, 'one summarization call per compaction')
  const transcriptOf = (index: number): string =>
    summaryRequests[index]!.messages.map((m) => m.content ?? '').join('\n')
  assert.match(transcriptOf(1), /SUMMARY-ROUND-1/, 'round 2 saw round 1')
  assert.match(transcriptOf(2), /SUMMARY-ROUND-2/, 'round 3 saw round 2')
})

test('reset notifies the persistence layer', async () => {
  // A session cleared in memory but left on disk comes back on the next
  // resume, which reads as the clear silently not working.
  const llm = new ScriptedLLM([reply('done')])
  const snapshots: Array<readonly ChatMessage[]> = []
  const agent = new Agent({ llm, tools: [echoTool] })
  agent.setPersistenceHooks(
    () => {},
    (history) => snapshots.push([...history]),
  )
  await agent.run('go')
  agent.reset()

  assert.equal(snapshots.length, 1, 'reset must fire the replace hook')
  assert.ok(snapshots[0]!.every((m) => m.role === 'system'), 'the snapshot holds only the prompt')
  assert.equal(agent.history.length, 1)
})

test('when compaction fails, the request is projected down instead of sent as is', async () => {
  // A failed summarization leaves the history over the window. Sending it
  // anyway draws a context-length rejection and ends the turn, so the loop
  // drops the age protection for that one request: less detail, but an answer.
  const huge = 'z'.repeat(40_000)
  const llm = new ScriptedLLM([
    reply(null, toolCall('echo', { text: huge })),
    reply(''), // the summarization call returns nothing -> compaction fails
    reply('answered anyway'),
  ])
  const agent = new Agent({
    llm,
    tools: [echoTool],
    maxSteps: 3,
    compaction: { contextWindow: 2_000, keepRecentTokens: 200 },
  })

  const result = await agent.run('go')
  assert.equal(result.stopReason, 'final')
  assert.equal(result.content, 'answered anyway')

  const sent = llm.requests.at(-1)!.messages
  const toolMessage = sent.find((m) => m.role === 'tool')
  assert.ok(toolMessage, 'the tool result is still in the request')
  assert.ok(
    (toolMessage.content ?? '').length < 1_000,
    `the result must be projected down, got ${toolMessage.content?.length} chars`,
  )
  // The stored history keeps full fidelity; only the request was trimmed.
  assert.equal(agent.history.find((m) => m.role === 'tool')?.content?.length, huge.length + 6)
})

test('compaction failure leaves the history untouched', async () => {
  const llm = new ScriptedLLM([
    reply(null, toolCall('echo', { text: 'w'.repeat(4000) })),
    reply('done'),
  ])
  // The summarization call is not scripted -> ScriptedLLM throws.
  const agent = new Agent({
    llm,
    tools: [echoTool],
    compaction: { contextWindow: 100_000, keepRecentTokens: 100 },
  })
  await agent.run('go')
  const before = JSON.stringify(agent.history)

  const ok = await agent.compact()
  assert.equal(ok, false)
  assert.equal(JSON.stringify(agent.history), before)
})

test('auto-compaction triggers when the estimate crosses the threshold', async () => {
  const summary = '## Goal\nkeep going'
  const llm = new ScriptedLLM([
    reply(null, toolCall('echo', { text: 'a'.repeat(8000) })), // step 1: tool call
    reply(summary), // auto-compaction fires before step 2 and consumes this
    reply('final'), // step 2: the model answers with the compacted view
  ])
  const events: string[] = []
  const agent = new Agent({
    llm,
    tools: [echoTool],
    maxSteps: 4,
    // Tiny window so the threshold is crossed after the first tool result.
    compaction: { contextWindow: 3000, reserveTokens: 1000, keepRecentTokens: 500 },
    onEvent: (event) => events.push(event.type),
  })

  const result = await agent.run('go')
  assert.equal(result.content, 'final')
  assert.ok(events.includes('compaction'), 'compaction event fired')
  const summaryMessage = agent.history.find(
    (m) => m.role === 'system' && /Summary of the earlier conversation/.test(m.content ?? ''),
  )
  assert.ok(summaryMessage, 'history contains the compaction summary')
})

test('a failed compaction is not retried within the same run', async () => {
  // A model whose second call (the summarization) always fails, but whose
  // normal replies work: the loop must continue and stop retrying compaction.
  let call = 0
  const flakySummaryLLM: LLM = {
    model: 'flaky-summary',
    async chat(_messages, tools): Promise<LLMResponse> {
      call++
      if (tools.length === 0) throw new Error('summary endpoint down')
      if (call === 1) {
        return { content: null, toolCalls: [toolCall('echo', { text: 'w'.repeat(8000) })] }
      }
      return { content: 'recovered answer', toolCalls: [] }
    },
  }
  const events: string[] = []
  const agent = new Agent({
    llm: flakySummaryLLM,
    tools: [echoTool],
    maxSteps: 3,
    // Window so small the threshold is crossed immediately after the tool result.
    compaction: { contextWindow: 2_500 },
    onEvent: (event) => events.push(event.type),
  })

  const result = await agent.run('go')
  // The loop continued after the failed compaction and produced the answer.
  assert.equal(result.content, 'recovered answer')
  // Exactly one compaction attempt happened, not one per step.
  assert.equal(events.filter((type) => type === 'compaction').length, 1)
})
