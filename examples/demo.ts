/**
 * Offline demo: proves the agent loop end-to-end with a scripted model, so you
 * can watch it work without an API key.
 *
 * Run with: npm run demo
 */
import { Agent } from '../src/agent.ts'
import { createDefaultTools } from '../src/tools/index.ts'
import type { AgentEvent, ChatMessage, LLM, LLMResponse, ToolDefinition } from '../src/types.ts'

/**
 * Stand-in for a real model: replays fixed replies. A real `LLM` returns the
 * same `LLMResponse` shape, which is the only thing the agent loop depends on.
 */
class ScriptedLLM implements LLM {
  readonly model = 'scripted-demo'
  private readonly replies: LLMResponse[]
  private request = 0

  constructor(replies: LLMResponse[]) {
    this.replies = replies
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMResponse> {
    this.request++
    console.log(
      `\n[model request ${this.request}] ${messages.length} messages, ${tools.length} tools offered`,
    )
    const reply = this.replies.shift()
    if (!reply) throw new Error('demo script exhausted')
    return reply
  }
}

function render(event: AgentEvent): void {
  switch (event.type) {
    case 'step':
      console.log(`\n[step ${event.step}]`)
      break
    case 'assistant':
      if (event.content.trim()) console.log(`[model] ${event.content.trim()}`)
      break
    case 'tool_call':
      console.log(`  -> ${event.name}(${JSON.stringify(event.args)})`)
      break
    case 'tool_result':
      console.log(`  ${event.isError ? '!!' : 'ok'} ${event.result} (${event.durationMs}ms)`)
      break
    case 'final':
      console.log(`\n[answer] ${event.content}`)
      break
    case 'max_steps':
      console.log(`\n[stopped] hit the ${event.steps}-step limit`)
      break
    case 'log':
      console.log(`[log] ${event.message}`)
      break
    case 'token':
      process.stdout.write(event.delta)
      break
  }
}

const llm = new ScriptedLLM([
  {
    content: 'I need to compute that exactly.',
    toolCalls: [
      { id: 'call_1', name: 'calculator', arguments: '{"expression":"(23 * 17) + 9"}' },
    ],
  },
  {
    content: 'Now let me check the clock and look at the workspace.',
    toolCalls: [
      { id: 'call_2', name: 'current_time', arguments: '{}' },
      { id: 'call_3', name: 'list_dir', arguments: '{"path":"src"}' },
    ],
  },
  {
    content:
      '(23 * 17) + 9 = 400. The clock and the src/ listing are shown above; the workspace holds the agent core, ' +
      'the LLM client, the tool registry and the CLI.',
    toolCalls: [],
  },
])

const agent = new Agent({
  llm,
  tools: createDefaultTools(),
  root: process.cwd(),
  onEvent: render,
})

const result = await agent.run('What is (23 * 17) + 9, what time is it, and what is in src/?')
console.log(`\n--- stopReason=${result.stopReason} steps=${result.steps} messages=${result.messages.length}`)
