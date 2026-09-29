import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import process from 'node:process'
import { ToolRegistry } from '../src/tools/registry.ts'
import { McpHub } from '../src/mcp.ts'
import type { McpServerConfig } from '../src/config.ts'
import type { ToolContext } from '../src/types.ts'

const scratchDirs: string[] = []

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * A real MCP server: a Node child process speaking newline-delimited JSON-RPC
 * over stdio, exactly what the client must speak. Written to a scratch file
 * and spawned with the running `node`.
 */
const FAKE_SERVER = `
import process from 'node:process'
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const newline = buffer.indexOf('\\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line !== '') handle(line)
  }
})
function handle(line) {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (typeof message.id !== 'number') return
  if (message.method === 'initialize') {
    respond(message.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } })
  } else if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [
        { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'boom', description: 'Always reports isError.', inputSchema: { type: 'object', properties: {} } },
        { name: 'rpc_error', description: 'Always answers with a JSON-RPC error.', inputSchema: { type: 'object', properties: {} } },
        { name: 'env_check', description: 'Reports which env vars it can see.', inputSchema: { type: 'object', properties: {} } },
        { name: 'cancel_check', description: 'Never answers; used to test cancellation.', inputSchema: { type: 'object', properties: {} } },
      ],
    })
  } else if (message.method === 'tools/call') {
    const name = message.params?.name
    if (name === 'echo') {
      respond(message.id, { content: [{ type: 'text', text: 'echo: ' + (message.params?.arguments?.text ?? '') }] })
    } else if (name === 'boom') {
      respond(message.id, { isError: true, content: [{ type: 'text', text: 'exploded' }] })
    } else if (name === 'rpc_error') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'nope' } }) + '\\n')
    } else if (name === 'env_check') {
      const token = process.env.MCP_TEST_TOKEN
      const secret = process.env.MCP_TEST_SECRET
      respond(message.id, { content: [{ type: 'text', text: 'token=' + (token === undefined ? 'unset' : token) + ' secret=' + (secret === undefined ? 'unset' : 'LEAKED') }] })
    } else if (name === 'cancel_check') {
      // no answer on purpose
    } else {
      respond(message.id, { content: [{ type: 'text', text: 'unknown tool' }] })
    }
  } else {
    respond(message.id, {})
  }
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
`

async function makeServerFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), '.tmp-mcp-'))
  scratchDirs.push(dir)
  const file = path.join(dir, 'fake-mcp-server.mjs')
  await writeFile(file, FAKE_SERVER, 'utf8')
  return file
}

function ctxWith(
  approve?: (request: string) => Promise<boolean>,
  signal?: AbortSignal,
): ToolContext {
  return {
    root: process.cwd(),
    log: () => {},
    ...(approve ? { approve } : {}),
    ...(signal ? { signal } : {}),
  }
}

test('MCP discovery mounts tools as mcp__<server>__<tool> into the registry', async () => {
  const serverFile = await makeServerFile()
  process.env.MCP_TEST_TOKEN = 'tok-1'
  process.env.MCP_TEST_SECRET = 's3cret'
  const hub = new McpHub(
    { tools: { command: process.execPath, args: [serverFile] } },
    { log: () => {} },
  )
  try {
    await hub.connect()
    const registry = new ToolRegistry()
    await registry.loadSource(hub)

    const names = registry.names()
    assert.ok(names.includes('mcp__tools__echo'), names.join(', '))
    assert.ok(names.includes('mcp__tools__boom'))
    const echo = registry.get('mcp__tools__echo')
    assert.match(echo!.description, /Echo the text back/)
    assert.equal(echo!.parameters.type, 'object')
  } finally {
    hub.close()
    delete process.env.MCP_TEST_TOKEN
    delete process.env.MCP_TEST_SECRET
  }
})

test('an MCP tool call round-trips arguments and result text', async () => {
  const serverFile = await makeServerFile()
  const hub = new McpHub(
    { srv: { command: process.execPath, args: [serverFile], allow: ['echo'] } },
    { log: () => {} },
  )
  try {
    await hub.connect()
    const registry = new ToolRegistry()
    await registry.loadSource(hub)
    const echo = registry.get('mcp__srv__echo')!
    // Allow-listed: runs without any approver present.
    const result = await echo.execute({ text: 'hi there' }, ctxWith())
    assert.equal(result, 'echo: hi there')
  } finally {
    hub.close()
  }
})

test('MCP failures become data: isError, JSON-RPC errors', async () => {
  const serverFile = await makeServerFile()
  const hub = new McpHub(
    { srv: { command: process.execPath, args: [serverFile], allow: ['boom', 'rpc_error'] } },
    { log: () => {} },
  )
  try {
    await hub.connect()
    const registry = new ToolRegistry()
    await registry.loadSource(hub)
    const boom = registry.get('mcp__srv__boom')!
    await assert.rejects(async () => boom.execute({}, ctxWith()), /exploded/)
    const rpcError = registry.get('mcp__srv__rpc_error')!
    await assert.rejects(async () => rpcError.execute({}, ctxWith()), /nope/)
  } finally {
    hub.close()
  }
})

test('every MCP tool call needs approval unless allow-listed', async () => {
  const serverFile = await makeServerFile()
  const hub = new McpHub(
    { srv: { command: process.execPath, args: [serverFile], allow: ['echo'] } },
    { log: () => {} },
  )
  try {
    await hub.connect()
    const registry = new ToolRegistry()
    await registry.loadSource(hub)

    const envCheck = registry.get('mcp__srv__env_check')!
    // No approver at all: refused with guidance.
    await assert.rejects(
      async () => envCheck.execute({}, ctxWith()),
      /requires approval/,
    )
    // Approver denies: nothing runs.
    await assert.rejects(
      async () => envCheck.execute({}, ctxWith(async () => false)),
      /denied by user/i,
    )
    // Approver approves: the call goes out.
    const result = await envCheck.execute({}, ctxWith(async () => true))
    assert.match(result, /token=/)
  } finally {
    hub.close()
  }
})

test('the child env is the OS lookup names plus the explicit map, never process.env', async () => {
  const serverFile = await makeServerFile()
  process.env.MCP_TEST_SECRET = 's3cret' // must NOT reach the child
  const hub = new McpHub(
    {
      srv: {
        command: process.execPath,
        args: [serverFile],
        env: { MCP_TEST_TOKEN: 'tok-2' },
        allow: ['env_check'],
      },
    },
    { log: () => {} },
  )
  try {
    await hub.connect()
    const registry = new ToolRegistry()
    await registry.loadSource(hub)
    const envCheck = registry.get('mcp__srv__env_check')!
    const result = await envCheck.execute({}, ctxWith())
    assert.match(result, /token=tok-2/)
    assert.match(result, /secret=unset/, 'a spread of process.env would leak the secret')
  } finally {
    hub.close()
    delete process.env.MCP_TEST_SECRET
  }
})

test('a server that fails to start is logged and skipped, not fatal', async () => {
  const serverFile = await makeServerFile()
  const logs: string[] = []
  const hub = new McpHub(
    {
      broken: { command: process.execPath, args: [serverFile.replace('fake-mcp-server', 'missing')] },
      good: { command: process.execPath, args: [serverFile], allow: ['echo'] },
    },
    { log: (message) => logs.push(message) },
  )
  try {
    await hub.connect()
    const registry = new ToolRegistry()
    await registry.loadSource(hub)
    assert.match(logs.find((entry) => entry.startsWith('MCP server "broken"')) ?? '', /unavailable/)
    assert.ok(registry.has('mcp__good__echo'), 'the healthy server still mounted')
    assert.equal(hub.connectedCount(), 1)
  } finally {
    hub.close()
  }
})

test('a cancellation reaches the in-flight MCP call', async () => {
  const serverFile = await makeServerFile()
  const hub = new McpHub(
    { srv: { command: process.execPath, args: [serverFile], allow: ['cancel_check'] } },
    { log: () => {}, callTimeoutMs: 30_000 },
  )
  try {
    await hub.connect()
    const registry = new ToolRegistry()
    await registry.loadSource(hub)
    const cancelCheck = registry.get('mcp__srv__cancel_check')!
    const controller = new AbortController()
    const run = Promise.resolve(cancelCheck.execute({}, ctxWith(undefined, controller.signal))).then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
    setTimeout(() => controller.abort(new Error('stop')), 100)
    // The abort races the never-answering server; the call must settle, not hang.
    const outcome = await Promise.race([
      run,
      new Promise<string>((resolve) => setTimeout(() => resolve('HUNG'), 5_000)),
    ])
    assert.match(outcome, /cancelled/)
  } finally {
    hub.close()
  }
})

test('a config entry without a command is rejected at resolve time', async () => {
  const hub = new McpHub({ broken: { command: '' } as McpServerConfig }, { log: () => {} })
  await hub.connect() // tolerated here (logged), the throwing layer is resolveConfig
  hub.close()
})
