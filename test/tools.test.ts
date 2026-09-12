import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { listDirTool, readFileTool, writeFileTool } from '../src/tools/filesystem.ts'
import { currentTimeTool } from '../src/tools/time.ts'
import type { ToolContext } from '../src/types.ts'

// Keep scratch dirs inside the workspace so the sandbox stays happy.
const scratchDirs: string[] = []

async function makeRoot(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-tools-'))
  scratchDirs.push(root)
  return { root, log: () => {} }
}

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test('write_file then read_file round-trips content', async () => {
  const ctx = await makeRoot()
  const written = await writeFileTool.execute({ path: 'notes/hello.txt', content: 'hello\nworld' }, ctx)
  assert.match(written, /Wrote 11 bytes to notes\/hello\.txt/)

  const content = await readFileTool.execute({ path: 'notes/hello.txt' }, ctx)
  assert.equal(content, 'hello\nworld')

  // Parent directories were created, so the real file exists on disk.
  assert.equal(await readFile(path.join(ctx.root, 'notes/hello.txt'), 'utf8'), 'hello\nworld')
})

test('write_file overwrites existing files', async () => {
  const ctx = await makeRoot()
  await writeFileTool.execute({ path: 'a.txt', content: 'first' }, ctx)
  await writeFileTool.execute({ path: 'a.txt', content: 'second' }, ctx)
  assert.equal(await readFileTool.execute({ path: 'a.txt' }, ctx), 'second')
})

test('list_dir reports directories and file sizes, sorted', async () => {
  const ctx = await makeRoot()
  await writeFileTool.execute({ path: 'zeta.txt', content: 'z' }, ctx)
  await writeFileTool.execute({ path: 'alpha/inner.txt', content: 'abc' }, ctx)

  const listing = await listDirTool.execute({ path: '.' }, ctx)
  const lines = listing.split('\n')
  assert.equal(lines[0], '[dir] alpha/')
  assert.equal(lines[1], '[file] zeta.txt (1 bytes)')

  const inner = await listDirTool.execute({ path: 'alpha' }, ctx)
  assert.equal(inner, '[file] inner.txt (3 bytes)')

  // Defaults to the root when no path is given.
  assert.equal(await listDirTool.execute({}, ctx), listing)
})

test('read_file reports missing files as errors instead of throwing raw', async () => {
  const ctx = await makeRoot()
  await assert.rejects(async () => {
    await readFileTool.execute({ path: 'missing.txt' }, ctx)
  }, /no such file or directory/)
  await assert.rejects(async () => {
    await listDirTool.execute({ path: 'not-a-dir' }, ctx)
  }, /no such file or directory/)
})

test('tools cannot escape the workspace root', async () => {
  const ctx = await makeRoot()
  for (const escape of ['../outside.txt', '../../etc/passwd', 'a/../../outside.txt']) {
    await assert.rejects(async () => {
      await readFileTool.execute({ path: escape }, ctx)
    }, /outside the workspace root/)
    await assert.rejects(async () => {
      await writeFileTool.execute({ path: escape, content: 'x' }, ctx)
    }, /outside the workspace root/)
  }
  // Absolute paths inside the root are fine.
  const inside = path.join(ctx.root, 'inside.txt')
  await writeFileTool.execute({ path: inside, content: 'ok' }, ctx)
  assert.equal(await readFileTool.execute({ path: inside }, ctx), 'ok')
  await assert.rejects(async () => {
    await readFileTool.execute({ path: '   ' }, ctx)
  }, /non-empty string/)
})

test('empty files and directories get a readable placeholder', async () => {
  const ctx = await makeRoot()
  await writeFileTool.execute({ path: 'empty.txt', content: '' }, ctx)
  assert.match(await readFileTool.execute({ path: 'empty.txt' }, ctx), /is empty/)
  await writeFileTool.execute({ path: 'dir/keep.txt', content: 'x' }, ctx)
  await rm(path.join(ctx.root, 'dir/keep.txt'))
  assert.match(await listDirTool.execute({ path: 'dir' }, ctx), /is empty/)
})

test('current_time reports UTC and local time', async () => {
  const output = await currentTimeTool.execute({}, { root: process.cwd(), log: () => {} })
  assert.match(output, /ISO \(UTC\):\s+\d{4}-\d{2}-\d{2}T/)
  assert.match(output, /Timezone:\s+UTC[+-]\d{2}:\d{2}/)
})
