import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  globalConfigDir,
  loadGlobalConfig,
  loadProjectConfig,
  projectConfigFile,
  resolveConfig,
  saveGlobalConfig,
} from '../src/config.ts'
import { findProvider, listModels, PROVIDERS } from '../src/providers.ts'

const scratchDirs: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-config-'))
  scratchDirs.push(root)
  return root
}

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test('globalConfigDir honours HI_AGENT_CONFIG_DIR', () => {
  assert.equal(globalConfigDir({ HI_AGENT_CONFIG_DIR: '/tmp/x' }), '/tmp/x')
})

test('saveGlobalConfig writes 0600 and preserves existing keys', async () => {
  const dir = await makeRoot()
  await saveGlobalConfig({ apiKey: 'sk-first', model: 'm1' }, dir)

  const first = await loadGlobalConfig(dir)
  assert.equal(first.apiKey, 'sk-first')
  assert.equal(first.model, 'm1')

  // A second write that only sets baseURL must keep apiKey and model.
  await saveGlobalConfig({ baseURL: 'https://example.com/v1' }, dir)
  const second = await loadGlobalConfig(dir)
  assert.equal(second.apiKey, 'sk-first')
  assert.equal(second.model, 'm1')
  assert.equal(second.baseURL, 'https://example.com/v1')

  // POSIX permission bits only exist on POSIX: Windows reports 0o666 for every
  // writable file, so the assertion would fail for reasons unrelated to config.
  if (process.platform !== 'win32') {
    const mode = (await stat(path.join(dir, 'config.json'))).mode & 0o777
    assert.equal(mode, 0o600)
  }
})

test('loadGlobalConfig returns an empty object when the file is absent', async () => {
  const dir = await makeRoot()
  assert.deepEqual(await loadGlobalConfig(dir), {})
  assert.equal(globalConfigDir({ HI_AGENT_CONFIG_DIR: dir }), dir)
})

test('loadProjectConfig reads hi-agent.json from the root', async () => {
  const root = await makeRoot()
  await writeFile(projectConfigFile(root), '{ "model": "gpt-4o", "baseURL": "https://x/v1" }')
  const config = await loadProjectConfig(root)
  assert.equal(config.model, 'gpt-4o')
  assert.equal(config.baseURL, 'https://x/v1')
  assert.equal(config.apiKey, undefined)
})

test('resolveConfig layers CLI > env > project > global', async () => {
  const root = await makeRoot()
  const emptyRoot = await makeRoot()
  const dir = await makeRoot()
  await writeFile(projectConfigFile(root), '{ "model": "project-model" }')
  await saveGlobalConfig({ apiKey: 'global-key', model: 'global-model' }, dir)

  // Global config alone supplies the defaults (no project file present).
  const fromGlobal = await resolveConfig({}, { root: emptyRoot, globalDir: dir, env: {} })
  assert.equal(fromGlobal.apiKey, 'global-key')
  assert.equal(fromGlobal.model, 'global-model')
  assert.equal(fromGlobal.baseURL, 'https://api.openai.com/v1')

  // Project config beats global for shared, non-secret fields.
  const fromProject = await resolveConfig({}, { root, globalDir: dir, env: {} })
  assert.equal(fromProject.model, 'project-model')

  // Environment beats both.
  const fromEnv = await resolveConfig({}, {
    root,
    globalDir: dir,
    env: { AGENT_API_KEY: 'env-key', AGENT_MODEL: 'env-model' },
  })
  assert.equal(fromEnv.apiKey, 'env-key')
  assert.equal(fromEnv.model, 'env-model')

  // CLI flags beat everything.
  const fromCli = await resolveConfig(
    { apiKey: 'cli-key', model: 'cli-model' },
    { root, globalDir: dir, env: { AGENT_API_KEY: 'env-key' } },
  )
  assert.equal(fromCli.apiKey, 'cli-key')
  assert.equal(fromCli.model, 'cli-model')
})

test('resolveConfig falls back to DeepSeek defaults when only DEEPSEEK_API_KEY is set', async () => {
  const root = await makeRoot()
  const dir = await makeRoot()
  const config = await resolveConfig({}, { root, globalDir: dir, env: { DEEPSEEK_API_KEY: 'ds-key' } })
  assert.equal(config.apiKey, 'ds-key')
  assert.equal(config.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(config.model, 'deepseek-chat')
})

test('resolveConfig does not assume DeepSeek when a higher-precedence key is set', async () => {
  const root = await makeRoot()
  const dir = await makeRoot()
  // AGENT_API_KEY wins as the key, so DeepSeek defaults must NOT kick in.
  const config = await resolveConfig({}, {
    root,
    globalDir: dir,
    env: { AGENT_API_KEY: 'openai-key', DEEPSEEK_API_KEY: 'ds-key' },
  })
  assert.equal(config.apiKey, 'openai-key')
  assert.equal(config.baseURL, 'https://api.openai.com/v1')
  assert.equal(config.model, 'gpt-4o-mini')
})

test('resolveConfig rejects a project config that is not valid JSON', async () => {
  const root = await makeRoot()
  const globalDir = await makeRoot()
  await writeFile(projectConfigFile(root), '{ not json')
  await assert.rejects(
    () => resolveConfig({}, { root, globalDir, env: {} }),
    /not valid JSON/,
  )
})

test('resolveConfig rejects a project config that is not an object', async () => {
  const root = await makeRoot()
  const globalDir = await makeRoot()
  await writeFile(projectConfigFile(root), '[1,2,3]')
  await assert.rejects(
    () => resolveConfig({}, { root, globalDir, env: {} }),
    /must contain a JSON object/,
  )
})

test('the real content of a global config file round-trips', async () => {
  const root = await makeRoot()
  const dir = await makeRoot()
  await saveGlobalConfig({ apiKey: 'sk-abc' }, dir)
  assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), '{\n  "apiKey": "sk-abc"\n}\n')
})

test('provider presets carry a base URL and a suggested model', () => {
  assert.ok(PROVIDERS.length > 0)
  for (const provider of PROVIDERS) {
    assert.ok(provider.baseURL.startsWith('http'), `${provider.id} has a valid base URL`)
    assert.ok(provider.suggestedModel.length > 0, `${provider.id} has a suggested model`)
  }
  assert.equal(findProvider('deepseek')?.baseURL, 'https://api.deepseek.com/v1')
  assert.equal(findProvider('deepseek')?.suggestedModel, 'deepseek-chat')
  assert.equal(findProvider('nope'), undefined)
})

test('listModels fetches and sorts ids from a /models response', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch

  const models = await listModels('https://api.openai.com/v1', 'sk-test', fakeFetch)
  assert.deepEqual(models, ['gpt-4o', 'gpt-4o-mini'])
})

test('listModels throws on a non-2xx or malformed response', async () => {
  const fail = (async () => new Response('nope', { status: 401 })) as typeof globalThis.fetch
  await assert.rejects(() => listModels('https://x/v1', 'sk', fail), /HTTP 401/)

  const malformed = (async () =>
    new Response(JSON.stringify({ notData: true }), { status: 200 })) as typeof globalThis.fetch
  await assert.rejects(() => listModels('https://x/v1', 'sk', malformed), /Unexpected/)
})

test('listModels passes an abort signal so a hanging endpoint can be cancelled', async () => {
  let seenSignal: AbortSignal | undefined
  const hang = (async (_url: string, init?: RequestInit) => {
    seenSignal = init?.signal as AbortSignal | undefined
    return new Promise<Response>(() => {})
  }) as typeof globalThis.fetch

  // The promise never settles, but we only check the signal was wired up.
  const pending = listModels('https://x/v1', 'sk', hang, 50)
  assert.ok(seenSignal, 'an abort signal should be passed to fetch')
  seenSignal!.addEventListener('abort', () => seenSignal!.reason, { once: true })
  // Assert the timeout signal is active before we abandon the pending request.
  assert.ok(!seenSignal!.aborted)
  pending.catch(() => {})
})