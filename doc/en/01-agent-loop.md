# 01 · Core Contracts and the Agent Loop

Covers: `src/types.ts`, `src/agent.ts`, `src/prompts/system.ts`.

`types.ts` is the contract layer shared by the whole project — changing it
ripples everywhere. `agent.ts` is the loop itself. `prompts/system.ts` is
prompt copy (copy is content, not logic, so it lives apart from the loop and
can be edited without touching code).

## 1. Data contracts (types.ts)

### ChatMessage

Mirrors the OpenAI chat-completions shape (the de-facto standard), so any
OpenAI-compatible provider works directly:

```ts
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[] | null   // blocks are the structured carrier (roadmap 3.2)
  reasoning?: string              // agent-local reasoning text (roadmap 3.1)
  tool_calls?: ToolCall[]         // assistant requesting tools
  tool_call_id?: string           // tool message; links back to the request
  name?: string                   // the tool name on a tool message
  summary?: true                  // local marker, see below
}

A `ContentBlock` is `{ type: 'text' } | { type: 'image' } |
{ type: 'thinking' }`. Strings remain the common shape — the loop itself
always produces string content — while block arrays are the carrier for
structured payload (images ride them once P3's image input lands). Both
forms are persisted and replayed as-is; `textOfContent` (doc 03) flattens
blocks where only text can go, and `reasoning` is stripped from every
request because reasoning providers reject their own output echoed back.
```

`summary: true` is an agent-local marker distinguishing a *generated
compaction summary* system message from the user's real system prompt.
Without it, compaction cannot tell them apart: the user's system prompts must
survive every compaction, while a previous summary must be **replaced** by
the next one. Before the marker existed, every compaction stacked another
stale "Next Steps" at the front of the history — the system prefix grew with
each compaction until it could no longer be compacted away. The marker is
persisted with the message (a resumed session compacts correctly too), and
the wire projection (`toWireMessage`) copies only known fields, so it never
goes online.

### ToolCall

```ts
interface ToolCall { id: string; name: string; arguments: string }
```

`arguments` **deliberately stays the raw JSON string exactly as produced by
the model, unparsed**. That lets the agent feed a parse failure back to the
model as an observation ("arguments were not valid JSON (...)") instead of
crashing itself — the first application of the "failures are data" principle.

### The LLM interface

```ts
interface LLM {
  readonly model: string
  chat(messages, tools, options?): Promise<LLMResponse>
  stream?(messages, tools, options?): AsyncGenerator<StreamEvent, void>
}
```

`stream` is optional: the `AsyncGenerator` yields normalized `StreamEvent`s
(`delta` / `tool_call` / `done`), and `done` carries the fully accumulated
content and tool calls — the caller never parses SSE or reassembles deltas.
Models implementing `stream` can be consumed as a stream; those without fall
back to `chat` automatically.

### Tool and ToolContext

```ts
interface Tool<Args> extends ToolDefinition {
  execute(args: Args, ctx: ToolContext): Promise<ToolResult> | ToolResult
  timeoutMs?: number          // overrides the agent's default 30s (shell declares a longer budget)
  concurrency?: 'serial' | 'concurrent' // batch scheduling; default concurrent (doc 01 §2)
  promptSnippet?: string      // one-line "what am I for", into the prompt's tools section
  promptGuidelines?: readonly string[]  // behavior rules, merged into the system prompt
}
```

`ToolDefinition` (name/description/parameters) is what is advertised to the
model; `execute` and the rest are runtime. A tool throwing is **expected**:
the agent turns the error into an observation and lets the model correct
itself.

`ToolContext` is the runtime handed to every execution:

| Field | Purpose |
| --- | --- |
| `root` | The directory relative paths resolve against, and may not escape |
| `signal` | Cancellation signal, reaching the LLM client and every tool |
| `log` | Progress output; goes to the UI, never to the model |
| `approve` | Ask the user to approve a risky action; only present when the agent was constructed with an `approver`. The second argument carries the raw command so the approver can remember prefixes |
| `recordChange` | Report a file change so `/undo` can reverse it. **Honesty principle**: the mechanism is honest only if every writer participates — a tool that forgets makes its own change un-undoable |

`FileChange` nulls carry meaning: `before: null` = the file did not exist
(undo removes it), `after: null` = the tool removed it.
`UndoResult.rewound: false` means the conversation could not be rewound (the
turn was compacted midway; the pre-compaction state no longer exists) and
only the files were restored.

### Where approval lives (important)

There is no static risk field on `Tool`: the old `permission` badge was
declarative metadata nothing read, and every real gate in this codebase is
per-call, so it was dropped. Enforcement lives inside the tools: the shell
tool walks the "deny rules → allow rules → read-only whitelist →
`ctx.approve`" chain inside its own `execute` (doc 04); file writing tools
**write without approval** — a deliberate decision: the boundary is the
workspace root, not per-file user consent, and the escape hatch is `/undo`
(doc 06). A new risky tool calls `ctx.approve` in its own `execute`, with
the per-call check (command, URL, allow-list) stated next to it, and has
its approval behavior reviewed per AGENTS.md.

### AgentEvent (11 kinds)

The entire information source for UIs and logging; the model never sees them:

| Event | Payload | When |
| --- | --- | --- |
| `step` | step number | Every model round-trip begins |
| `assistant` | content + toolCalls | The model reply fully arrived |
| `tool_call` | id/name/args | A tool is about to execute |
| `tool_result` | id/name/result/isError/durationMs | Tool finished (failures included) |
| `final` | content | The final answer was produced |
| `max_steps` | steps | Step limit reached |
| `log` | message | Free-form progress note from inside a tool |
| `token` | delta | Each text token of a streaming reply |
| `reasoning` | delta | A reasoning chunk from the stream (verbose UIs show it dimmed) |
| `context_usage` | tokens | Context estimate before each request |
| `compaction` | summaryTokens/keptFrom/ok | Compaction finished or failed |

## 2. The Agent class (agent.ts)

### Constructor options (AgentOptions)

| Option | Default | Meaning |
| --- | --- | --- |
| `llm` | required | A model client implementing `LLM` |
| `tools` | `[]` | Registered into the ToolRegistry |
| `systemPrompt` | assembled default | `null` disables the system prompt entirely; a string replaces the whole assembly |
| `maxSteps` | 12 | Hard cap on model round-trips per `run()` (clamped by `Math.max(1, …)`) |
| `root` | `process.cwd()` | Tool relative-path base and boundary |
| `onEvent` | none | Event sink |
| `signal` | none | Aborts the current run and any in-flight request |
| `toolTimeoutMs` | 30000 | Per-tool execution timeout |
| `approver` | none | Approval hook for risky operations |
| `stream` | true | Prefer `llm.stream` when available |
| `contextOptions` | see 03 | Projection pruning budgets |
| `compaction` | disabled | Auto-compaction only when `contextWindow` is set |
| `onAppend` / `onReplace` | none | Persistence hooks: fired on every appended message / whenever the whole history is rewritten |

The constructor assembles the system prompt
(`buildDefaultSystemPrompt(registry.list())`) and pushes it as the first
system message. `history` keeps growing across `run()` calls — that is
multi-turn memory.

### run(): the full course of one turn

```
run(input, { signal })
│  signal = options.signal ?? constructor signal   ← per-run cancel, without tearing down the agent
│  journal.beginTurn(reference to last message)     ← undo rewind boundary (a message reference, not an index — see 06)
│  append({ role:'user', content: input })          ← fires onAppend
│  definitions = registry.definitions()
│
│  for step = 1 .. maxSteps:
│    ├─ signal?.aborted → finish(lastContent, 'aborted')
│    ├─ emit step
│    ├─ estimate over threshold and last compaction did not fail → await compact(signal)   ← auto-compaction
│    │    (on failure, stop retrying within this run: a doomed summarization is not worth one LLM call per step)
│    ├─ emit context_usage(estimate)
│    ├─ reply = askModel(definitions, signal)   ← streaming preferred, see below
│    ├─ emit assistant
│    ├─ signal?.aborted → finish('aborted')     ← a stream cut mid-reply is a stop, not a final answer
│    ├─ append(assistant message, with tool_calls)
│    ├─ reply.usage?.totalTokens → usages.set(index of last message, usage)  ← anchor
│    ├─ reply.toolCalls empty → emit final; finish(content, 'final')
│    └─ executeBatch(toolCalls)                  ← parallel, with a per-batch rule
│         concurrent tools (the default, the      Observations are appended in
│         read-only set) run in parallel;         `tool_calls` order afterwards,
│         serial tools (write_file, edit,         so the stored history stays
│         shell) chain through a batch-local      replayable and the session write
│         write queue, one at a time              queue emits lines in the order
│           append({ role:'tool', ... }) x N      the model asked for them.
│
│  emit max_steps; finish("Stopped after N steps...", 'max_steps')
```

**Parallel tool execution.** The model is asked to batch independent calls
in one turn, and the loop executes that batch concurrently: each `Tool`
carries a `concurrency` hint — `concurrent` (the default) starts
immediately and overlaps with the rest of the batch, `serial` chains
through a queue local to the batch so a mutating call never overlaps
another mutating call. The mutating tools (`write_file`, `edit`, `shell`)
are `serial` because the undo journal records changes in execution order
and restores them in reverse (doc 06): journal order has to equal
execution order. Appending the observations happens only after the whole
batch settles, in `tool_calls` order — execution order may be
nondeterministic, the order the model sees never is.

Two load-bearing points:

- **Usage anchoring**: the provider-reported `totalTokens` covers "the
  request that produced this assistant message" (everything before it plus
  the message itself), so it is anchored at that assistant message's index;
  newer messages are estimated at chars/4 (doc 03).
- **The replayability invariant**: every `tool_call` must get a matching
  `tool` message. A cancelled call still produces an observation ("the run
  was cancelled before this call ran"), because an assistant message whose
  `tool_calls` have no results is rejected wholesale by every provider on
  the *next* request.

### askModel(): streaming and fallback

Prefers `llm.stream` (when `stream !== false` and the LLM implements it):
accumulates content, collects tool_calls, and emits a `token` event per
`delta`; if the stream throws while `signal.aborted`, the partially received
reply is returned (the caller then judges aborted), otherwise the error
propagates. Otherwise plain `chat()`. The model never sees `history`
directly — it sees the `requestView()` projection (doc 03).

### executeTool(): every failure becomes an observation

Executes one call and normalizes five failure kinds into observation strings:

| Failure | Observation |
| --- | --- |
| arguments invalid JSON | `Error: arguments were not valid JSON (...)` |
| unknown tool name | `Error: unknown tool "x". Available tools: ...` |
| arguments not an object (null/array/scalar) | `Error: arguments must be a JSON object.` |
| cancelled before starting | `Error: the run was cancelled before this call ran.` |
| threw / timed out mid-run | `Error: <reason>` (timeouts come from `withTimeout`: `tool "x" timed out after Nms`) |

The order matters: JSON parsing first (no `tool_call` event is emitted for
garbage arguments), then emit `tool_call`, then registry lookup. The
`ToolContext` is assembled here: `recordChange` goes straight to
`journal.record`, and `approve` is only injected when an approver was given
at construction.

### The three layers of cancellation

1. **Top-of-loop check**: discovering abort before a new step finishes the
   turn as aborted immediately.
2. **Inside askModel**: a stream cut mid-reply keeps the content/toolCalls
   received so far and stops as aborted rather than posing as a final answer.
3. **Tool layer**: every tool receives `ctx.signal` (shell kills its process
   tree, search aborts its walk); `withTimeout` at the agent layer and the
   tools' own cancellation together guarantee the call always ends in an
   observation.

### State management methods

| Method | Semantics |
| --- | --- |
| `reset()` | Clear conversation, keep system messages; clear usage anchors and the undo journal (undo boundaries point into a history that no longer exists); **fires onReplace** — if memory clears but the disk does not, the next resume "resurrects" the cleared conversation, which reads as /reset silently failing |
| `compact(signal?)` | Algorithm in doc 03; semantics here: returns true and fires onReplace on success; returns true even when there is nothing eligible to compact (emits an ok event so UIs say "nothing to compact" instead of a misleading "compacted"); on summary failure **history is untouched** and it returns false |
| `setLLM(llm)` | Swap models mid-session, conversation kept (the base of /model) |
| `restoreHistory(history)` | For resuming sessions; does not fire persistence hooks (the session layer owns what lands on disk); clears usage and the undo journal (changes made by another process cannot be rolled back here) |
| `setApprover` / `setPersistenceHooks` | The CLI builds readline/session files after the agent, so late wiring is allowed |
| `estimateContextTokens()` | Estimates using the **ordinary** projection, deliberately not the emergency one: this number drives compaction and the UI. Measuring the degraded view would read "squeezed just under budget" as "under budget", compaction would never trigger again, and the destructive projection would quietly become the steady state |

## 3. The system prompt (prompts/system.ts)

Three-part assembly, mirroring pi's structured prompt:

```
IDENTITY — one identity paragraph: hi-agent is a general-purpose agent that
           solves tasks by calling tools, operates inside a workspace root,
           paths are relative to it and cannot leave it, shell starts there.
# Tools  — buildToolsSection() generates "- name: snippet" lines from each
           tool's promptSnippet; all tools' promptGuidelines are merged and
           de-duplicated (Set), appended as a "- " list. Tools without a
           snippet are listed by name only.
# Rules  — 5 behavior rules:
           1. Never guess a fact a tool could give; call the tool
           2. Batch independent calls in one turn; wait for dependencies
           3. On a tool error, read it and try a different approach; never repeat unchanged
           4. Keep replies short and technical; state paths and commands exactly
           5. When informed enough, reply with the final answer as plain text
```

`promptSnippet`/`promptGuidelines` are usage guidance (when to reach for the
tool, how it cooperates with siblings); parameter detail lives in the schema
— the split is deliberate. A user-supplied `systemPrompt` string replaces the
whole assembly; `null` sends no system prompt at all.

`DEFAULT_SYSTEM_PROMPT` is the constant no-tools variant, for display paths
and backwards compatibility.
