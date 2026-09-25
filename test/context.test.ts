import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextUsage,
  estimateTokens,
  findCutPoint,
  pruneMiddle,
  projectHistory,
  projectRequestView,
  resolveCompactionOptions,
  resolveContextOptions,
  serializeForSummary,
  shouldCompact,
} from '../src/context.ts'
import type { ChatMessage } from '../src/types.ts'

const opts = resolveContextOptions()

function historyWith(...messages: ChatMessage[]): ChatMessage[] {
  return messages
}

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistant = (text: string, calls?: ChatMessage['tool_calls']): ChatMessage => ({
  role: 'assistant',
  content: text,
  ...(calls ? { tool_calls: calls } : {}),
})
const tool = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  content,
  tool_call_id: id,
  name: 'shell',
})

const big = 'x'.repeat(5000)
const small = 'x'.repeat(100)

test('pruneMiddle keeps head and tail with a size marker', () => {
  const pruned = pruneMiddle(big, opts)
  assert.ok(pruned.startsWith('x'.repeat(opts.pruneHeadChars)))
  assert.ok(pruned.endsWith('x'.repeat(opts.pruneTailChars)))
  assert.match(pruned, /characters pruned/)
  assert.ok(pruned.length < big.length)
})

test('pruneMiddle leaves short text untouched', () => {
  assert.equal(pruneMiddle(small, opts), small)
})

test('old oversized tool results are pruned in the projection', () => {
  const history = historyWith(
    user('turn 1'),
    assistant('running', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    tool('c1', big),
    assistant('done 1'),
    user('turn 2'),
    assistant('running', [{ id: 'c2', name: 'shell', arguments: '{}' }]),
    tool('c2', big),
    assistant('done 2'),
    user('turn 3'),
    assistant('running', [{ id: 'c3', name: 'shell', arguments: '{}' }]),
    tool('c3', big),
    assistant('done 3'),
    user('turn 4'),
  )

  const view = projectHistory(history, opts)
  // Turn 1 (beyond the 3 protected turns) is pruned...
  assert.match(view[2]!.content ?? '', /characters pruned/)
  // ...the protected turns keep full results.
  assert.equal(view[6]!.content ?? '', big)
  assert.equal(view[10]!.content ?? '', big)
})

test('short tool results are never pruned, even when old', () => {
  const history = historyWith(
    user('turn 1'),
    assistant('running', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    tool('c1', small),
    user('turn 2'),
    user('turn 3'),
    user('turn 4'),
  )
  const view = projectHistory(history, opts)
  assert.equal(view[2]!.content ?? '', small)
})

test('projection never modifies the stored history', () => {
  const history = historyWith(
    user('turn 1'),
    assistant('running', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    tool('c1', big),
    user('turn 2'),
    user('turn 3'),
    user('turn 4'),
  )
  const before = JSON.stringify(history)
  projectHistory(history, opts)
  assert.equal(JSON.stringify(history), before)
})

test('user, assistant and system messages are passed through untouched', () => {
  const history = historyWith(
    { role: 'system', content: 'sys' },
    user('turn 1'),
    assistant('thinking out loud'.repeat(400)),
    tool('c1', big),
    user('turn 2'),
    user('turn 3'),
    user('turn 4'),
  )
  const view = projectHistory(history, opts)
  assert.equal(view[0]!.content, 'sys')
  assert.equal(view[1]!.content, 'turn 1')
  assert.equal(view[2]!.content, 'thinking out loud'.repeat(400))
  // Only the tool message was touched.
  assert.match(view[3]!.content ?? '', /characters pruned/)
})

test('tool message identity is preserved after pruning (tool_call_id, name)', () => {
  const history = historyWith(
    user('turn 1'),
    assistant('running', [{ id: 'call_abc', name: 'shell', arguments: '{}' }]),
    tool('call_abc', big),
    user('turn 2'),
    user('turn 3'),
    user('turn 4'),
  )
  const view = projectHistory(history, opts)
  const pruned = view[2]!
  assert.equal(pruned.tool_call_id, 'call_abc')
  assert.equal(pruned.name, 'shell')
  assert.equal(pruned.role, 'tool')
})

test('fewer user turns than the protection window protects everything', () => {
  const history = historyWith(
    user('only turn'),
    assistant('running', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    tool('c1', big),
    assistant('done'),
  )
  const view = projectHistory(history, opts)
  assert.equal(view[2]!.content ?? '', big)
})

test('protectedTurns: 0 disables protection entirely', () => {
  const noProtection = resolveContextOptions({ protectedTurns: 0 })
  const history = historyWith(
    user('turn 1'),
    assistant('running', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    tool('c1', big),
    assistant('done'),
  )
  const view = projectHistory(history, noProtection)
  assert.match(view[2]!.content ?? '', /characters pruned/)
})

test('a single tool result is capped whatever its age', () => {
  // The age rule protects the newest turns because the model still needs them;
  // this ceiling exists so that one observation cannot own the window on its
  // own — a 50KB shell dump in the turn being answered is otherwise protected
  // from pruning and can push the request over the model's limit by itself.
  const capped = resolveContextOptions({ maxToolResultChars: 1000 })
  const history = historyWith(
    user('turn 1'),
    assistant('running', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    tool('c1', 'x'.repeat(20_000)),
  )
  const view = projectHistory(history, capped)
  const body = view[2]!.content ?? ''
  assert.ok(body.length < 1200, `expected the cap to apply, got ${body.length}`)
  assert.match(body, /characters pruned/)
  // Half the budget at each end: the head shows the shape of the output, the
  // tail keeps the error or summary a command usually ends with.
  assert.ok(body.startsWith('x'.repeat(500)))
  assert.ok(body.endsWith('x'.repeat(500)))
  // The history itself is never touched.
  assert.equal(history[2]!.content?.length, 20_000)

  // Under the cap and recent: left alone.
  const smallHistory = historyWith(user('turn 1'), tool('c1', 'y'.repeat(900)))
  assert.equal(projectHistory(smallHistory, capped)[1]!.content, 'y'.repeat(900))
})

test('the age rule wins over the ceiling for old results', () => {
  // Order matters: testing the ceiling first made an old 40k result come back
  // as 8000 characters instead of the 600 the age rule gives it — the request
  // grew, which is the opposite of the point.
  const options = resolveContextOptions({ maxToolResultChars: 8000 })
  const history = historyWith(
    user('turn 1'),
    tool('c1', 'x'.repeat(40_000)),
    user('turn 2'),
    user('turn 3'),
    user('turn 4'),
  )
  const old = projectHistory(history, options)[1]!.content ?? ''
  assert.ok(
    old.length < options.pruneThresholdChars,
    `the aggressive prune must win, got ${old.length}`,
  )
})

test('projectRequestView drops the age protection once the budget is blown', () => {
  const options = resolveContextOptions()
  const recent = historyWith(
    user('turn 1'),
    assistant('running', [{ id: 'c1', name: 'shell', arguments: '{}' }]),
    tool('c1', 'x'.repeat(20_000)),
  )
  const noUsages = new Map<number, { totalTokens?: number }>()

  // Compaction disabled: the plain projection, whatever the size.
  const off = projectRequestView(recent, options, { contextWindow: 0, thresholdTokens: 1 }, noUsages)
  assert.ok((off[2]!.content ?? '').length > 1000, 'no emergency pass without a window')

  // Under the budget: the recent result keeps its protected size.
  const roomy = projectRequestView(recent, options, { contextWindow: 100_000, thresholdTokens: 80_000 }, noUsages)
  assert.ok((roomy[2]!.content ?? '').length > 1000, 'recent results stay whole under budget')

  // Over the budget: pruning now applies to the newest turn too.
  const tight = projectRequestView(recent, options, { contextWindow: 2_000, thresholdTokens: 1_600 }, noUsages)
  const body = tight[2]!.content ?? ''
  assert.ok(body.length < 1000, `expected the emergency projection, got ${body.length}`)
  assert.match(body, /characters pruned/)
})

test('custom budgets are honoured', () => {
  const custom = resolveContextOptions({
    pruneThresholdChars: 100,
    pruneHeadChars: 10,
    pruneTailChars: 5,
    protectedTurns: 1,
  })
  const history = historyWith(
    user('turn 1'),
    tool('c1', 'a'.repeat(500)),
    user('turn 2'),
  )
  const view = projectHistory(history, custom)
  const pruned = view[1]!.content ?? ''
  assert.ok(pruned.startsWith('a'.repeat(10)))
  assert.ok(pruned.endsWith('a'.repeat(5)))
  assert.match(pruned, /485 characters pruned/)
})

// ---------------------------------------------------------------------------
// Token accounting (stage 2)
// ---------------------------------------------------------------------------

test('estimateTokens uses chars/4 including tool call payloads', () => {
  const plain: ChatMessage = { role: 'user', content: 'a'.repeat(400) }
  assert.equal(estimateTokens(plain), 100)

  const withCalls: ChatMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: '1', name: 'shell', arguments: 'b'.repeat(200) }],
  }
  // 5 (name) + 200 (args) = 205 chars -> 52 tokens
  assert.equal(estimateTokens(withCalls), 52)
})

test('contextUsage anchors on the last reported usage and estimates the tail', () => {
  const messages: ChatMessage[] = [
    user('a'.repeat(4000)), // 1000 est
    assistant('b'.repeat(2000)), // 500 est
    user('c'.repeat(4000)), // 1000 est
    assistant('d'.repeat(2000)), // 500 est
    user('e'.repeat(4000)), // 1000 est
  ]
  // Usage reported for the request that produced messages[3].
  const usages = new Map([[3, { totalTokens: 10_000 }]])

  const usage = contextUsage(messages, usages)
  assert.equal(usage.hasUsageBasis, true)
  // 10000 (anchor) + estimate of messages[4] (1000) = 11000
  assert.equal(usage.tokens, 11_000)
})

test('contextUsage estimates everything when no usage is known', () => {
  const messages: ChatMessage[] = [
    user('a'.repeat(4000)),
    assistant('b'.repeat(2000)),
    user('c'.repeat(4000)),
  ]
  const usage = contextUsage(messages, new Map())
  assert.equal(usage.hasUsageBasis, false)
  assert.equal(usage.tokens, 1000 + 500 + 1000)
})

test('contextUsage ignores zero or missing totals in the usage map', () => {
  const messages: ChatMessage[] = [user('a'.repeat(4000)), assistant('b'.repeat(2000))]
  const usages = new Map([[1, { totalTokens: 0 }]])
  const usage = contextUsage(messages, usages)
  assert.equal(usage.hasUsageBasis, false)
  assert.equal(usage.tokens, 1500)
})

// ---------------------------------------------------------------------------
// Compaction (stage 3)
// ---------------------------------------------------------------------------

test('shouldCompact uses ratio thresholds that scale across window sizes', () => {
  const window100k = resolveCompactionOptions({ contextWindow: 100_000 })
  // 0.8 ratio: threshold at 80000.
  assert.equal(window100k.thresholdTokens, 80_000)
  assert.equal(shouldCompact(80_000, window100k), false)
  assert.equal(shouldCompact(80_001, window100k), true)

  // A tiny window keeps a positive, reachable threshold: the fixed-reserve
  // design went negative here and fired compaction on every step forever.
  const window8k = resolveCompactionOptions({ contextWindow: 8_000 })
  assert.ok(window8k.thresholdTokens > 0)
  assert.equal(shouldCompact(6_399, window8k), false)
  assert.equal(shouldCompact(6_401, window8k), true)

  // Explicit token overrides still win over the ratio.
  const overridden = resolveCompactionOptions({
    contextWindow: 100_000,
    reserveTokens: 10_000,
    keepRecentTokens: 5_000,
  })
  assert.equal(overridden.thresholdTokens, 10_000)
  assert.equal(overridden.keepRecentTokens, 5_000)

  const off = resolveCompactionOptions({})
  assert.equal(off.contextWindow, 0)
  assert.equal(shouldCompact(1_000_000, off), false, 'no window: auto-compaction disabled')
})

test('findCutPoint keeps the newest turns up to the budget', () => {
  const messages: ChatMessage[] = [
    user('a'.repeat(4000)), // turn A (1000 tokens)
    assistant('b'.repeat(4000)),
    user('c'.repeat(4000)), // turn B
    assistant('d'.repeat(4000)),
    user('e'.repeat(4000)), // turn C
    assistant('f'.repeat(4000)),
  ]
  // Budget for ~2500 tokens: the tail from the cut must cover it and land on
  // a turn boundary message.
  const { keepFrom } = findCutPoint(messages, 2500)
  const boundary = messages[keepFrom]!
  assert.ok(boundary.role === 'user' || boundary.role === 'assistant')
  const keptTokens = messages.slice(keepFrom).reduce((sum, m) => sum + estimateTokens(m), 0)
  assert.ok(keptTokens >= 2500, `kept ${keptTokens} tokens, expected >= budget`)
  // And it kept strictly less than the whole history.
  assert.ok(keepFrom > 0)
})

test('findCutPoint never cuts between a tool call and its result', () => {
  const messages: ChatMessage[] = [
    user('a'.repeat(4000)),
    assistant('b'.repeat(4000)),
    user('c'.repeat(4000)),
    // A tool call right at the budget boundary...
    assistant('run', [{ id: 't1', name: 'shell', arguments: '{}' }]),
    tool('t1', 'd'.repeat(4000)),
    user('e'.repeat(4000)),
  ]
  const { keepFrom } = findCutPoint(messages, 1200)
  const cut = messages[keepFrom]!
  assert.ok(cut.role === 'user' || cut.role === 'assistant', 'cut is at a boundary message')
  if (cut.role === 'assistant' && cut.tool_calls?.length) {
    // The tool result after it must be kept too.
    assert.equal(messages[keepFrom + 1]!.role, 'tool')
  }
})

test('serializeForSummary caps tool output and labels roles', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    user('hello'),
    assistant('run it', [{ id: 't1', name: 'shell', arguments: '{"command":"ls"}' }]),
    tool('t1', 'x'.repeat(5000)),
  ]
  const text = serializeForSummary(messages)
  assert.match(text, /\[User\]: hello/)
  assert.match(text, /\[Assistant tool call\]: shell\(/)
  assert.match(text, /\[Tool result\]: x{2000}/)
  assert.match(text, /\[truncated\]/)
  assert.ok(!text.includes('sys'))
})

test('resolveCompactionOptions applies ratio defaults', () => {
  const resolved = resolveCompactionOptions({ contextWindow: 1_000_000 })
  assert.equal(resolved.thresholdRatio, 0.8)
  assert.equal(resolved.retainRatio, 0.2)
  assert.equal(resolved.thresholdTokens, 800_000)
  assert.equal(resolved.keepRecentTokens, 200_000)
})

test('serializeForSummary caps the total transcript, dropping oldest lines first', () => {
  const messages: ChatMessage[] = []
  for (let turn = 0; turn < 10; turn++) {
    messages.push(user(`turn ${turn} ${'a'.repeat(900)}`))
  }
  const text = serializeForSummary(messages, 2000, 2_000)
  assert.ok(text.length <= 2_100, `transcript is ${text.length} chars`)
  // The newest turns survive; the drop marker names what went.
  assert.match(text, /turn 9/)
  assert.match(text, /oldest lines dropped/)
})

test('serializeForSummary leaves small transcripts untouched', () => {
  const messages: ChatMessage[] = [user('hello'), assistant('hi')]
  assert.equal(serializeForSummary(messages), '[User]: hello\n[Assistant]: hi')
})
