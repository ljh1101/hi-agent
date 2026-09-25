import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { symlinkSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { listDirTool, readFileTool, writeFileTool } from '../src/tools/filesystem.ts'
import { editTool } from '../src/tools/edit.ts'
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

test('a link inside the root cannot be used to escape it', async () => {
  // Lexical confinement passes a link: `link/secret.txt` is inside the root as
  // a string, but the read follows the link out. Measured before the fix, a
  // junction at `<root>/link` made read_file return a file outside the root.
  const ctx = await makeRoot()
  const outside = await mkdtemp(path.join(process.cwd(), '.tmp-tools-out-'))
  scratchDirs.push(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'SECRET=outside-the-root')

  const link = path.join(ctx.root, 'link')
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    return // a platform/permission that forbids links cannot be tested here
  }

  // Reading, writing, listing and editing all refuse to follow it out.
  for (const path_ of ['link/secret.txt', 'link/new.txt']) {
    await assert.rejects(
      async () => await readFileTool.execute({ path: path_ }, ctx),
      /through a link/,
    )
    await assert.rejects(
      async () => await writeFileTool.execute({ path: path_, content: 'x' }, ctx),
      /through a link/,
    )
  }
  await assert.rejects(async () => await listDirTool.execute({ path: 'link' }, ctx), /through a link/)
  await assert.rejects(
    async () =>
      await editTool.execute({ path: 'link/secret.txt', old_string: 'SECRET', new_string: 'X' }, ctx),
    /through a link/,
  )
  // The file outside the root is untouched.
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'SECRET=outside-the-root')

  // Ordinary paths still work, including one that does not exist yet.
  await writeFileTool.execute({ path: 'sub/ok.txt', content: 'ok' }, ctx)
  assert.equal(await readFileTool.execute({ path: 'sub/ok.txt' }, ctx), 'ok')
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

test('read_file returns a line range with numbering', async () => {
  const ctx = await makeRoot()
  await writeFileTool.execute({ path: 'nums.txt', content: 'one\ntwo\nthree\nfour\nfive\n' }, ctx)

  const range = await readFileTool.execute({ path: 'nums.txt', offset: 2, limit: 2 }, ctx)
  assert.match(range, /lines 2-3 of 5/)
  assert.match(range, /2: two/)
  assert.match(range, /3: three/)
  assert.doesNotMatch(range, /1: one/)
  assert.doesNotMatch(range, /4: four/)
})

test('read_file clamps an out-of-range offset gracefully', async () => {
  const ctx = await makeRoot()
  await writeFileTool.execute({ path: 'a.txt', content: 'x\ny\n' }, ctx)

  const result = await readFileTool.execute({ path: 'a.txt', offset: 99 }, ctx)
  assert.match(result, /has 2 lines/)
  assert.match(result, /out of range/)
})

test('read_file rejects a non-positive offset or limit', async () => {
  const ctx = await makeRoot()
  await writeFileTool.execute({ path: 'a.txt', content: 'x\n' }, ctx)
  await assert.rejects(
    async () => await readFileTool.execute({ path: 'a.txt', offset: 0 }, ctx),
    /positive integer/,
  )
  await assert.rejects(
    async () => await readFileTool.execute({ path: 'a.txt', limit: -1 }, ctx),
    /positive integer/,
  )
})
