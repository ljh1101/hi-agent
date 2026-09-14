/**
 * Configuration loading with a global-vs-project split, following the same
 * pattern as opencode and dsh: secrets live in a per-user global file that is
 * never committed, while the project can carry a shareable (secret-free)
 * config that travels with the repository.
 *
 * Precedence, highest to lowest:
 *   CLI flags > environment variables > project config > global config
 *
 * Global config lives at `~/.config/hi-agent/config.json` (platform-aware) and
 * is written `0600`; it holds the API key and any personal defaults. The
 * project config is `<root>/hi-agent.json` and is meant to hold only
 * non-secret defaults (base URL, model), so it is safe to commit.
 */

import { homedir } from 'node:os'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface HiAgentConfig {
  apiKey?: string
  baseURL?: string
  model?: string
}

export interface ConfigOverride {
  apiKey?: string
  baseURL?: string
  model?: string
}

export interface ResolvedConfig {
  apiKey: string | undefined
  baseURL: string
  model: string
}

const CONFIG_FILE_NAME = 'config.json'
const PROJECT_CONFIG_FILE_NAME = 'hi-agent.json'

/** Directory holding the per-user global config. */
export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HI_AGENT_CONFIG_DIR
  if (override) return override
  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'hi-agent')
    case 'win32':
      return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'hi-agent')
    default:
      return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'hi-agent')
  }
}

export function globalConfigFile(dir: string = globalConfigDir()): string {
  return path.join(dir, CONFIG_FILE_NAME)
}

export function projectConfigFile(root: string): string {
  return path.join(root, PROJECT_CONFIG_FILE_NAME)
}

function parseConfigFile(text: string, source: string): HiAgentConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Config file ${source} is not valid JSON (${reason})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${source} must contain a JSON object`)
  }
  return parsed as HiAgentConfig
}

async function readConfigFile(file: string): Promise<HiAgentConfig> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw error
  }
  return parseConfigFile(text, file)
}

/** Load the per-user global config (empty object if absent). */
export async function loadGlobalConfig(
  dir: string = globalConfigDir(),
): Promise<HiAgentConfig> {
  return readConfigFile(globalConfigFile(dir))
}

/** Load the project config from the workspace root (empty object if absent). */
export async function loadProjectConfig(root: string): Promise<HiAgentConfig> {
  return readConfigFile(projectConfigFile(root))
}

/**
 * Merge a new config fragment into the global config file, creating it with
 * `0600` permissions the first time. Never clobbers keys it is not given.
 */
export async function saveGlobalConfig(
  patch: HiAgentConfig,
  dir: string = globalConfigDir(),
): Promise<string> {
  const file = globalConfigFile(dir)
  await mkdir(dir, { recursive: true })
  const existing = await loadGlobalConfig(dir)
  const merged: HiAgentConfig = { ...existing, ...patch }
  const payload = JSON.stringify(merged, null, 2)
  await writeFile(file, `${payload}\n`, 'utf8')
  await chmod(file, 0o600).catch(() => {})
  return file
}

/** Pick the best value across CLI flag, environment and file layers. */
function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== '')
}

/**
 * Resolve the final configuration. Mirrors the previous CLI-only logic, with
 * the file layers inserted between the environment and the built-in defaults.
 */
export async function resolveConfig(
  override: ConfigOverride,
  options: {
    root: string
    env?: NodeJS.ProcessEnv
    globalDir?: string
  } = { root: process.cwd() },
): Promise<ResolvedConfig> {
  const env = options.env ?? process.env
  const project = await loadProjectConfig(options.root)
  const global = await loadGlobalConfig(options.globalDir)

  const deepSeek = !env.OPENAI_API_KEY && Boolean(env.DEEPSEEK_API_KEY)

  const apiKey = firstDefined(
    override.apiKey,
    env.AGENT_API_KEY,
    env.OPENAI_API_KEY,
    env.DEEPSEEK_API_KEY,
    project.apiKey,
    global.apiKey,
  )

  const baseURL = firstDefined(
    override.baseURL,
    env.AGENT_BASE_URL,
    env.OPENAI_BASE_URL,
    project.baseURL,
    global.baseURL,
  ) ?? (deepSeek ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1')

  const model = firstDefined(
    override.model,
    env.AGENT_MODEL,
    env.OPENAI_MODEL,
    project.model,
    global.model,
  ) ?? (deepSeek ? 'deepseek-chat' : 'gpt-4o-mini')

  return { apiKey, baseURL, model }
}
