import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextUsage,
  estimateTokens,
  findCutPoint,
  pruneMiddle,
  projectHistory,
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

test('shouldCompact respects the threshold and the window guard', () => {
  const on = resolveCompactionOptions({ contextWindow: 100_000 })
  assert.equal(shouldCompact(83_616, on), false, 'exactly at the threshold does not cross (strict >)')
  assert.equal(shouldCompact(83_617, on), true, 'one past the threshold crosses')

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

test('resolveCompactionOptions applies defaults', () => {
  const resolved = resolveCompactionOptions({})
  assert.equal(resolved.contextWindow, 0)
  assert.equal(resolved.reserveTokens, 16_384)
  assert.equal(resolved.keepRecentTokens, 20_000)
})
