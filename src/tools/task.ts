import { Agent } from '../agent.ts'
import type { LLM, Tool } from '../types.ts'
import { calculatorTool } from './calculator.ts'
import { currentTimeTool } from './time.ts'
import { listDirTool, readFileTool } from './filesystem.ts'
import { globTool, grepTool } from './search.ts'

/**
 * The `task` tool: spawn a sub-agent for research that would drown the main
 * context (roadmap item 6). A sub-agent is a library caller — a nested `Agent`
 * with its own history, its own tool set (read-only by default), its own step
 * budget, and the parent's abort signal. Its final answer — or its stop
 * reason — becomes the observation; a provider failure inside the sub-agent
 * throws and the parent turns it into an `Error: ...` observation like any
 * other tool failure ("tool failures are data").
 *
 * Guardrails, stated plainly:
 * - The default tool set has no writers and no shell: sub-agent writes would
 *   be untracked by the parent's `/undo` journal, so the default simply gives
 *   them nothing to write with. Passing write-capable tools via `tools` is the
 *   explicit opt-in (and then undo tracking stays with the sub-agent's own,
 *   throwaway journal).
 * - Approvals propagate to the parent's `ctx.approve`, so a sub-agent cannot
 *   escape the consent chain.
 * - Sub-runs are not persisted as sessions in v1.
 * - The LLM arrives through `getLLM` (not a fixed instance) so a mid-session
 *   `/model` swap applies to sub-agents too. `agent.ts` is untouched: the
 *   sub-agent is just a library caller of the public surface.
 */

/** The read-only default: workspace reads and search, math, clock. */
function defaultTaskTools(): Tool[] {
  return [
    calculatorTool as Tool,
    currentTimeTool as Tool,
    listDirTool as Tool,
    readFileTool as Tool,
    globTool as Tool,
    grepTool as Tool,
  ]
}

export interface TaskToolOptions {
  /**
   * The LLM the sub-agent talks to, resolved per call so `/model` swaps apply.
   * Required: a sub-agent without a model is pointless.
   */
  getLLM: () => LLM
  /** The sub-agent's tool set. Defaults to the read-only set. */
  tools?: readonly Tool[]
  /** Sub-agent step budget. Defaults to 12, same as the Agent default. */
  maxSteps?: number
  /** System prompt for the sub-agent. Defaults to the assembly from its own toolset. */
  systemPrompt?: string
}

export function createTaskTool(options: TaskToolOptions): Tool<{ prompt: string }> {
  const maxSteps = options.maxSteps ?? 12
  return {
    name: 'task',
    description:
      'Run a sub-agent with its own context window to handle a self-contained research task and ' +
      'return its final answer as the result. The sub-agent sees only your prompt and has ' +
      'read-only tools (read_file, glob, grep, list_dir, calculator, current_time) — it cannot ' +
      'write files or run shell commands.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete, self-contained brief for the sub-agent. It sees nothing else.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    timeoutMs: 600_000,
    promptSnippet:
      'delegate a self-contained research task to a sub-agent with its own context and ' +
      'read-only tools; its final answer comes back as the result',
    promptGuidelines: [
      'Use task for broad exploration (scan many files, summarize a subtree) that would flood your own context with intermediate output.',
      'Write the prompt as a complete brief: the sub-agent cannot see this conversation.',
    ],
    async execute({ prompt }, ctx) {
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        throw new Error('"prompt" must be a non-empty string')
      }
      const tools = options.tools ?? defaultTaskTools()
      const agent = new Agent({
        llm: options.getLLM(),
        tools,
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        maxSteps,
        root: ctx.root,
        signal: ctx.signal,
        ...(ctx.approve ? { approver: (request: string, command?: string) => ctx.approve!(request, command) } : {}),
        onEvent: (event) => {
          // Compact progress: the parent's UI shows what the sub-agent is doing.
          if (event.type === 'tool_call') {
            ctx.log(`task: ${event.name}`)
          }
        },
      })

      const result = await agent.run(prompt)
      if (result.stopReason === 'aborted') {
        throw new Error('the task was cancelled')
      }
      return result.content
    },
  }
}
