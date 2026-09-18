import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { derivePrefixRule, evaluate, matchesPrefix, parseRules } from '../src/permissions.ts'
import { createShellTool } from '../src/tools/shell.ts'
import type { ToolContext } from '../src/types.ts'

const scratchDirs: string[] = []
after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test('matchesPrefix handles exact and wildcard rules', () => {
  assert.equal(matchesPrefix('npm run test', 'npm run *'), true)
  assert.equal(matchesPrefix('npm run', 'npm run *'), true, 'trailing wildcard matches the bare prefix')
  assert.equal(matchesPrefix('npmx run test', 'npm run *'), false)
  assert.equal(matchesPrefix('git status', 'git status'), true)
  assert.equal(matchesPrefix('git status -s', 'git status'), false, 'exact rule does not prefix-match')
  assert.equal(matchesPrefix('anything', ''), false)
})

test('evaluate: deny wins over allow', () => {
  const rules = parseRules({ allow: ['npm *'], deny: ['npm publish *'] })
  assert.equal(evaluate('npm run test', rules), 'allow')
  assert.equal(evaluate('npm publish', rules), 'deny')
  assert.equal(evaluate('npm run test && npm publish', rules), 'deny', 'deny in any subcommand rejects the line')
})

test('evaluate: allow requires every subcommand to match', () => {
  const rules = parseRules({ allow: ['ls *', 'npm run *'] })
  assert.equal(evaluate('ls && npm run test', rules), 'allow')
  assert.equal(evaluate('ls && rm x', rules), 'ask', 'one unmatched part falls back to ask')
})

test('parseRules drops invalid entries and tolerates junk', () => {
  const rules = parseRules({ allow: ['npm *', 42, '', null], deny: 'not-an-array' })
  assert.deepEqual(rules, { allow: ['npm *'], deny: [] })
  assert.deepEqual(parseRules(undefined), { allow: [], deny: [] })
  assert.deepEqual(parseRules('junk'), { allow: [], deny: [] })
})

test('derivePrefixRule keeps the meaningful subcommand', () => {
  assert.equal(derivePrefixRule('npm run test --watch'), 'npm run *')
  assert.equal(derivePrefixRule('git commit -m x'), 'git commit *')
  assert.equal(derivePrefixRule('mkdir -p a/b'), 'mkdir *')
  assert.equal(derivePrefixRule('node script.js'), 'node *')
  assert.equal(derivePrefixRule(''), '')
})

test('shell tool honours persistent allow rules without asking', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-perm-'))
  scratchDirs.push(root)
  const ctx: ToolContext = { root, log: () => {} }
  const tool = createShellTool({ rules: parseRules({ allow: ['echo *'] }) })

  let asked = 0
  const result = await tool.execute(
    { command: 'echo rule-approved' },
    { ...ctx, approve: async () => { asked++; return false } },
  )
  assert.equal(asked, 0, 'allow rule must skip the approver')
  assert.match(result, /rule-approved/)
})

test('shell tool blocks deny rules even with an approving approver', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-perm-'))
  scratchDirs.push(root)
  const ctx: ToolContext = { root, log: () => {} }
  const tool = createShellTool({ rules: parseRules({ deny: ['git push *'] }) })

  await assert.rejects(
    async () =>
      await tool.execute(
        { command: 'git push origin main' },
        { ...ctx, approve: async () => true },
      ),
    /blocked by a deny rule/,
  )
})

test('shell tool allow rule cannot be smuggled around by a compound command', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-perm-'))
  scratchDirs.push(root)
  const ctx: ToolContext = { root, log: () => {} }
  const tool = createShellTool({ rules: parseRules({ allow: ['ls *'] }) })

  let asked = 0
  await assert.rejects(
    async () =>
      await tool.execute(
        { command: 'ls && rm x' },
        { ...ctx, approve: async () => { asked++; return false } },
      ),
    /denied by user/,
  )
  assert.equal(asked, 1, 'the risky part must still reach the approver')
})
