import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { shellTool } from '../src/tools/shell.ts'
import type { ToolContext } from '../src/types.ts'

const scratchDirs: string[] = []

async function makeRoot(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-shell-'))
  scratchDirs.push(root)
  return { root, log: () => {} }
}

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test('runs a command and returns its stdout', async () => {
  const ctx = await makeRoot()
  const result = await shellTool.execute({ command: 'echo hello world' }, ctx)
  assert.match(result, /hello world/)
})

test('captures stderr and stdout together', async () => {
  const ctx = await makeRoot()
  const result = await shellTool.execute({ command: 'echo out && echo err >&2' }, ctx)
  assert.match(result, /out/)
  assert.match(result, /err/)
})

test('reports a non-zero exit code as an error', async () => {
  const ctx = await makeRoot()
  await assert.rejects(
    async () => await shellTool.execute({ command: 'exit 3' }, ctx),
    /exited with code 3/,
  )
})

test('runs in a workdir relative to the root', async () => {
  const ctx = await makeRoot()
  await writeFile(path.join(ctx.root, 'marker.txt'), 'here', 'utf8')
  const result = await shellTool.execute({ command: 'ls', workdir: '.' }, ctx)
  assert.match(result, /marker\.txt/)
})

test('refuses a workdir outside the workspace root', async () => {
  const ctx = await makeRoot()
  await assert.rejects(
    async () => await shellTool.execute({ command: 'ls', workdir: '../outside' }, ctx),
    /outside the workspace root/,
  )
})

test('times out a hanging command and kills it', async () => {
  const ctx = await makeRoot()
  await assert.rejects(
    async () => await shellTool.execute({ command: 'sleep 5', timeout: 1 }, ctx),
    /timed out/,
  )
})

test('truncates very large output to the tail', async () => {
  const ctx = await makeRoot()
  // Generate ~3000 lines; the last line is a unique marker.
  const command = 'for i in $(seq 1 3000); do echo "line $i"; done; echo "TAIL_MARKER"'
  const result = await shellTool.execute({ command }, ctx)
  assert.match(result, /TAIL_MARKER/)
  assert.match(result, /truncated/)
  // The head (line 1) must be gone.
  assert.doesNotMatch(result, /line 1\n/)
})

test('returns a placeholder for no output', async () => {
  const ctx = await makeRoot()
  const result = await shellTool.execute({ command: 'true' }, ctx)
  assert.match(result, /no output/)
})
