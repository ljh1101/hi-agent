import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { globTool, grepTool } from '../src/tools/search.ts'
import type { ToolContext } from '../src/types.ts'

const scratchDirs: string[] = []

async function makeRoot(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-search-'))
  scratchDirs.push(root)
  return { root, log: () => {} }
}

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function put(ctx: ToolContext, rel: string, content: string | Buffer): Promise<void> {
  const absolute = path.join(ctx.root, rel)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

async function seed(ctx: ToolContext): Promise<void> {
  await put(ctx, 'src/a.ts', 'const x = 1\nexport default x\n')
  await put(ctx, 'src/nested/b.ts', 'const y = 2\n')
  await put(ctx, 'lib/util.js', 'function findNeedle() {}\n')
  await put(ctx, 'README.md', '# hi-agent\nfindNeedle in readme\n')
  await put(ctx, 'node_modules/dep/index.js', 'findNeedle\n')
}

test('glob finds files by extension across directories', async () => {
  const ctx = await makeRoot()
  await seed(ctx)

  const result = await globTool.execute({ pattern: '**/*.ts' }, ctx)
  assert.match(result, /2 matches/)
  assert.match(result, /src\/a\.ts/)
  assert.match(result, /src\/nested\/b\.ts/)
})

test('glob supports braces alternation', async () => {
  const ctx = await makeRoot()
  await seed(ctx)

  const result = await globTool.execute({ pattern: '**/*.{ts,js}' }, ctx)
  assert.match(result, /3 matches/)
  assert.match(result, /lib\/util\.js/)
})

test('glob scopes to a subdirectory', async () => {
  const ctx = await makeRoot()
  await seed(ctx)

  const result = await globTool.execute({ pattern: '**/*.ts', path: 'src' }, ctx)
  assert.match(result, /2 matches/)
  assert.doesNotMatch(result, /util\.js/)
})

test('glob reports no matches cleanly', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  const result = await globTool.execute({ pattern: '**/*.py' }, ctx)
  assert.match(result, /No files match/)
})

test('grep finds matching lines with file:line', async () => {
  const ctx = await makeRoot()
  await seed(ctx)

  const result = await grepTool.execute({ pattern: 'findNeedle' }, ctx)
  assert.match(result, /2 lines/)
  assert.match(result, /lib\/util\.js:1:/)
  assert.match(result, /README\.md:2:/)
})

test('grep skips node_modules', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  const result = await grepTool.execute({ pattern: 'findNeedle' }, ctx)
  assert.doesNotMatch(result, /node_modules/)
})

test('grep filters by an include glob', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  const result = await grepTool.execute({ pattern: 'findNeedle', include: '*.js' }, ctx)
  assert.match(result, /1 line/)
  assert.match(result, /util\.js/)
  assert.doesNotMatch(result, /README/)
})

test('grep rejects an invalid regex', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  await assert.rejects(
    async () => await grepTool.execute({ pattern: '[unclosed' }, ctx),
    /Invalid regex/,
  )
})

test('grep skips binary files', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  await put(ctx, 'data.bin', Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]))
  const result = await grepTool.execute({ pattern: 'findNeedle' }, ctx)
  assert.doesNotMatch(result, /data\.bin/)
})

test('grep returns surrounding context lines', async () => {
  const ctx = await makeRoot()
  await put(ctx, 'f.txt', 'a\nb\nneedle\nc\nd\n')
  const result = await grepTool.execute({ pattern: 'needle', context: 1 }, ctx)
  assert.match(result, /f\.txt-2-b/)
  assert.match(result, /f\.txt:3:needle/)
  assert.match(result, /f\.txt-4-c/)
  assert.doesNotMatch(result, /f\.txt-5-d/)
})

test('grep with zero context behaves like the old file:line format', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  const result = await grepTool.execute({ pattern: 'findNeedle' }, ctx)
  assert.match(result, /util\.js:1:/)
  assert.match(result, /README\.md:2:/)
})

test('glob refuses a path outside the workspace root', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  await assert.rejects(
    async () => await globTool.execute({ pattern: '**/*', path: '../outside' }, ctx),
    /outside the workspace root/,
  )
})

test('grep honours .gitignore directory entries', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  await put(ctx, 'vendor/lib.js', 'findNeedle\n')
  await put(ctx, '.gitignore', 'vendor\n')

  const result = await grepTool.execute({ pattern: 'findNeedle' }, ctx)
  assert.doesNotMatch(result, /vendor/)
})

test('grep honours .gitignore nested directory names', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  await put(ctx, 'tmp/logs/a.txt', 'findNeedle\n')
  await put(ctx, '.gitignore', 'tmp/\n')
  const result = await grepTool.execute({ pattern: 'findNeedle' }, ctx)
  assert.doesNotMatch(result, /tmp/)
})

test('search does not follow symlinked directories', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  await put(ctx, 'loop/inside.txt', 'needleInLoop\n')
  await symlink(path.join(ctx.root, 'loop'), path.join(ctx.root, 'src', 'looplink'), 'dir')

  const result = await grepTool.execute({ pattern: 'needleInLoop' }, ctx)
  // The real directory is found, but never the path reached through the symlink.
  assert.match(result, /loop\/inside\.txt/)
  assert.doesNotMatch(result, /looplink/)
})

test('search survives a directory that disappears mid-walk', async () => {
  const ctx = await makeRoot()
  await seed(ctx)
  // A directory that readdir cannot open behaves like a skip, not a crash.
  const result = await grepTool.execute({ pattern: 'no-such-thing-anywhere' }, ctx)
  assert.match(result, /No matches/)
})