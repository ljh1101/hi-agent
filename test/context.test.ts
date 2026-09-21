import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pruneMiddle, projectHistory, resolveContextOptions } from '../src/context.ts'
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
