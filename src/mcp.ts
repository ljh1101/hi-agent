import { spawn, type ChildProcess } from 'node:child_process'
import process from 'node:process'
import type { McpServerConfig } from './config.ts'
import type { JsonSchema, Tool } from './types.ts'

/**
 * MCP client over stdio (roadmap item 7).
 *
 * MCP over stdio is newline-delimited JSON-RPC between the agent and a child
 * process — the same process management `shell.ts` already does, with no SDK,
 * no runtime dependency, and none of the dynamic imports AGENTS.md forbids.
 *
 * Trust model, stated plainly: an MCP server is arbitrary third-party code
 * running with the user's rights — the same trust class as the shell. Every
 * MCP tool call therefore requires approval unless the tool is allow-listed
 * in that server's config (`allow`). The environment handed to a server is
 * the program-lookup names the OS needs plus the config's explicit `env` map;
 * `process.env` is never spread (CWE-526, the same rule as `childEnv()`).
 *
 * Failures normalize: a JSON-RPC error, a crashed server, an `isError` result,
 * a timeout and a cancellation all surface as thrown errors, which the agent
 * turns into `Error: ...` observations like any other tool.
 */

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'hi-agent', version: '0.1.0' }
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000
const MAX_STDERR_TAIL = 2_000

export interface McpHubOptions {
  /** Per-request timeout for protocol calls (initialize, tools/list). */
  timeoutMs?: number
  /** Per-tool-call timeout. */
  callTimeoutMs?: number
  /** Progress sink (server up/down, tool counts). Goes to the UI only. */
  log?: (message: string) => void
}

/**
 * Environment names a child MCP server receives besides the config's explicit
 * `env` map: the program-lookup facts the OS needs to spawn anything. No
 * credentials, no spread of `process.env` — an explicit map only, on top of
 * these (explicit values win).
 */
const MCP_CHILD_ENV_NAMES: readonly string[] = [
  'PATH',
  'Path',
  'PATHEXT',
  'COMSPEC',
  'SystemRoot',
  'SystemDrive',
  'windir',
]

function mcpChildEnv(explicit: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of MCP_CHILD_ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  if (explicit) {
    for (const [key, value] of Object.entries(explicit)) env[key] = value
  }
  return env
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  onAbort?: () => void
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  result?: unknown
  error?: { code?: number; message?: string }
}

interface McpToolSpec {
  name?: unknown
  description?: unknown
  inputSchema?: unknown
}

interface McpCallResult {
  content?: Array<{ type?: unknown; text?: unknown }>
  isError?: boolean
}

/** One connected MCP server. Requests are matched to responses by id. */
export class McpClient {
  private child: ChildProcess | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private buffer = ''
  private stderrTail = ''
  private exitError: Error | undefined
  private readonly serverName: string
  private readonly spec: McpServerConfig
  private readonly options: McpHubOptions

  constructor(serverName: string, spec: McpServerConfig, options: McpHubOptions = {}) {
    this.serverName = serverName
    this.spec = spec
    this.options = options
  }

  /** Spawn the server and run the initialize handshake. */
  async start(): Promise<void> {
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: mcpChildEnv(this.spec.env),
    })
    this.child = child

    child.on('error', (error) => {
      this.failAll(new Error(`MCP server "${this.serverName}" failed to start: ${error.message}`))
    })
    child.on('exit', (code, signalName) => {
      const tail = this.stderrTail.trim()
      this.exitError = new Error(
        `MCP server "${this.serverName}" exited (code ${code ?? signalName}).` +
          (tail !== '' ? ` stderr: ${tail}` : ''),
      )
      this.failAll(this.exitError)
    })
    child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL)
    })

    try {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      })
    } catch (error) {
      this.close()
      throw error
    }
    // The spec requires this notification before any other call; no response.
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<Array<McpToolSpec & { name: string }>> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolSpec[] } | undefined
    const tools = Array.isArray(result?.tools) ? result?.tools : []
    return tools.filter(
      (tool): tool is McpToolSpec & { name: string } =>
        tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && tool.name !== '',
    )
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = (await this.request(
      'tools/call',
      { name, arguments: args },
      this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      signal,
    )) as McpCallResult | undefined
    const text = contentToText(result?.content)
    if (result?.isError === true) {
      throw new Error(text === '' ? `MCP tool "${name}" reported an error` : text)
    }
    return text === '' ? '(no output)' : text
  }

  /** Kill the server process; pending requests fail with a diagnostic. */
  close(): void {
    this.child?.kill()
  }

  private feed(text: string): void {
    this.buffer += text
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch {
        continue // not protocol output; the spec sends logs to stderr
      }
      this.absorb(message)
    }
  }

  private absorb(message: JsonRpcMessage): void {
    // Only responses carry a numeric id plus result/error; server-initiated
    // requests and notifications are out of scope for this client.
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (pending.onAbort) this.child?.stdin?.off?.('close', pending.onAbort)
    if (message.error) {
      const detail = message.error.message ?? `code ${message.error.code ?? '?'}`
      pending.reject(new Error(`MCP server "${this.serverName}" error: ${detail}`))
    } else {
      pending.resolve(message.result)
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private notify(method: string): void {
    this.send({ jsonrpc: '2.0', method })
  }

  private request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(this.exitError ?? new Error(`MCP server "${this.serverName}" is not running`))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`MCP server "${this.serverName}" timed out after ${timeoutMs}ms on ${method}`))
        }, timeoutMs),
      }
      if (signal) {
        if (signal.aborted) {
          clearTimeout(pending.timer)
          reject(new Error('the MCP call was cancelled'))
          return
        }
        pending.onAbort = () => {
          this.pending.delete(id)
          clearTimeout(pending.timer)
          reject(new Error('the MCP call was cancelled'))
        }
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.pending.set(id, pending)
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        const reason = error instanceof Error ? error.message : String(error)
        reject(new Error(`MCP server "${this.serverName}" write failed: ${reason}`))
      }
    })
  }

  private send(message: JsonRpcMessage): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`)
  }
}

function contentToText(content: McpCallResult['content']): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else {
      const kind = item !== null && typeof item === 'object' && typeof item.type === 'string' ? item.type : 'unknown'
      parts.push(`[non-text content: ${kind}]`)
    }
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// The tool source: discovered tools as `mcp__<server>__<tool>`
// ---------------------------------------------------------------------------

/**
 * MCP tools' `inputSchema` is a full JSON Schema; ours is the object subset.
 * A schema that is not a typed object is replaced by an empty object schema —
 * the model then sends `{}` arguments, which is honest about knowing nothing.
 */
function normalizeMcpSchema(inputSchema: unknown): JsonSchema {
  if (
    inputSchema !== null &&
    typeof inputSchema === 'object' &&
    (inputSchema as { type?: unknown }).type === 'object' &&
    typeof (inputSchema as { properties?: unknown }).properties === 'object'
  ) {
    return inputSchema as JsonSchema
  }
  return { type: 'object', properties: {}, additionalProperties: true }
}

function wrapMcpTool(server: string, client: McpClient, spec: McpToolSpec & { name: string }, allow: readonly string[]): Tool {
  const name = `mcp__${server}__${spec.name}`
  return {
    name,
    description:
      typeof spec.description === 'string' && spec.description.trim() !== ''
        ? spec.description
        : `MCP tool "${spec.name}" on server "${server}" (no description provided).`,
    parameters: normalizeMcpSchema(spec.inputSchema),
    // MCP tools are arbitrary third-party code: never run two concurrently.
    concurrency: 'serial',
    async execute(args, ctx) {
      const allowed = allow.includes(spec.name)
      if (!allowed) {
        if (!ctx.approve) {
          throw new Error(
            `MCP tool "${name}" requires approval — MCP servers run third-party code with ` +
              'user rights — but no approver is configured. Allow-list it in the server config ' +
              '(`allow`) or run with an approver.',
          )
        }
        const ok = await ctx.approve(`Call MCP tool ${name} on server "${server}"`)
        if (!ok) {
          throw new Error('MCP tool call denied by user. Do not retry it; ask the user instead.')
        }
      }
      return client.callTool(spec.name, args as Record<string, unknown>, ctx.signal)
    },
  }
}

export interface McpServerEntry {
  name: string
  client: McpClient
  toolCount: number
}

/**
 * Owns one client per configured server and exposes the discovered tools as a
 * `ToolSource` (`list(): Promise<Tool[]>`). A server that fails to start or
 * handshake is logged and skipped — one broken server must not take the rest
 * of the toolset down; calls into a dead server later become observations.
 */
export class McpHub {
  private readonly connected: McpServerEntry[] = []
  private readonly tools: Tool[] = []

  private readonly servers: Record<string, McpServerConfig>
  private readonly options: McpHubOptions

  constructor(servers: Record<string, McpServerConfig>, options: McpHubOptions = {}) {
    this.servers = servers
    this.options = options
  }

  /** Connect every configured server; per-server failures are logged, not fatal. */
  async connect(): Promise<void> {
    for (const [name, spec] of Object.entries(this.servers)) {
      if (!spec || typeof spec.command !== 'string' || spec.command.trim() === '') {
        this.log(`MCP server "${name}": no command configured, skipped`)
        continue
      }
      const client = new McpClient(name, spec, this.options)
      try {
        await client.start()
        const specs = await client.listTools()
        const allow = Array.isArray(spec.allow) ? spec.allow.filter((entry): entry is string => typeof entry === 'string') : []
        for (const toolSpec of specs) {
          this.tools.push(wrapMcpTool(name, client, toolSpec, allow))
        }
        this.connected.push({ name, client, toolCount: specs.length })
        this.log(`MCP server "${name}" connected: ${specs.length} tool(s)${allow.length > 0 ? `, ${allow.length} allow-listed` : ''}`)
      } catch (error) {
        client.close()
        const reason = error instanceof Error ? error.message : String(error)
        this.log(`MCP server "${name}" unavailable: ${reason}`)
      }
    }
  }

  /** The ToolSource seam: the registry asks the hub for its tools. */
  list(): Promise<Tool[]> {
    return Promise.resolve([...this.tools])
  }

  entries(): McpServerEntry[] {
    return [...this.connected]
  }

  connectedCount(): number {
    return this.connected.length
  }

  /** Kill every connected server. Call on CLI exit, next to flushSessions(). */
  close(): void {
    for (const entry of this.connected) entry.client.close()
  }

  private log(message: string): void {
    this.options.log?.(message)
  }
}
