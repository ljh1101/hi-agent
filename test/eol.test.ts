import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { readFileTool, writeFileTool } from '../src/tools/filesystem.ts'
import type { ToolContext } from '../src/types.ts'

const scratchDirs: string[] = []

async function makeRoot(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-eol-'))
  scratchDirs.push(root)
  return { root, log: () => {} }
}

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function put(ctx: ToolContext, rel: string, content: string): Promise<void> {
  const absolute = path.join(ctx.root, rel)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

async function get(ctx: ToolContext, rel: string): Promise<string> {
  return await readFile(path.join(ctx.root, rel), 'utf8')
}

// The model can only emit LF, so `read_file` must never hand it a `\r` — on
// either code path. Otherwise a multi-line edit is impossible to express.
test('read_file returns LF for a CRLF file, with and without a line range', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n')

  const whole = await readFileTool.execute({ path: 'crlf.txt' }, ctx)
  assert.equal(whole, 'one\ntwo\nthree\n')
  assert.ok(!whole.includes('\r'))

  const ranged = await readFileTool.execute({ path: 'crlf.txt', offset: 1, limit: 3 }, ctx)
  assert.ok(!ranged.includes('\r'))
  assert.match(ranged, /^crlf\.txt \(lines 1-3 of 3, CRLF\)\n1: one\n2: two\n3: three$/)
})

test('read_file marks an LF file as LF rather than CRLF', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'lf.txt', 'one\ntwo\n')

  const ranged = await readFileTool.execute({ path: 'lf.txt', offset: 1, limit: 2 }, ctx)
  assert.match(ranged, /\(lines 1-2 of 2\)/)
  assert.ok(!ranged.includes('CRLF'))
})

test('write_file keeps the line endings of the file it overwrites', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'crlf.txt', 'old\r\n')

  await writeFileTool.execute({ path: 'crlf.txt', content: 'new\nlines\n' }, ctx)
  assert.equal(await get(ctx, 'crlf.txt'), 'new\r\nlines\r\n')
})

test('write_file creates a new file with LF regardless of platform', async () => {
  const ctx = await makeRoot()
  await writeFileTool.execute({ path: 'fresh.txt', content: 'a\nb\n' }, ctx)
  assert.equal(await get(ctx, 'fresh.txt'), 'a\nb\n')
})

// A single stray `\r\n` must not reclassify an LF file as CRLF, or one edited
// line turns into a whole-file rewrite.
test('detection is purity-based, so a stray CRLF does not flip the file to CRLF', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'mixed.txt', 'a\nb\r\nc\n')

  await writeFileTool.execute({ path: 'mixed.txt', content: 'a\nB\nc\n' }, ctx)
  assert.equal(await get(ctx, 'mixed.txt'), 'a\nB\nc\n')
})

test('round-tripping CRLF through read_file and write_file is stable', async () => {
  const ctx = await makeRoot()
  const original = 'alpha\r\nbeta\r\n'
  await put(ctx, 'f.txt', original)

  const read = await readFileTool.execute({ path: 'f.txt' }, ctx)
  await writeFileTool.execute({ path: 'f.txt', content: read }, ctx)
  assert.equal(await get(ctx, 'f.txt'), original)
})
