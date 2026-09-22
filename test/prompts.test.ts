import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDefaultSystemPrompt,
  buildToolsSection,
  DEFAULT_SYSTEM_PROMPT,
} from '../src/prompts/system.ts'

test('buildToolsSection lists snippets and merges de-duplicated guidelines', () => {
  const section = buildToolsSection([
    { name: 'alpha', promptSnippet: 'does alpha things', promptGuidelines: ['prefer alpha over beta', 'shared rule'] },
    { name: 'beta', promptGuidelines: ['shared rule', 'beta-only rule'] },
  ])

  assert.match(section, /# Tools/)
  assert.match(section, /- alpha: does alpha things/)
  assert.match(section, /- beta\n/) // no snippet: bare name, no colon artifact
  assert.match(section, /- prefer alpha over beta/)
  assert.match(section, /- beta-only rule/)
  // The shared rule appears exactly once.
  assert.equal(section.match(/shared rule/g)?.length, 1)
})

test('buildToolsSection returns empty string with no tools', () => {
  assert.equal(buildToolsSection([]), '')
})

test('buildDefaultSystemPrompt assembles identity, tools and rules', () => {
  const prompt = buildDefaultSystemPrompt([
    { name: 'grep', promptSnippet: 'search file contents' },
  ])
  assert.match(prompt, /You are hi-agent/)
  assert.match(prompt, /# Tools\n- grep: search file contents/)
  assert.match(prompt, /# Rules\n- Never guess/)
  // With no tools, the tools section is skipped entirely.
  const bare = buildDefaultSystemPrompt([])
  assert.ok(!bare.includes('# Tools'))
})

test('DEFAULT_SYSTEM_PROMPT is the no-tools variant', () => {
  assert.equal(DEFAULT_SYSTEM_PROMPT, buildDefaultSystemPrompt([]))
  assert.match(DEFAULT_SYSTEM_PROMPT, /# Rules/)
})
