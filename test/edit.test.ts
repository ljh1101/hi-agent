import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { editTool } from '../src/tools/edit.ts'
import type { ToolContext } from '../src/types.ts'

const scratchDirs: string[] = []

async function makeRoot(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-edit-'))
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

test('edit replaces a unique string in place', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'const x = 1\nconst y = 2\n')

  const result = await editTool.execute({ path: 'f.txt', old_string: 'const x = 1', new_string: 'const x = 42' }, ctx)
  assert.match(result, /1 replacement/)

  const content = await readFile(path.join(ctx.root, 'f.txt'), 'utf8')
  assert.equal(content, 'const x = 42\nconst y = 2\n')
})

test('edit rejects an old_string that does not occur', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'hello\n')
  await assert.rejects(
    async () => await editTool.execute({ path: 'f.txt', old_string: 'nope', new_string: 'x' }, ctx),
    /was not found/,
  )
})

test('edit rejects an ambiguous old_string with multiple occurrences', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'dup\ndup\n')
  await assert.rejects(
    async () => await editTool.execute({ path: 'f.txt', old_string: 'dup', new_string: 'x' }, ctx),
    /appears 2 times/,
  )
})

test('edit rejects an identical replacement', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'same\n')
  await assert.rejects(
    async () => await editTool.execute({ path: 'f.txt', old_string: 'same', new_string: 'same' }, ctx),
    /identical/,
  )
})

test('edit leaves the rest of the file untouched', async () => {
  const ctx = await makeRoot()
  const original = 'line one\nline two\nline three\n'
  await put(ctx, 'f.txt', original)
  await editTool.execute({ path: 'f.txt', old_string: 'line two', new_string: 'LINE TWO' }, ctx)
  assert.equal(await readFile(path.join(ctx.root, 'f.txt'), 'utf8'), 'line one\nLINE TWO\nline three\n')
})

test('edit refuses to escape the workspace root', async () => {
  const ctx = await makeRoot()
  await assert.rejects(
    async () => await editTool.execute({ path: '../outside.txt', old_string: 'a', new_string: 'b' }, ctx),
    /outside the workspace root/,
  )
})

// The model cannot emit `\r` inside tool arguments, so every multi-line
// `old_string` arrives with LF separators even for a CRLF file.
test('edit matches a multi-line old_string with LF in a CRLF file', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'alpha\r\nbeta\r\ngamma\r\n')

  const result = await editTool.execute(
    { path: 'f.txt', old_string: 'alpha\nbeta', new_string: 'alpha\nBETA' },
    ctx,
  )
  assert.match(result, /1 replacement/)
  assert.equal(await readFile(path.join(ctx.root, 'f.txt'), 'utf8'), 'alpha\r\nBETA\r\ngamma\r\n')
})

test('edit preserves the CRLF line endings of the file it edits', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'one\r\ntwo\r\nthree\r\n')
  await editTool.execute({ path: 'f.txt', old_string: 'two', new_string: 'TWO' }, ctx)

  const content = await readFile(path.join(ctx.root, 'f.txt'), 'utf8')
  assert.equal(content, 'one\r\nTWO\r\nthree\r\n')
  // A single-line edit must not rewrite the endings of the untouched lines.
  assert.equal((content.match(/\r\n/g) ?? []).length, 3)
})

test('edit keeps a trailing newline and reports a CRLF mismatch hint', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'alpha\r\nbeta\r\n')
  await editTool.execute({ path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }, ctx)
  assert.equal(await readFile(path.join(ctx.root, 'f.txt'), 'utf8'), 'ALPHA\r\nbeta\r\n')

  await assert.rejects(
    async () =>
      await editTool.execute(
        { path: 'f.txt', old_string: 'alpha\r\nbeta', new_string: 'x' },
        ctx,
      ),
    /CRLF line endings/,
  )
})

test('edit does not rewrite an LF file when the model sends CRLF', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'alpha\nbeta\n')
  await editTool.execute(
    { path: 'f.txt', old_string: 'alpha\r\nbeta', new_string: 'alpha\r\nBETA' },
    ctx,
  )
  assert.equal(await readFile(path.join(ctx.root, 'f.txt'), 'utf8'), 'alpha\nBETA\n')
})