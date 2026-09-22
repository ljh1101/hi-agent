import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  appendCompaction,
  appendMessage,
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  newSessionId,
  sessionsDir,
} from '../src/session.ts'
import type { ChatMessage } from '../src/types.ts'

const scratchDirs: string[] = []

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(process.cwd(), '.tmp-session-'))
  scratchDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text })

test('create-append-load round-trips a session', async () => {
  const dir = await makeConfigDir()
  const id = newSessionId()
  await createSession(dir, id, 'test-model')
  await appendMessage(dir, id, user('hello'))
  await appendMessage(dir, id, assistant('hi there'))

  const loaded = await loadSession(dir, id)
  assert.ok(loaded)
  assert.equal(loaded.header.id, id)
  assert.equal(loaded.header.model, 'test-model')
  assert.deepEqual(
    loaded.history.map((m) => [m.role, m.content]),
    [
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ],
  )
})

test('loadSession tolerates a torn final line', async () => {
  const dir = await makeConfigDir()
  const id = newSessionId()
  await createSession(dir, id, 'm')
  await appendMessage(dir, id, user('one'))
  // Simulate a crash mid-write: half a JSON line at the end.
  const file = path.join(sessionsDir(dir), `${id}.jsonl`)
  await writeFile(file, '{"kind":"message","mess', { encoding: 'utf8', flag: 'a' })

  const loaded = await loadSession(dir, id)
  assert.ok(loaded)
  assert.equal(loaded.history.length, 1, 'the torn line is dropped, the rest survives')
})

test('loadSession returns undefined for a missing session', async () => {
  const dir = await makeConfigDir()
  assert.equal(await loadSession(dir, 'nope'), undefined)
})

test('appendCompaction snapshots; old lines stay on disk and replay resumes after', async () => {
  const dir = await makeConfigDir()
  const id = newSessionId()
  await createSession(dir, id, 'm')
  await appendMessage(dir, id, user('old 1'))
  await appendMessage(dir, id, assistant('old 2'))

  // Compaction: snapshot replaces the effective history...
  await appendCompaction(dir, id, [
    { role: 'system', content: 'Summary: it happened' },
    user('recent'),
  ])
  // ...and the conversation continues after it.
  await appendMessage(dir, id, assistant('post-compaction reply'))

  const loaded = await loadSession(dir, id)
  assert.ok(loaded)
  assert.deepEqual(
    loaded.history.map((m) => [m.role, m.content ?? '']),
    [
      ['system', 'Summary: it happened'],
      ['user', 'recent'],
      ['assistant', 'post-compaction reply'],
    ],
  )

  // The pre-compaction lines are still physically present (auditable).
  const raw = await readFile(path.join(sessionsDir(dir), `${id}.jsonl`), 'utf8')
  assert.match(raw, /old 1/)
  assert.match(raw, /"kind":"compaction"/)
})

test('a second compaction supersedes the first', async () => {
  const dir = await makeConfigDir()
  const id = newSessionId()
  await createSession(dir, id, 'm')
  await appendMessage(dir, id, user('v1'))
  await appendCompaction(dir, id, [user('snapshot 1')])
  await appendMessage(dir, id, assistant('between'))
  await appendCompaction(dir, id, [user('snapshot 2')])

  const loaded = await loadSession(dir, id)
  assert.ok(loaded)
  assert.deepEqual(
    loaded.history.map((m) => m.content),
    ['snapshot 2'],
  )
})


test('listSessions returns metadata sorted newest first', async () => {
  const dir = await makeConfigDir()
  const older = newSessionId()
  const newer = newSessionId()
  // Order ids so `newer` sorts after `older`; mtime decides anyway.
  await createSession(dir, older, 'model-a')
  await appendMessage(dir, older, user('first question'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await createSession(dir, newer, 'model-b')
  await appendMessage(dir, newer, user('second question'))
  await appendMessage(dir, newer, assistant('answer'))

  const metas = await listSessions(dir)
  assert.equal(metas.length, 2)
  assert.equal(metas[0]!.id, newer)
  assert.equal(metas[0]!.messageCount, 2)
  assert.equal(metas[0]!.title, 'second question')
  assert.equal(metas[1]!.id, older)
  assert.equal(metas[1]!.messageCount, 1)
})

test('listSessions on an empty or missing directory returns []', async () => {
  const dir = await makeConfigDir()
  assert.deepEqual(await listSessions(dir), [])
  assert.deepEqual(await listSessions(path.join(dir, 'never-created')), [])
})

test('deleteSession removes the file and is a no-op when absent', async () => {
  const dir = await makeConfigDir()
  const id = newSessionId()
  await createSession(dir, id, 'm')
  await deleteSession(dir, id)
  assert.equal(await loadSession(dir, id), undefined)
  await deleteSession(dir, id) // no throw
})

test('session ids are sortable and unique', () => {
  const ids = [newSessionId(), newSessionId()]
  assert.notEqual(ids[0], ids[1])
  assert.match(ids[0]!, /^\d{8}-\d{6}-[0-9a-f]{8}$/)
})

test('agent onAppend fires for every appended message, onReplace on compaction', async () => {
  const { Agent } = await import('../src/agent.ts')
  const { ScriptedLLM, reply, toolCall } = await import('./helpers.ts')

  const appended: ChatMessage[] = []
  let replaced: ChatMessage[] | undefined
  const llm = new ScriptedLLM([
    reply(null, toolCall('calculator', { expression: '1+1' })),
    reply('done'),
  ])
  const calc = (await import('../src/tools/calculator.ts')).calculatorTool

  const agent = new Agent({
    llm,
    tools: [calc],
    onAppend: (message) => appended.push(message),
    onReplace: (history) => {
      replaced = [...history]
    },
  })
  await agent.run('go')

  // user + assistant(tool_calls) + tool + assistant(final) = 4 appends.
  assert.equal(appended.length, 4)
  assert.deepEqual(appended.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.equal(replaced, undefined, 'no compaction happened')
})
