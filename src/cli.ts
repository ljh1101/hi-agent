#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import process from 'node:process'
import { Agent } from './agent.ts'
import { globalConfigDir, loadGlobalConfig, resolveConfig, saveGlobalConfig } from './config.ts'
import type { HiAgentConfig } from './config.ts'
import { LLMError, OpenAICompatibleLLM } from './llm.ts'
import { listModels, PROVIDERS } from './providers.ts'
import { createDefaultTools } from './tools/index.ts'
import type { AgentEvent } from './types.ts'

interface CliOptions {
  prompt?: string
  model?: string
  baseURL?: string
  apiKey?: string
  maxSteps?: number
  systemPrompt?: string
  root?: string
  setup: boolean
  listProviders: boolean
  verbose: boolean
  help: boolean
}

const HELP = `hi-agent - a minimal general-purpose agent

Usage:
  hi-agent [options] [prompt]      run one turn and exit
  hi-agent [options]               start an interactive session

Options:
  -m, --model <name>       model id (default: $AGENT_MODEL or gpt-4o-mini)
      --base-url <url>     OpenAI-compatible base URL (default: $AGENT_BASE_URL)
      --api-key <key>      API key (default: $AGENT_API_KEY / global config / $OPENAI_API_KEY / $DEEPSEEK_API_KEY)
      --max-steps <n>      max model round-trips per turn (default: 12)
      --system <text>      override the system prompt
      --root <dir>         workspace root tools may touch (default: cwd)
      --setup              (re)run the interactive provider + key setup
      --list-providers     print the provider presets and exit
  -v, --verbose            show model narration and full tool output
  -h, --help               show this help

On first run with no key, hi-agent asks for your provider (so it knows the
right base URL and model), then your key, and saves both to your home dir
(~/.config/hi-agent/config.json, written 0600). A project may add a
hi-agent.json next to --root for shareable, secret-free defaults
(baseUrl/model) that get committed with the repo.

In-session commands: /reset clears history, /model switches model (or /model <id>), exit or quit leaves.

Examples:
  hi-agent "What time is it, and what is 23 * 17?"
  hi-agent --root ./sandbox "List the files and summarize what this project does"
`

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { setup: false, listProviders: false, verbose: false, help: false }
  const positional: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    const next = (): string => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`Option ${arg} requires a value`)
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--verbose':
        options.verbose = true
        break
      case '--setup':
        options.setup = true
        break
      case '--list-providers':
        options.listProviders = true
        break
      case '-m':
      case '--model':
        options.model = next()
        break
      case '--base-url':
        options.baseURL = next()
        break
      case '--api-key':
        options.apiKey = next()
        break
      case '--system':
        options.systemPrompt = next()
        break
      case '--root':
        options.root = next()
        break
      case '--max-steps': {
        const raw = next()
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`--max-steps must be a positive integer, got "${raw}"`)
        }
        options.maxSteps = value
        break
      }
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option: ${arg}`)
        positional.push(arg)
        break
    }
  }

  if (positional.length > 0) options.prompt = positional.join(' ')
  return options
}

function loadDotEnv(): void {
  const loader = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile
  if (typeof loader !== 'function') return
  try {
    loader.call(process, '.env')
  } catch {
    // No .env file: environment variables are used as-is.
  }
}

const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const RESET = '\u001b[0m'

function color(code: string, text: string): string {
  return process.stdout.isTTY ? `${code}${text}${RESET}` : text
}

function oneLine(text: string, max = 100): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return line.length > max ? `${line.slice(0, max)}...` : line
}

function renderEvent(event: AgentEvent, verbose: boolean): void {
  switch (event.type) {
    case 'step':
      if (verbose) console.log(color(DIM, `[step ${event.step}]`))
      break
    case 'assistant':
      if (verbose && event.content.trim() !== '') {
        console.log(color(DIM, `[model] ${event.content.trim()}`))
      }
      break
    case 'tool_call':
      console.log(`${color(CYAN, '->')} ${event.name}(${oneLine(JSON.stringify(event.args), 120)})`)
      break
    case 'tool_result': {
      const mark = event.isError ? color(RED, '!!') : color(GREEN, 'ok')
      const body = verbose ? event.result : oneLine(event.result)
      console.log(`${mark} ${body} ${color(DIM, `(${event.durationMs}ms)`)}`)
      break
    }
    case 'log':
      console.log(color(DIM, `[log] ${event.message}`))
      break
    case 'max_steps':
      console.log(color(RED, `stopped: hit the ${event.steps}-step limit`))
      break
    case 'final':
      break
  }
}

function printError(error: unknown): void {
  if (error instanceof LLMError) {
    console.error(color(RED, `model error: ${error.message}`))
    if (error.status === 401 || error.status === 403) {
      console.error('hint: the API key was rejected. Check AGENT_API_KEY (or --api-key).')
    } else if (error.status === 404) {
      console.error('hint: check AGENT_BASE_URL (it must include the version segment, e.g. /v1) and AGENT_MODEL.')
    } else if (error.status === 429) {
      console.error('hint: rate limited or out of quota; retry shortly.')
    }
    return
  }
  console.error(color(RED, `error: ${error instanceof Error ? error.message : String(error)}`))
}

interface SessionConfig {
  agent: Agent
  verbose: boolean
  baseURL: string
  apiKey: string
  model: string
  root: string
}

async function repl(session: SessionConfig): Promise<void> {
  const { agent, verbose } = session
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('hi-agent interactive mode. Commands: /reset, /model, exit. Ctrl+C quits.')
  try {
    for (;;) {
      let line: string
      try {
        line = await rl.question(color(CYAN, '\n> '))
      } catch {
        break // stdin closed or Ctrl+C
      }
      const input = line.trim()
      if (input === '') continue
      if (input === 'exit' || input === 'quit' || input === ':q') break
      if (input === '/reset') {
        agent.reset()
        console.log(color(DIM, '(history cleared)'))
        continue
      }
      if (input === '/model' || input.startsWith('/model ')) {
        await switchModel(session, rl, input.slice('/model'.length).trim())
        continue
      }
      try {
        const result = await agent.run(input)
        if (result.stopReason === 'final') console.log(`\n${result.content}`)
      } catch (error) {
        printError(error)
      }
    }
  } finally {
    rl.close()
  }
  if (verbose) console.log(color(DIM, 'bye'))
}

async function switchModel(session: SessionConfig, rl: ReturnType<typeof createInterface>, preset: string): Promise<void> {
  let model: string
  if (preset !== '') {
    model = preset
  } else {
    console.log(color(DIM, `Discovering models from ${session.baseURL}/models ...`))
    try {
      const models = await listModels(session.baseURL, session.apiKey)
      if (models.length === 0) throw new Error('provider returned no models')
      console.log('Available models:')
      for (const [index, id] of models.entries()) console.log(`  ${index + 1}. ${id}`)
      const choice = (await rl.question('Pick a model number: ')).trim()
      const index = Number(choice)
      model = models[Number.isInteger(index) ? index - 1 : -1] ?? ''
      if (!model) {
        console.log(color(RED, 'Unknown model.'))
        return
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.log(color(RED, `Could not list models (${reason}).`))
      return
    }
  }

  session.agent.setLLM(
    new OpenAICompatibleLLM({ apiKey: session.apiKey, baseURL: session.baseURL, model }),
  )
  session.model = model
  await saveGlobalConfig({ model }, globalConfigDir())
  console.log(color(GREEN, `Switched to ${model}.`))
}

function printProviders(): void {
  console.log('Provider presets (OpenAI-compatible endpoints):')
  for (const [index, provider] of PROVIDERS.entries()) {
    console.log(`  ${index + 1}. ${provider.label.padEnd(16)} ${provider.baseURL}`)
  }
  console.log(`  0. Custom — enter base URL and model yourself`)
}

async function pickModel(baseURL: string, apiKey: string, suggested: string, rl: ReturnType<typeof createInterface>): Promise<string> {
  console.log(color(DIM, `Discovering models from ${baseURL}/models ...`))
  try {
    const models = await listModels(baseURL, apiKey)
    if (models.length === 0) throw new Error('provider returned no models')
    console.log('Available models:')
    for (const [index, id] of models.entries()) {
      console.log(`  ${index + 1}. ${id}`)
    }
    const choice = (await rl.question(`Pick a model number (default: ${suggested}): `)).trim()
    if (choice === '') return suggested
    const index = Number(choice)
    const picked = models[Number.isInteger(index) ? index - 1 : -1]
    if (!picked) throw new Error(`Unknown model "${choice}"`)
    return picked
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.log(color(DIM, `Could not list models (${reason}); falling back to manual entry.`))
    const entered = (await rl.question(`Model id (default: ${suggested}): `)).trim()
    return entered === '' ? suggested : entered
  }
}

async function setupFirstRun(force = false): Promise<HiAgentConfig | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined
  const dir = globalConfigDir()
  const existing = await loadGlobalConfig(dir)
  if (!force && existing.apiKey) return existing

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(color(CYAN, 'No provider configured yet. Let me set that up once (saved to your home dir, not the repo).'))
    printProviders()

    const choice = (await rl.question('Pick a provider number: ')).trim()
    let baseURL: string
    let suggested: string

    if (choice === '0') {
      baseURL = (await rl.question('Base URL (include /v1): ')).trim()
      suggested = ''
      if (!baseURL) {
        console.log(color(RED, 'Setup cancelled: base URL is required.'))
        return undefined
      }
    } else {
      const index = Number(choice)
      const provider = PROVIDERS[Number.isInteger(index) ? index - 1 : -1]
      if (!provider) {
        console.log(color(RED, `Unknown provider "${choice}".`))
        return undefined
      }
      baseURL = provider.baseURL
      suggested = provider.suggestedModel
    }

    const key = (await rl.question('API key: ')).trim()
    if (!key) {
      console.log(color(RED, 'Setup cancelled: API key is required.'))
      return undefined
    }

    const model = await pickModel(baseURL, key, suggested, rl)
    if (!model) {
      console.log(color(RED, 'Setup cancelled: model is required.'))
      return undefined
    }

    const saved: HiAgentConfig = { apiKey: key, baseURL, model }
    await saveGlobalConfig(saved, dir)
    console.log(color(DIM, `Saved to ${dir}/config.json (0600).`))
    return saved
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  loadDotEnv()

  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(color(RED, `error: ${error instanceof Error ? error.message : String(error)}`))
    console.error('run "hi-agent --help" for usage')
    process.exitCode = 1
    return
  }

  if (options.help) {
    console.log(HELP)
    return
  }

  if (options.listProviders) {
    printProviders()
    return
  }

  const root = options.root ?? process.cwd()
  const config = await resolveConfig(options, { root })

  if (options.setup || !config.apiKey) {
    const saved = await setupFirstRun(options.setup)
    if (saved) {
      config.apiKey = saved.apiKey
      config.baseURL = saved.baseURL ?? config.baseURL
      config.model = saved.model ?? config.model
    }
  }

  if (!config.apiKey) {
    console.error(color(RED, 'error: no API key found.'))
    console.error('Set AGENT_API_KEY (or OPENAI_API_KEY / DEEPSEEK_API_KEY), or run `hi-agent --setup` to configure a provider.')
    console.error('To see the agent loop run without a key, try: npm run demo')
    process.exitCode = 1
    return
  }

  const verbose = options.verbose
  const agent = new Agent({
    llm: new OpenAICompatibleLLM({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
    }),
    tools: createDefaultTools(),
    root,
    maxSteps: options.maxSteps ?? 12,
    systemPrompt: options.systemPrompt,
    onEvent: (event) => renderEvent(event, verbose),
  })

  if (options.prompt !== undefined) {
    try {
      const result = await agent.run(options.prompt)
      if (result.stopReason === 'final') console.log(`\n${result.content}`)
      else process.exitCode = 1
    } catch (error) {
      printError(error)
      process.exitCode = 1
    }
    return
  }

  await repl({
    agent,
    verbose,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    root,
  })
}

void main()
