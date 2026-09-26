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
  /**
   * Agent-local marker for a system message that is a generated compaction
   * summary rather than a real system prompt.
   *
   * Compaction must be able to tell them apart: the user's system prompt(s)
   * survive every compaction, while a summary is *replaced* by the next one.
   * Without the marker the summaries stack up, each compaction adding another
   * stale snapshot to the front of the history. The marker is persisted with the
   * message, so a resumed session compacts correctly too, and the wire
   * projection (`toWireMessage`) never sends it — it is not part of the
   * provider's schema.
   */
  summary?: true
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
  /**
   * Report a file the tool just changed, so the run can be undone.
   *
   * Write-capable filesystem tools must call this with the content they
   * replaced: the mechanism is honest only if every writer participates, and a
   * tool that forgets simply makes its own change un-undoable.
   */
  recordChange?: (change: FileChange) => void
}

/**
 * One file change made by a tool, in a form that can be reversed.
 *
 * `null` on either side is meaningful: `before: null` means the file did not
 * exist (so undo removes it), `after: null` means the tool removed it.
 */
export interface FileChange {
  /** Path relative to the workspace root, POSIX separators (display form). */
  path: string
  before: string | null
  after: string | null
}

/** What an undo actually did, for the UI to report. */
export interface UndoResult {
  /** Files put back to their previous content. */
  restored: string[]
  /** Files removed because the turn created them. */
  removed: string[]
  /** Conversation messages dropped with the turn. */
  droppedMessages: number
  /**
   * Whether the conversation was rewound. False when the history was rewritten
   * under the turn (compaction summarized it away), so the pre-turn state no
   * longer exists and only the files could be restored.
   */
  rewound: boolean
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
  /**
   * Declarative risk level, for UIs and library consumers to badge or filter
   * on. The loop never reads it: approval happens only where a tool calls
   * `ctx.approve` itself (the shell tool's permission chain), and the file
   * tools deliberately write without asking — the boundary is the workspace
   * root, not per-file consent (see `src/changes.ts`).
   */
  permission?: ToolPermission
  /**
   * One-line "what am I for" shown in the system prompt's tools section.
   * This is usage guidance (when to reach for this tool, how it cooperates
   * with siblings), not parameter detail — parameters live in the schema.
   */
  promptSnippet?: string
  /** Extra behavior rules this tool contributes to the system prompt. */
  promptGuidelines?: readonly string[]
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
  /**
   * Estimated context size before a model request, using the last reported
   * usage plus a chars/4 estimate for messages after it. Emitted every step.
   */
  | { type: 'context_usage'; tokens: number }
  /** Compaction replaced old history with a summary (or failed trying). */
  | { type: 'compaction'; summaryTokens: number; keptFrom: number; ok: boolean }

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
