import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWebFetchTool, createWebSearchTool, htmlToText, isPrivateHost } from '../src/tools/web.ts'
import type { ToolContext } from '../src/types.ts'

interface CapturedRequest {
  url: string
  headers: IncomingHttpHeaders
  body: string
}

interface TestServer {
  base: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}

/** A local HTTP server on the loopback interface, so every fetch hits the approval gate. */
function startServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<TestServer> {
  const requests: CapturedRequest[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: request.url ?? '', headers: request.headers, body })
      handler(request, response, body)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function ctxWith(approve?: (request: string) => Promise<boolean>): ToolContext {
  return {
    root: process.cwd(),
    log: () => {},
    ...(approve ? { approve: async (request: string) => approve(request) } : {}),
  }
}

// ---------------------------------------------------------------------------
// isPrivateHost
// ---------------------------------------------------------------------------

test('isPrivateHost classifies loopback, private, and link-local names', () => {
  for (const host of [
    'localhost',
    'foo.localhost',
    'mybox.local',
    '127.0.0.1',
    '127.8.8.8',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '0.0.0.0',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:192.168.0.1',
    'fd00::1',
    'fe80::1',
  ]) {
    assert.equal(isPrivateHost(host), true, host)
  }
  for (const host of [
    'example.com',
    'example.localdomain',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '192.169.0.1',
    '2606:4700::1111',
  ]) {
    assert.equal(isPrivateHost(host), false, host)
  }
})

// ---------------------------------------------------------------------------
// HTML conversion
// ---------------------------------------------------------------------------

test('htmlToText drops script/style, decodes entities, keeps text', () => {
  const html = `<!doctype html>
<html><head><title>Page</title><style>body { color: red }</style>
<script>if (a < b) { evil() }</script></head>
<body><h1>Hello &amp; welcome</h1>
<p>It&#39;s &#x41;B &copy; &mdash; done.</p>
<!-- a comment -->
<noscript>no js</noscript>
<a href="/next">next link</a></body></html>`
  const text = htmlToText(html)
  assert.ok(!text.includes('evil'), 'script content must be dropped')
  assert.ok(!text.includes('color: red'), 'style content must be dropped')
  assert.ok(!text.includes('a comment'), 'comments must be dropped')
  assert.ok(!text.includes('no js'), 'noscript content must be dropped')
  assert.ok(!text.includes('<'), 'no tags may survive')
  assert.ok(text.includes('Hello & welcome'))
  assert.match(text, /It's AB © — done\./)
  assert.ok(text.includes('next link'))
})

test('decodeEntities leaves unknown entities untouched', () => {
  assert.equal(htmlToText('a &notinmap; b &#xZZ; c'), 'a &notinmap; b &#xZZ; c')
})

// ---------------------------------------------------------------------------
// web_fetch against a real local server
// ---------------------------------------------------------------------------

test('web_fetch converts an HTML page to text', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><head><style>x{}</style></head><body><p>cats &amp; dogs</p><script>evil()</script></body></html>')
  })
  const tool = createWebFetchTool()
  try {
    const result = await tool.execute({ url: `${server.base}/page` }, ctxWith(async () => true))
    assert.ok(!result.includes('evil'))
    assert.ok(result.includes('cats & dogs'))
  } finally {
    await server.close()
  }
})

test('web_fetch passes JSON through untouched', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"a":1,"b":"x & y"}')
  })
  const tool = createWebFetchTool()
  try {
    const result = await tool.execute({ url: `${server.base}/api` }, ctxWith(async () => true))
    assert.equal(result, '{"a":1,"b":"x & y"}')
  } finally {
    await server.close()
  }
})

test('web_fetch reports HTTP errors with the status code', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not here')
  })
  const tool = createWebFetchTool()
  try {
    await assert.rejects(
      async () => tool.execute({ url: `${server.base}/missing` }, ctxWith(async () => true)),
      /HTTP 404/,
    )
  } finally {
    await server.close()
  }
})

test('web_fetch rejects non-text content types', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })
  const tool = createWebFetchTool()
  try {
    await assert.rejects(
      async () => tool.execute({ url: `${server.base}/img` }, ctxWith(async () => true)),
      /Unsupported content type/,
    )
  } finally {
    await server.close()
  }
})

test('web_fetch rejects URLs that are not http(s)', async () => {
  const tool = createWebFetchTool()
  await assert.rejects(
    async () => tool.execute({ url: 'ftp://example.com/file' }, ctxWith()),
    /Only http and https/,
  )
})

test('web_fetch caps the download and reports it', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('x'.repeat(3_000_000))
  })
  const tool = createWebFetchTool()
  try {
    const result = await tool.execute({ url: `${server.base}/big` }, ctxWith(async () => true))
    assert.match(result, /download capped at 2000000 bytes/)
    assert.ok(result.length < 2_100_000)
  } finally {
    await server.close()
  }
})

test('web_fetch truncates very long text with a marker', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('y'.repeat(30_000))
  })
  const tool = createWebFetchTool()
  try {
    const result = await tool.execute({ url: `${server.base}/long` }, ctxWith(async () => true))
    assert.match(result, /truncated, 10,?000 characters omitted/)
    assert.ok(result.length < 21_000)
  } finally {
    await server.close()
  }
})

test('web_fetch gates private addresses behind approval and remembers the denial', async () => {
  let served = 0
  const server = await startServer((request, response) => {
    served++
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('secret-ish')
  })
  const tool = createWebFetchTool()
  const asked: string[] = []
  try {
    // No approver at all: blocked with guidance.
    await assert.rejects(
      async () => tool.execute({ url: `${server.base}/x` }, ctxWith()),
      /requires approval/,
    )
    // Approver says no: denied, nothing fetched.
    await assert.rejects(
      async () =>
        tool.execute(
          { url: `${server.base}/x` },
          ctxWith(async (request) => {
            asked.push(request)
            return false
          }),
        ),
      /denied by user/i,
    )
    assert.equal(served, 0)
    // Approver says yes: the request goes out.
    const ok = await tool.execute({ url: `${server.base}/x` }, ctxWith(async () => true))
    assert.equal(ok, 'secret-ish')
    assert.equal(served, 1)
    assert.equal(asked.length, 1)
    assert.match(asked[0]!, new RegExp(server.base))
  } finally {
    await server.close()
  }
})

test('web_fetch blocks a redirect that lands on a private address', async () => {
  const server = await startServer((request, response) => {
    if (request.url === '/hop') {
      // Same server, but reached via `localhost` — a private name the original
      // approval (for 127.0.0.1) never covered.
      response.writeHead(302, { location: `http://localhost:${(server.base.match(/:(\d+)/) ?? [])[1]}/landed` })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('intranet payload')
  })
  const tool = createWebFetchTool()
  try {
    await assert.rejects(
      async () => tool.execute({ url: `${server.base}/hop` }, ctxWith(async () => true)),
      /redirected to the private address/,
    )
  } finally {
    await server.close()
  }
})

test('web_fetch honors the timeout', async () => {
  const server = await startServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('late')
    }, 500)
  })
  const tool = createWebFetchTool({ timeoutMs: 50 })
  try {
    await assert.rejects(
      async () => tool.execute({ url: `${server.base}/slow` }, ctxWith(async () => true)),
      /timed out|aborted/i,
    )
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// web_search with an injected fetch
// ---------------------------------------------------------------------------

/** A fetchImpl that records calls and replies from a script. */
function fakeFetch(responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as typeof globalThis.fetch
  return { impl, calls }
}

test('web_search explains what to configure when no backend is set', async () => {
  const tool = createWebSearchTool()
  await assert.rejects(
    async () => tool.execute({ query: 'anything' }, ctxWith()),
    /"webSearch" section/,
  )
})

test('web_search queries Brave and formats the results', async () => {
  const { impl, calls } = fakeFetch(() => new Response(
    JSON.stringify({
      web: { results: [{ title: 'Result A', url: 'https://a.example', description: 'first' }] },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  const tool = createWebSearchTool({ backend: { provider: 'brave', apiKey: 'brave-key' }, fetchImpl: impl })
  const result = await tool.execute({ query: 'hi-agent roadmap' }, ctxWith())

  assert.equal(calls.length, 1)
  assert.match(calls[0]!.url, /api\.search\.brave\.com\/res\/v1\/web\/search\?q=hi-agent%20roadmap/)
  assert.equal(calls[0]!.init?.headers && (calls[0]!.init.headers as Record<string, string>)['x-api-key'], 'brave-key')
  assert.equal(result, '[1] Result A — https://a.example\n    first')
})

test('web_search queries Exa with a POST body', async () => {
  const { impl, calls } = fakeFetch(() => new Response(
    JSON.stringify({ results: [{ title: 'Exa Hit', url: 'https://e.example', text: 'body text' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  const tool = createWebSearchTool({ backend: { provider: 'exa', apiKey: 'exa-key' }, fetchImpl: impl })
  const result = await tool.execute({ query: 'hello' }, ctxWith())

  const init = calls[0]!.init!
  assert.equal(init.method, 'POST')
  assert.deepEqual(JSON.parse(String(init.body)), { query: 'hello', numResults: 8 })
  assert.equal((init.headers as Record<string, string>)['x-api-key'], 'exa-key')
  assert.match(result, /Exa Hit — https:\/\/e\.example/)
})

test('web_search asks Perplexity and appends its citations', async () => {
  const { impl, calls } = fakeFetch(() => new Response(
    JSON.stringify({
      choices: [{ message: { content: 'The answer.' } }],
      citations: ['https://c1.example', 'https://c2.example'],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  const tool = createWebSearchTool({ backend: { provider: 'perplexity', apiKey: 'pplx-key' }, fetchImpl: impl })
  const result = await tool.execute({ query: 'why' }, ctxWith())

  const init = calls[0]!.init!
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer pplx-key')
  assert.match(result, /The answer\./)
  assert.match(result, /Sources:\n\[1\] https:\/\/c1\.example/)
})

test('web_search turns API failures into errors with the status', async () => {
  const { impl } = fakeFetch(() => new Response('bad key', { status: 401 }))
  const tool = createWebSearchTool({ backend: { provider: 'brave', apiKey: 'nope' }, fetchImpl: impl })
  await assert.rejects(async () => tool.execute({ query: 'q' }, ctxWith()), /HTTP 401/)
})
