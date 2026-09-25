# hi-agent Architecture Docs

This directory dissects the hi-agent project module by module. After reading
it you should be able to answer: why every line of code exists, how every
safety boundary is enforced, and what alternative each design decision gave
up.

The docs describe the source; they reference function and file names (never
line numbers, which drift).

## What this is

hi-agent is a general-purpose tool-using agent in TypeScript: an LLM-driven
loop that calls tools, reads the results, and keeps going until it can
answer. It runs on bare `node` (>= 22.18, built-in type stripping) — no
bundler, no `tsx`, no runtime dependencies (dev deps are typescript and
@types/node only).

Four hard constraints (violating any of these is a regression, see
`AGENTS.md`):

1. **No `eval`.** Model-supplied expressions go through the recursive-descent
   parser in `src/tools/calculator.ts`.
2. **Filesystem safety.** Every filesystem tool must resolve paths through
   `resolveToolPath` and refuse to escape the workspace root. The boundary is
   on the *file tools*, not on the shell: a read-only shell command can read
   any path the user can read (see the "consent vs containment" section in
   doc 04).
3. **No bundler, no `tsx`.** The source runs directly on Node's strip-only
   mode; imports carry the real `.ts` extension and only erasable syntax is
   allowed (no `enum`, namespaces, parameter properties).
4. **Shell approval chain.** Persistent deny rules → explicit allow rules →
   read-only whitelist → approver. Deny is evaluated *before* the whitelist:
   the whitelist is a convenience heuristic, and a user who writes
   `deny: ["cat *"]` must be able to close the hole it opens.

## Architecture overview

```
                     ┌──────────────────────────────────────┐
                     │ cli.ts  arg parsing / REPL / UI      │
                     └───────┬──────────────────┬───────────┘
                             │                  │
             config/sessions │                  │  events (AgentEvent)
                             ▼                  ▼
   ┌──────────┐      ┌────────────────────────────────┐
   │ config.ts│      │        agent.ts (the loop)     │
   │providers │─────▶│  history / tools / compaction  │
   └──────────┘      └───┬──────────┬──────────┬──────┘
                         │          │          │
              ┌──────────▼──┐  ┌────▼─────┐  ┌─▼──────────────┐
              │   llm.ts    │  │context.ts│  │ tools/*        │
              │ OpenAI-compat│ │projection│  │ 9 tool objects │
              │ retry/SSE   │  │/accounting│ │ (registry)     │
              └─────────────┘  └──────────┘  └────────────────┘
                                 support layer:
              session.ts (JSONL persistence)   changes.ts (undo journal)
              permissions.ts (prefix rules)    command-parse.ts (splitting)
              prompts/system.ts (system prompt assembly)
```

Data flow of one `agent.run("question")`:

1. The CLI (or a library caller) hands the input to `Agent.run()`.
2. The loop appends the user message to `history` (the full-fidelity truth)
   and fires the persistence hook.
3. Each step: `context.ts` projects a "request view" out of the history (old
   tool results pruned, history itself untouched) → if the estimate crosses
   the threshold, LLM compaction runs first → `llm.ts` sends the request
   (streaming via SSE when available).
4. When the model replies with `tool_calls`, each tool runs and every outcome
   (including errors, timeouts, cancellation) becomes a text observation
   appended to history; back to step 3.
5. A reply without `tool_calls` is the final answer; otherwise `maxSteps` or
   cancellation ends the turn.

## Module map

| File | Role | Detailed doc |
| --- | --- | --- |
| `src/types.ts` | All core contracts: ChatMessage / LLM / Tool / events / undo | [01](01-agent-loop.md) |
| `src/agent.ts` | The loop, history, tool execution and error normalization, cancellation, undo | [01](01-agent-loop.md) |
| `src/prompts/system.ts` | System prompt assembly (identity / tools section / rules) | [01](01-agent-loop.md) |
| `src/llm.ts` | OpenAI-compatible client + retry/backoff + SSE streaming | [02](02-llm-client.md) |
| `src/context.ts` | Request projection, token accounting, LLM compaction | [03](03-context-management.md) |
| `src/permissions.ts` | Shell prefix rules (allow/deny, deny wins) | [04](04-safety-and-permissions.md) |
| `src/command-parse.ts` | Shell command splitting + leading-word extraction (dialect-aware) | [04](04-safety-and-permissions.md) |
| `src/tools/*` | Tool registry and the 9 tools | [05](05-tools.md) |
| `src/session.ts` | JSONL session persistence (serialized write queues) | [06](06-session-and-undo.md) |
| `src/changes.ts` | Undo journal: what each turn wrote, how to put it back | [06](06-session-and-undo.md) |
| `src/config.ts` | Config layering (CLI > env > project > global), secret resolution | [07](07-config-and-providers.md) |
| `src/providers.ts` | Provider presets, /models discovery, models.dev window lookup | [07](07-config-and-providers.md) |
| `src/cli.ts` | Entry point: args, one-shot mode, interactive REPL, approval UI | [08](08-cli.md) |
| `src/index.ts` | The library's public surface (pure re-exports) | — |
| `test/*` | Test system (single-process runner, fake LLM, fake provider) | [09](09-testing.md) |

## Directory layout

```
src/
  types.ts             contracts: messages, model interface, tool interface, events
  agent.ts             the loop itself (the only core)
  llm.ts               the only file that knows the OpenAI wire format
  context.ts           what the model sees (projection) and window management
  session.ts           session files on disk
  changes.ts           what happened on disk, and how to reverse it
  config.ts            where keys and defaults come from
  providers.ts         which providers exist, how big their windows are
  permissions.ts       which commands run without asking
  command-parse.ts     how shell commands split into subcommands
  prompts/system.ts    what the model is told it is
  tools/               what the model can do
  cli.ts               how a human uses it
test/                  fully offline: fake LLM + local fake provider
examples/demo.ts       keyless offline demo (npm run demo)
```

## Core design principles

These four are the project's soul. Read them before changing anything:

1. **Tool failures are data, not crashes.** Bad JSON, unknown tools, thrown
   errors, timeouts, user denial — all become `Error: ...` observation text
   fed back to the model so it can correct itself. The loop only throws on
   *provider* failures (auth, HTTP, network), because nothing can be
   recovered locally.
2. **The model is just an interface.** `LLM` is one `chat` plus an optional
   `stream`. Swapping providers means editing `src/llm.ts` only; tests swap
   in a scripted fake.
3. **Tools are just objects.** Name + description + JSON Schema + `execute`,
   plus the `promptSnippet`/`promptGuidelines` that feed the system prompt.
   No plugin system.
4. **History is truth, requests are projections.** `agent.history` keeps full
   fidelity (the base for persistence and rewind); the model only ever sees
   the output of the projection. The single exception is `compact()`, which
   deliberately trades detail for the ability to continue — and must leave
   the history byte-identical on failure.

## Glossary

| Term | Meaning |
| --- | --- |
| turn | One `agent.run()`: from user input to the final answer |
| step | One model round-trip within a turn (request + reply + tools) |
| observation | The `role: "tool"` message text a tool result becomes |
| projection / request view | The message list actually sent to the model, derived from history by pruning rules |
| compaction | LLM-summarizing the old history into one system message and replacing it |
| prune | Projection-layer truncation of old long tool results to head+tail+marker (history untouched) |
| dialect | The shell dialect (`posix` / `powershell`) the parser picks escaping rules for |

## Reading paths

- **Just want the core**: 01 → 02 → 05. Those files (`types.ts`, `agent.ts`,
  `llm.ts`, `tools/registry.ts`) are under two thousand lines together — the
  whole skeleton.
- **Security review**: doc 04 (safety boundaries and permissions) is
  mandatory, then the shell tool in 05 and the adversarial testing
  requirements in 09.
- **Adding a feature**: 05 has the new-tool checklist, 07 explains how
  config plugs in, 09 how to write the tests.
- **Debugging production**: 06 (session file format and write queues),
  02 (retry and timeout semantics), 08 (CLI behavior and exit codes).
