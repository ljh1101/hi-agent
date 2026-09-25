import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import {
  backoffDelay,
  LLMError,
  OpenAICompatibleLLM,
  parseRetryAfter,
  startIdleTimeout,
} from '../src/llm.ts'
import type { ChatMessage, StreamEvent, ToolDefinition } from '../src/types.ts'
import { serveFakeProvider } from './helpers.ts'

const calcTool: ToolDefinition = {
  name: 'calc',
  description: 'Do math.',
  parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
}

test('sends an OpenAI-compatible request and parses the reply', async () => {
  await serveFakeProvider(
    () => ({
      payload: {
        choices: [{ message: { role: 'assistant', content: 'hi there' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    }),
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'secret', baseURL, model: 'test-model' })
      const reply = await llm.chat([{ role: 'user', content: 'hello' }], [calcTool])

      assert.equal(llm.model, 'test-model')
      assert.equal(reply.content, 'hi there')
      assert.deepEqual(reply.toolCalls, [])
      assert.equal(reply.usage?.totalTokens, 4)

      const request = captured[0]
      assert.ok(request)
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorization, 'Bearer secret')
      assert.equal(request.body.model, 'test-model')
      assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hello' }])
      assert.equal(request.body.tool_choice, 'auto')
      assert.deepEqual(request.body.tools, [
        {
          type: 'function',
          function: {
            name: 'calc',
            description: 'Do math.',
            parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
          },
        },
      ])
    },
  )
})

test('omits tools entirely when none are offered', async () => {
  await serveFakeProvider(
    () => ({ payload: { choices: [{ message: { content: 'ok' } }] } }),
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      await llm.chat([{ role: 'user', content: 'hi' }], [])
      assert.equal(captured[0]?.body.tools, undefined)
      assert.equal(captured[0]?.body.tool_choice, undefined)
    },
  )
})

test('serializes the full history including tool calls and results', async () => {
  const history: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'what is 2+2?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'calc', arguments: '{"expression":"2+2"}' }] },
    { role: 'tool', content: '2+2 = 4', tool_call_id: 'c1', name: 'calc' },
  ]

  await serveFakeProvider(
    () => ({ payload: { choices: [{ message: { content: 'four' } }] } }),
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      await llm.chat(history, [calcTool])

      const messages = captured[0]?.body.messages as Record<string, unknown>[]
      assert.equal(messages.length, 4)
      assert.deepEqual(messages[0], { role: 'system', content: 'sys' })
      assert.deepEqual(messages[2], {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calc', arguments: '{"expression":"2+2"}' } }],
      })
      assert.deepEqual(messages[3], { role: 'tool', content: '2+2 = 4', tool_call_id: 'c1' })
    },
  )
})

test('parses tool calls, synthesizing an id when the provider omits one', async () => {
  await serveFakeProvider(
    () => ({
      payload: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { type: 'function', function: { name: 'calc', arguments: '{"expression":"1+1"}' } },
                { id: 'real_id', type: 'function', function: { name: 'calc' } },
              ],
            },
          },
        ],
      },
    }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      const reply = await llm.chat([{ role: 'user', content: 'go' }], [calcTool])
      assert.deepEqual(reply.toolCalls, [
        { id: 'call_0', name: 'calc', arguments: '{"expression":"1+1"}' },
        { id: 'real_id', name: 'calc', arguments: '{}' },
      ])
    },
  )
})

test('surfaces provider failures as LLMError', async () => {
  await serveFakeProvider(
    () => ({ status: 401, payload: { error: { message: 'invalid api key' } } }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'bad', baseURL, model: 'm' })
      await assert.rejects(
        () => llm.chat([{ role: 'user', content: 'hi' }], []),
        (error: unknown) => {
          assert.ok(error instanceof LLMError)
          assert.equal(error.status, 401)
          assert.match(error.message, /HTTP 401/)
          assert.match(error.message, /invalid api key/)
          return true
        },
      )
    },
  )
})

test('reports an error payload returned with HTTP 200', async () => {
  await serveFakeProvider(
    () => ({ payload: { error: { message: 'quota exceeded' } } }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      await assert.rejects(() => llm.chat([], []), /quota exceeded/)
    },
  )
})

test('reports a non-JSON body instead of crashing', async () => {
  await serveFakeProvider(
    () => ({ raw: '<html>gateway timeout</html>' }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      await assert.rejects(() => llm.chat([], []), /invalid JSON/)
    },
  )
})

test('reports a missing choice and a nameless tool call', async () => {
  await serveFakeProvider(
    () => ({ payload: { choices: [] } }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      await assert.rejects(() => llm.chat([], []), /no choices/)
    },
  )

  await serveFakeProvider(
    () => ({ payload: { choices: [{ message: { tool_calls: [{ id: 'x', type: 'function', function: {} }] } }] } }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      await assert.rejects(() => llm.chat([], []), /without a function name/)
    },
  )
})

test('times out a hanging provider', async () => {
  await serveFakeProvider(
    () => ({ delayMs: 500, payload: { choices: [{ message: { content: 'late' } }] } }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', timeoutMs: 40 })
      await assert.rejects(() => llm.chat([], []), /failed/)
    },
  )
})

test('requires an API key', () => {
  assert.throws(() => new OpenAICompatibleLLM({ apiKey: '', model: 'm' }), /Missing API key/)
})

test('tolerates a trailing slash in the base URL', async () => {
  await serveFakeProvider(
    () => ({ payload: { choices: [{ message: { content: 'ok' } }] } }),
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL: `${baseURL}/`, model: 'm' })
      await llm.chat([], [])
      assert.equal(captured[0]?.url, '/v1/chat/completions')
    },
  )
})

test('retries a 429 and succeeds on the next attempt', async () => {
  await serveFakeProvider(
    (_body, index) =>
      index === 0
        ? { status: 429, payload: { error: { message: 'rate limited' } } }
        : { payload: { choices: [{ message: { content: 'recovered' } }] } },
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', baseDelayMs: 0 })
      const reply = await llm.chat([{ role: 'user', content: 'hi' }], [])
      assert.equal(reply.content, 'recovered')
      assert.equal(captured.length, 2)
    },
  )
})

test('retries a 5xx, then gives up after maxRetries', async () => {
  await serveFakeProvider(
    () => ({ status: 503, payload: { error: { message: 'down' } } }),
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', maxRetries: 2, baseDelayMs: 0 })
      await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], []), /HTTP 503/)
      assert.equal(captured.length, 3)
    },
  )
})

test('does not retry a 401 (client error)', async () => {
  await serveFakeProvider(
    () => ({ status: 401, payload: { error: { message: 'bad key' } } }),
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'bad', baseURL, model: 'm' })
      await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], []), /HTTP 401/)
      assert.equal(captured.length, 1)
    },
  )
})

test('honours a Retry-After header as a number of seconds', async () => {
  await serveFakeProvider(
    (_body, index) =>
      index === 0
        ? { status: 429, payload: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } }
        : { payload: { choices: [{ message: { content: 'ok' } }] } },
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', baseDelayMs: 0 })
      const reply = await llm.chat([{ role: 'user', content: 'hi' }], [])
      assert.equal(reply.content, 'ok')
      assert.equal(captured.length, 2)
    },
  )
})

test('backoffDelay grows exponentially and clamps to maxDelay', () => {
  // Random pinned to 1.0 gives the ceiling exactly, so we can assert the curve.
  const random = () => 1
  const base = 100
  const max = 1000

  assert.equal(backoffDelay(0, base, max, random), 100)   // 100 * 2^0
  assert.equal(backoffDelay(1, base, max, random), 200)   // 100 * 2^1
  assert.equal(backoffDelay(2, base, max, random), 400)   // 100 * 2^2
  assert.equal(backoffDelay(3, base, max, random), 800)   // 100 * 2^3
  assert.equal(backoffDelay(4, base, max, random), 1000)  // clamped at max
  assert.equal(backoffDelay(10, base, max, random), 1000) // stays clamped
})

test('backoffDelay stays within [0, ceiling) for a random source', () => {
  const base = 50
  const max = 400
  for (let attempt = 0; attempt < 6; attempt++) {
    const ceiling = Math.min(max, base * 2 ** attempt)
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelay(attempt, base, max)
      assert.ok(delay >= 0 && delay < ceiling, `delay ${delay} outside [0, ${ceiling})`)
    }
  }
})

test('parseRetryAfter handles seconds, HTTP dates, and garbage', () => {
  assert.equal(parseRetryAfter('3'), 3000)
  assert.equal(parseRetryAfter('0'), 0)
  assert.equal(parseRetryAfter(' 5 '), 5000)

  const future = new Date(Date.now() + 1000).toUTCString()
  assert.ok(parseRetryAfter(future) !== undefined && parseRetryAfter(future)! <= 1000)

  assert.equal(parseRetryAfter('not-a-date'), undefined)
  assert.equal(parseRetryAfter(null), undefined)
  assert.equal(parseRetryAfter(''), undefined)
})

test('aborts the backoff delay when the external signal fires', async () => {
  const controller = new AbortController()

  let failCalls = 0
  await serveFakeProvider(
    () => {
      failCalls++
      // After replying 429, abort while the client is in its backoff sleep.
      setTimeout(() => controller.abort(), 10)
      return { status: 429, payload: { error: { message: 'busy' } } }
    },
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', baseDelayMs: 60_000 })
      await assert.rejects(
        () => llm.chat([{ role: 'user', content: 'hi' }], [], { signal: controller.signal }),
      )
      // Only one request went out: the retry was cancelled during the delay.
      assert.equal(failCalls, 1)
    },
  )
})

function sse(events: string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join('') + 'data: [DONE]\n\n'
}

/**
 * Serve an SSE body in timed chunks. `serveFakeProvider` answers in one burst,
 * which cannot express "slow but still making progress" — the difference the
 * streaming deadline is supposed to measure.
 */
async function serveTrickle(
  frames: string[],
  gapMs: number,
  stallMs: number,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of frames) {
      response.write(`data: ${frame}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
    if (stallMs > 0) await new Promise((resolve) => setTimeout(resolve, stallMs))
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test('startIdleTimeout measures silence, not total duration', async () => {
  const idle = startIdleTimeout(60)
  const ticks = setInterval(() => idle.keepAlive(), 20)
  await new Promise((resolve) => setTimeout(resolve, 240))
  clearInterval(ticks)
  assert.equal(idle.timedOut(), false, 'steady progress must keep the request alive')
  assert.equal(idle.signal.aborted, false)
  idle.dispose()
})

test('startIdleTimeout fires once the silence outlasts the deadline', async () => {
  const idle = startIdleTimeout(40)
  await new Promise((resolve) => setTimeout(resolve, 160))
  assert.equal(idle.timedOut(), true)
  assert.equal(idle.signal.aborted, true)
  idle.dispose()
})

test('a slow stream that keeps sending is not cut off', async () => {
  // Measured before this: a provider trickling a body for 1s with a 300ms
  // timeout was killed at ~300ms mid-answer, because the bound covered the
  // whole request instead of the gaps in it.
  const frames = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({ choices: [{ delta: { content: `c${i} ` }, finish_reason: null }] }),
  )
  await serveTrickle(frames, 60, 0, async (baseURL) => {
    const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', timeoutMs: 200 })
    const started = Date.now()
    let content = ''
    for await (const event of llm.stream!([{ role: 'user', content: 'hi' }], [])) {
      if (event.type === 'delta') content += event.delta
    }
    const elapsed = Date.now() - started
    assert.ok(elapsed > 200, `the stream outlasted the timeout (${elapsed}ms), which is the point`)
    assert.equal(content.trim(), 'c0 c1 c2 c3 c4 c5 c6 c7')
  })
})

test('a stalled stream fails with a typed, explainable error', async () => {
  const frames = [JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] })]
  await serveTrickle(frames, 10, 1_000, async (baseURL) => {
    const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', timeoutMs: 150 })
    await assert.rejects(
      async () => {
        for await (const _event of llm.stream!([{ role: 'user', content: 'hi' }], [])) {
          // drain
        }
      },
      (error: unknown) => {
        // Previously a bare DOMException ("The operation was aborted due to
        // timeout") escaped, so the CLI's error hints never fired.
        assert.ok(error instanceof LLMError, `expected an LLMError, got ${String(error)}`)
        assert.match((error as Error).message, /stalled for 150ms/)
        return true
      },
    )
  })
})

test('streams content deltas, tool calls, and a final done event', async () => {
  const raw = sse([
    JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'The ' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])

  await serveFakeProvider(
    () => ({ raw }),
    async (baseURL, captured) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      const events: StreamEvent[] = []
      for await (const event of llm.stream!([{ role: 'user', content: 'hi' }], [])) {
        events.push(event)
      }

      assert.equal(captured[0]?.body.stream, true)
      assert.deepEqual(
        events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.delta : '')),
        ['The ', 'answer'],
      )
      const done = events.at(-1)
      assert.ok(done && done.type === 'done' && done.content === 'The answer')
      assert.equal(done.finishReason, 'stop')
    },
  )
})

test('reassembles streamed tool call arguments across chunks', async () => {
  const raw = sse([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"expr' } }] }, finish_reason: null }],
    }),
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"1+1"}' } }] }, finish_reason: null }],
    }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ])

  await serveFakeProvider(
    () => ({ raw }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      const events: StreamEvent[] = []
      for await (const event of llm.stream!([{ role: 'user', content: 'hi' }], [])) {
        events.push(event)
      }

      const call = events.find((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call')
      assert.ok(call)
      assert.equal(call.call.name, 'calc')
      assert.equal(call.call.id, 'call_1')
      assert.equal(call.call.arguments, '{"expression":"1+1"}')
    },
  )
})

test('reports usage from the final streamed chunk', async () => {
  const raw = sse([
    JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
  ])

  await serveFakeProvider(
    () => ({ raw }),
    async (baseURL) => {
      const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' })
      const events: StreamEvent[] = []
      for await (const event of llm.stream!([{ role: 'user', content: 'hi' }], [])) events.push(event)

      const done = events.at(-1)
      assert.ok(done && done.type === 'done' && done.usage?.totalTokens === 3)
    },
  )
})
