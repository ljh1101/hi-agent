import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { expandCommandTemplate, findCustomCommand, loadCustomCommands } from '../src/commands.ts'

const scratchDirs: string[] = []

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeLayout(globalFiles: Record<string, string>, projectFiles: Record<string, string>) {
  const configDir = await mkdtemp(path.join(tmpdir(), '.tmp-cmds-global-'))
  const root = await mkdtemp(path.join(tmpdir(), '.tmp-cmds-project-'))
  scratchDirs.push(configDir, root)
  for (const [name, body] of Object.entries(globalFiles)) {
    const dir = path.join(configDir, 'commands')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, name), body, 'utf8')
  }
  for (const [name, body] of Object.entries(projectFiles)) {
    const dir = path.join(root, '.hi-agent', 'commands')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, name), body, 'utf8')
  }
  return { configDir, root }
}

test('loadCustomCommands reads both directories; project overrides global on clash', async () => {
  const { configDir, root } = await makeLayout(
    { 'review.md': 'global review: $ARGUMENTS', 'deploy.md': 'global deploy' },
    { 'review.md': 'project review: $ARGUMENTS' },
  )
  const commands = await loadCustomCommands(root, configDir)
  const byName = new Map(commands.map((command) => [command.name, command]))

  assert.equal(byName.get('review')!.body, 'project review: $ARGUMENTS')
  assert.equal(byName.get('review')!.source, 'project')
  assert.equal(byName.get('deploy')!.body, 'global deploy')
  assert.equal(byName.get('deploy')!.source, 'global')
})

test('loadCustomCommands tolerates missing directories and skips junk', async () => {
  const { configDir, root } = await makeLayout(
    {},
    { 'not-md.txt': 'ignore me', 'not a name.md': 'spaces never match a slash token', 'ok.md': 'fine' },
  )
  const commands = await loadCustomCommands(root, configDir)
  assert.deepEqual(commands.map((command) => command.name), ['ok'])
})

test('loadCustomCommands on absent directories returns empty, not a crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), '.tmp-cmds-empty-'))
  scratchDirs.push(root)
  assert.deepEqual(await loadCustomCommands(root, path.join(root, 'no-global')), [])
})

test('expandCommandTemplate replaces every $ARGUMENTS occurrence', () => {
  assert.equal(expandCommandTemplate('a $ARGUMENTS b $ARGUMENTS c', 'X'), 'a X b X c')
})

test('expandCommandTemplate treats arguments as data, never as a pattern', () => {
  // A naive `replace` would interpret `$&` in the arguments as the match.
  assert.equal(expandCommandTemplate('run: $ARGUMENTS', '$& $`'), 'run: $& $`')
})

test('expandCommandTemplate appends arguments when the template has no placeholder', () => {
  assert.equal(expandCommandTemplate('review this', 'src/a.ts'), 'review this\n\nsrc/a.ts')
  assert.equal(expandCommandTemplate('review this', ''), 'review this')
})

test('findCustomCommand splits the name from the argument text', () => {
  const commands = [
    { name: 'review', body: 'b', source: 'project' as const },
    { name: 'deploy', body: 'b', source: 'global' as const },
  ]
  assert.deepEqual(findCustomCommand(commands, '/review src/a.ts'), {
    command: commands[0],
    args: 'src/a.ts',
  })
  assert.deepEqual(findCustomCommand(commands, '/deploy'), {
    command: commands[1],
    args: '',
  })
  assert.equal(findCustomCommand(commands, 'plain text'), undefined)
  assert.equal(findCustomCommand(commands, '/unknown x'), undefined)
})
