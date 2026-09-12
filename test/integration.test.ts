import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { Agent } from '../src/agent.ts'
import { LLMError, OpenAICompatibleLLM } from '../src/llm.ts'
import { createDefaultTools } from '../src/tools/index.ts'
import type { AgentEvent } from '../src/types.ts'
import { completion, serveFakeProvider } from './helpers.ts'

/**
 * End-to-end: the real agent loop, the real HTTP client and the real tools, all
 * wired to a fake provider. This is the test that would otherwise need an API
 * key, so it is the closest thing to a live run.
 */
test('multi-step run: tool call, observation, second tool call, final answer', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-tools-'))
  const events: AgentEvent[] = []

  try {
    await serveFakeProvider(
      (body, index) => {
        const messages = body.messages as { role: string; content: string }[]
        if (index === 0) {
          // The provider must have received our system prompt and tool schemas.
          assert.equal(messages[0]?.role, 'system')
          const toolNames = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name)
          assert.ok(toolNames.includes('calculator'))
          assert.ok(toolNames.includes('write_file'))
          assert.equal(body.tool_choice, 'auto')
          return {
            payload: completion({
              content: 'Let me compute that first.',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'calculator', arguments: '{"expression":"12 * 12"}' },
                },
              ],
            }),
          }
        }

        if (!messages.some((message) => message.role === 'tool' && message.content.includes('Wrote'))) {
          // The calculator observation must have been fed back verbatim.
          assert.ok(messages.some((message) => message.content === '12 * 12 = 144'))
          return {
            payload: completion({
              tool_calls: [
                {
                  id: 'c2',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'result.txt', content: '144' }),
                  },
                },
              ],
            }),
          }
        }

        return { payload: completion({ content: '12 * 12 = 144, saved to result.txt.' }) }
      },
      async (baseURL, captured) => {
        const agent = new Agent({
          llm: new OpenAICompatibleLLM({ apiKey: 'test-key', baseURL, model: 'fake-model' }),
          tools: createDefaultTools(),
          root,
          onEvent: (event) => events.push(event),
        })

        const result = await agent.run('What is 12 * 12? Save the answer to result.txt')

        assert.equal(result.stopReason, 'final')
        assert.equal(result.content, '12 * 12 = 144, saved to result.txt.')
        assert.equal(result.steps, 3)
        assert.equal(captured.length, 3)

        // The file really exists on disk, with the content the model asked for.
        assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), '144')

        // Both tools ran, in order, and neither errored.
        const toolCalls = events.filter((event) => event.type === 'tool_call')
        assert.deepEqual(
          toolCalls.map((event) => (event.type === 'tool_call' ? event.name : '')),
          ['calculator', 'write_file'],
        )
        assert.ok(
          events.filter((event) => event.type === 'tool_result').every((event) => event.type === 'tool_result' && !event.isError),
        )

        // History is a well-formed tool-calling transcript.
        assert.deepEqual(
          agent.history.map((message) => message.role),
          ['system', 'system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'],
        )
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a provider failure propagates out of the agent loop', async () => {
  await serveFakeProvider(
    () => ({ status: 500, payload: { error: { message: 'upstream exploded' } } }),
    async (baseURL) => {
      const agent = new Agent({
        llm: new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm' }),
        tools: createDefaultTools(),
      })
      await assert.rejects(
        () => agent.run('anything'),
        (error: unknown) => error instanceof LLMError && error.status === 500,
      )
    },
  )
})
