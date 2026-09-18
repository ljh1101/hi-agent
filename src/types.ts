/**
 * Core, provider-agnostic types for the agent.
 *
 * A conversation is a list of `ChatMessage`, the model is anything that
 * implements `LLM`, and the model's capabilities are `Tool`s.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string
  name: string
  /**
   * Raw JSON string exactly as produced by the model. It is intentionally kept
   * unparsed so the agent can surface parse failures back to the model instead
   * of crashing.
   */
  arguments: string
}

/**
 * One entry of the conversation history.
 *
 * This mirrors the OpenAI chat-completions shape, which is the de-facto
 * standard for tool calling, so any OpenAI-compatible provider works directly.
 */
export interface ChatMessage {
  role: Role
  content: string | null
  /** Present on assistant messages that request tool calls. */
  tool_calls?: ToolCall[]
  /** Present on `tool` messages; links the result back to the request. */
  tool_call_id?: string
  /** Present on `tool` messages; the tool name. */
  name?: string
}

/** Minimal JSON Schema subset needed to describe tool arguments. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/** Normalized model reply. */
export interface LLMResponse {
  content: string | null
  toolCalls: ToolCall[]
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface ChatOptions {
  signal?: AbortSignal
}

/** One chunk of a streaming reply, normalized across providers. */
export type StreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; content: string; finishReason: string | null; usage?: LLMResponse['usage'] }

/** Anything that can answer a conversation with text and/or tool calls. */
export interface LLM {
  readonly model: string
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<LLMResponse>
  /**
   * Optional streaming variant. Yields normalized chunks and ends with a
   * `done` event carrying the fully accumulated content and tool calls, so the
   * caller never has to parse SSE or reassemble deltas itself.
   */
  stream?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamEvent, void>
}

/** How a tool is advertised to the model. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
}

/** Runtime handed to every tool execution. */
export interface ToolContext {
  /** Directory relative paths resolve against, and that they may not escape. */
  root: string
  signal?: AbortSignal
  /** Progress sink; goes to the CLI, never to the model. */
  log: (message: string) => void
  /**
   * Ask the user to approve a risky action. Resolves `true` to proceed, `false`
   * to deny. Only present when the agent was constructed with an `approver`.
   * The second argument carries the raw command (when the request is about a
   * shell command) so the approver can remember prefixes.
   */
  approve?: (request: string, command?: string) => Promise<boolean>
}

/** Risk level of a tool, driving the approval gate. */
export type ToolPermission = 'read' | 'write' | 'dangerous'

/** A tool returns text; an observation is always text from the model's view. */
export type ToolResult = string

export interface Tool<Args = Record<string, unknown>> extends ToolDefinition {
  /**
   * Run the tool. Throwing is fine and expected: the agent converts the error
   * into an observation so the model can correct itself.
   */
  execute(args: Args, ctx: ToolContext): Promise<ToolResult> | ToolResult
  /**
   * Per-tool execution timeout override, in milliseconds. Defaults to the
   * agent's `toolTimeoutMs` when unset. Tools like `shell` that may run long
   * can declare a larger budget here.
   */
  timeoutMs?: number
  /** Risk level. `read` tools run without approval; others may gate on it. */
  permission?: ToolPermission
}

/** Progress events emitted by the agent loop, for UIs and logging. */
export type AgentEvent =
  | { type: 'step'; step: number }
  | { type: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | {
      type: 'tool_result'
      id: string
      name: string
      result: string
      isError: boolean
      durationMs: number
    }
  | { type: 'final'; content: string }
  | { type: 'max_steps'; steps: number }
  /** Free-form progress note from inside a tool. */
  | { type: 'log'; message: string }
  /** A single text token from a streaming reply, for live UI rendering. */
  | { type: 'token'; delta: string }

/** Why the loop stopped. */
export type StopReason = 'final' | 'max_steps' | 'aborted'

export interface RunResult {
  /** The agent's final answer (or an explanation of why it stopped). */
  content: string
  /** Number of model round-trips performed. */
  steps: number
  stopReason: StopReason
  /** The full conversation, including the just-finished turn. */
  messages: ChatMessage[]
}
