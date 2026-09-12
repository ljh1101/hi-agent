#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import process from 'node:process'
import { Agent } from './agent.ts'
import { LLMError, OpenAICompatibleLLM } from './llm.ts'
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
      --api-key <key>      API key (default: $AGENT_API_KEY / $OPENAI_API_KEY / $DEEPSEEK_API_KEY)
      --max-steps <n>      max model round-trips per turn (default: 12)
      --system <text>      override the system prompt
      --root <dir>         workspace root tools may touch (default: cwd)
  -v, --verbose            show model narration and full tool output
  -h, --help               show this help

In-session commands: /reset clears history, exit or quit leaves.

Examples:
  hi-agent "What time is it, and what is 23 * 17?"
  hi-agent --root ./sandbox "List the files and summarize what this project does"
`

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { verbose: false, help: false }
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

interface ResolvedConfig {
  apiKey: string | undefined
  baseURL: string
  model: string
}

function resolveConfig(options: CliOptions): ResolvedConfig {
  const env = process.env
  const deepSeek = !env.OPENAI_API_KEY && Boolean(env.DEEPSEEK_API_KEY)
  return {
    apiKey: options.apiKey ?? env.AGENT_API_KEY ?? env.OPENAI_API_KEY ?? env.DEEPSEEK_API_KEY,
    baseURL:
      options.baseURL ??
      env.AGENT_BASE_URL ??
      env.OPENAI_BASE_URL ??
      (deepSeek ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'),
    model: options.model ?? env.AGENT_MODEL ?? env.OPENAI_MODEL ?? (deepSeek ? 'deepseek-chat' : 'gpt-4o-mini'),
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

async function repl(agent: Agent, verbose: boolean): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('hi-agent interactive mode. Commands: /reset, exit. Ctrl+C quits.')
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

  const config = resolveConfig(options)
  if (!config.apiKey) {
    console.error(color(RED, 'error: no API key found.'))
    console.error('Set AGENT_API_KEY (or OPENAI_API_KEY / DEEPSEEK_API_KEY), or copy .env.example to .env.')
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
    root: options.root ?? process.cwd(),
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

  await repl(agent, verbose)
}

void main()
