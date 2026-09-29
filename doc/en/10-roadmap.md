# 10 · Roadmap

This doc turns the 2026-09 feature comparison against **DeepSeek Harness**
(`dsh`, everything-is-a-plugin, Web UI first) and **Pi** (earendil-works,
extension-first coding agent) into a concrete plan. Both were inventoried
feature by feature; only what fits hi-agent's identity was admitted.

Every item here must pass the same three tests:

- **It is an addition on top of the same loop, not a rewrite.** Nothing
  below requires restructuring `agent.ts`; new capability lands in new
  tools, new adapter files, or existing seams.
- **It keeps the core readable.** If a feature needs a framework, a runtime
  dependency, or a second build system, it does not belong (see "Explicitly
  out of scope").
- **It keeps the safety story honest.** New side effects get a permission
  review before they enter `createDefaultTools()`; new file writes go
  through `ctx.recordChange`; the read-before-write and `resolveToolPath`
  rules of doc 05 still apply.

Items are grouped by priority, not size. Dependencies are called out
inline; nothing else is ordered.

## P1 — fully shipped (see "Shipped" below)

## P2 — after P1

### 8. Workspace instructions (auto-load `AGENTS.md`)

**Problem.** Per-project rules must be repeated in `--system` on every
invocation. (dsh injects workspace instructions; pi loads project context
files behind a trust gate.)

**Sketch.** On start, `AGENTS.md` from the workspace root is loaded into
the system prompt's rules section with a byte cap; `--no-agents-md` opts
out. Root file only in v1. It is model-facing text from the repo — the
same trust level as the code it describes; the docs should state that
prompt injection from a hostile repository is in scope, not solved here.

### 9. Skills (`SKILL.md` directories)

**Problem.** Reusable procedures live in users' heads or in paste history.
(pi implements the agentskills.io spec; dsh has a skill registry and ships
packaged skills.)

**Sketch.** `<root>/.hi-agent/skills/<name>/SKILL.md` plus a global
directory. Name + description ride the existing `promptSnippet` mechanism
into the system prompt; a `skill` tool returns the full body on demand as
an observation. Nothing else changes.

### 10. Tool-output spill to file

**Problem.** The shell tool keeps the tail (2000 lines / 50 KB) and
silently discards the head — the model cannot recover what it never saw.
(pi saves full output to a temp file and hands the model a truncated view
plus a path; dsh spills oversized results to files with locators.)

**Sketch.** When a tool result exceeds a spill threshold, write the full
text to a scratch file inside the workspace (`.tmp-*` is already the
gitignored convention) and let the observation carry head + tail +
`[full output: <path>]`, so `read_file` can retrieve any range. The
prune markers in `context.ts` can point at the same file.

### 11. Agent-level retry and overflow recovery

**Problem.** `llm.ts` retries transient HTTP failures, but when the
provider rejects a request because the context is too long, the turn dies
— even though `compact()` exists and would fix it. (pi: agent-level
auto-retry with backoff, plus compact-and-retry on overflow.)

**Sketch.** In `agent.ts`'s step error handling: if the already-retried
provider failure indicates a context-length overflow, run `compact()` and
retry the step once. If compaction fails or the retry overflows again,
rethrow — the loop still only throws when nothing local can help, which
keeps design principle 1 intact.

### 12. Cost display

**Problem.** Usage is tracked and anchored per assistant message
(`hasUsageBasis`), but only verbose mode shows a token count; no cost
anywhere. (pi attaches `usage.cost.total` per message; dsh has a token
meter with context pressure.)

**Sketch.** `providers.ts` already fetches the models.dev catalog for
context windows — read pricing from the same catalog entry into the same
in-process cache, and let the CLI show per-turn and session cumulative
estimates at list prices. Label them as estimates: cache pricing varies.

### 13. Todo list tool

**Problem.** Long multi-step work has no visible plan the model and the
user can agree on. (dsh: `todo_write` with a durable per-session checklist
and UI rendering; pi: extensions.)

**Sketch.** A `todo_write` tool owning an in-memory checklist, persisted
as a custom JSONL line kind in the session file — the loader already
skips unknown line kinds, so old and new versions interoperate. The CLI
renders it; a later plan mode (dsh-style soft guidance with an
exit-approval tool) can build on it.

### 14. Background shell

**Problem.** The shell tool caps at 300 s and blocks; dev servers, long
builds and watches are out of reach. `tail -f` is blocked today precisely
because there is no other way to watch something. (dsh: a job runtime
behind background bash, PTYs and subagents.)

**Sketch.** `run_in_background` on the shell tool returns a job id
immediately; `job_output` and `job_kill` manage running jobs; output
ring-buffers and spills per item 10. Process-tree tracking (`taskkill /T`
on Windows, negative-pid group kill on POSIX) already exists and is
reused. Jobs are killed on CLI exit, next to `flushSessions()`.

**Guardrails.** The approval chain still gates the launch command —
background changes the *when*, never the *whether*.

## P3 — carried or optional

### 15. Image input

Depends on item 3.2 (content blocks). A `read_image` tool, or an image
mode of `read_file`; the CLI gains paste/drag. No vision logic anywhere in
the loop — images are payload, not features.

### 16. Markdown / diff rendering (optional)

A zero-dependency ANSI markdown renderer plus diff highlighting for `edit`
results. pi's largest investment is its TUI framework; only this slice is
worth taking, and only if it stays small. Plain text remains the fallback
on non-TTY.

### 17. Long-term memory (carried from the old roadmap)

Memory beyond session files. Realistic shape after item 7: an MCP memory
server, or a bounded workspace memory file that a `memory_write` tool
maintains and the system prompt loads. Do not build a vector store.

## A maintenance decision, made

**`Tool.permission` was declarative, and nothing read it** — the loop never
consulted the field; `write_file` and `edit` ran without approval (their
boundary is the workspace root plus `/undo`). Decided before the
side-effecting tools of items 2, 6, 7 and 14 landed: **the field is
dropped.** Every real gate in this codebase is per-call — the shell command
(read-only whitelist + rules), the fetched URL (web_fetch, private
addresses), the config allow-list (MCP tools) — so a static per-tool enum
could not drive any of them: wired into the waterfall it would either break
the shell's read-only whitelist or reduce to a no-op. Where a call needs
consent, the tool calls `ctx.approve` inside `execute`, with the per-call
check stated next to it. A tool whose risk could be decided per tool rather
than per call would be the wrong shape.

## Explicitly out of scope

Rejected on identity grounds — proposals to add these are declined by
default:

- **Web UI, desktop shell, SDK, ACP server.** dsh's battlefield. Any one
  of them ends the "read the whole core in one sitting" promise.
- **Plugin system, plugin marketplace, agent self-modification.** Design
  principle 3 is deliberate. Declarative config, prompt templates, skills
  and MCP cover the legitimate need.
- **OS sandboxing** (Landlock / Seatbelt / restricted tokens). Valuable
  and platform-specific; the documented boundary stays "consent vs
  containment" (doc 04) until someone builds it deliberately.
- **Alt-screen TUI framework, themes, keybinding system.** pi's biggest
  surface. The plain readline REPL is a feature.
- **Telemetry, benchmarks, scheduling, an i18n framework.** Not concerns
  of a single-user CLI; the bilingual docs (en/zh) already cover the real
  need.

## Shipped (formerly on this list)

- Context compaction — auto-triggered with a discovered `contextWindow`,
  or `/compact` (doc 03).
- Session persistence — `--continue` / `--resume`, `/session`, JSONL
  (doc 06).
- Undo — `/undo` via the `changes.ts` journal (doc 06).
- Parallel tool execution (item 1) — the `tool_calls` of one step run
  concurrently; each `Tool` carries a `concurrency` hint (`concurrent`
  default, `serial` for the mutating `write_file`/`edit`/`shell`), and
  observations are appended in `tool_calls` order so the history stays
  replayable and journal order equals execution order (doc 01).
- Reasoning content, content blocks, native providers (item 3) — staged:
  (3.1) `reasoning_content` is captured into an agent-local `reasoning`
  field, displayed by the CLI, stripped by the projection, excluded from the
  token estimate; (3.2) `ChatMessage.content` carries `ContentBlock` arrays
  (text / image / thinking) beside the text-compatible string form, flattened
  by `textOfContent` wherever only text can go; (3.3) native adapters
  `llm-anthropic.ts` and `llm-google.ts` implement the same `LLM` interface,
  selected by a `protocol` field on the provider preset (doc 02).
- Session fork (item 4) — `/fork [n]` writes a new session file (header plus
  one full-history snapshot line, the exact format compaction already uses)
  holding the conversation up to the end of the `n`-th user turn, and the
  REPL continues there; the source file is untouched (doc 06 §6). A real
  branch tree stays a later, separate change.
- Custom slash commands (item 5) — markdown prompt templates in
  `.hi-agent/commands/<name>.md` (project) and `<configDir>/commands/`
  (global); `$ARGUMENTS` is substituted with the typed arguments and the
  expansion becomes a user message. Declarative data, not code — principle 3
  intact; built-ins keep precedence (doc 08 §7).
- Sub-agents (item 6) — the `task` tool spawns a nested `Agent` as a library
  caller (zero `agent.ts` changes): own history, read-only default tool set,
  own `maxSteps`, 600s timeout, the parent's abort signal, approvals passed
  through to `ctx.approve`. The final answer — or stop reason — is the
  observation; sub-runs are not persisted in v1 (doc 05 §10).
- MCP client (item 7) — hand-written newline-delimited JSON-RPC over stdio
  (no SDK, no runtime dependency, no dynamic imports); `mcpServers` config
  with an explicit env map; discovered tools mount as `mcp__<server>__<tool>`
  through the registry's one new concept, a `ToolSource`; every call requires
  approval unless allow-listed, and the trust model is documented plainly
  (doc 04 §7b, doc 05 §11).
- Web access (item 2) — `web_fetch` first: a client-side GET with timeout,
  download/content caps, a content-type gate, a minimal HTML-to-text pass,
  and approval for private/loopback targets (doc 05 §9). Then `web_search`
  as a thin client for a config-chosen API (Brave / Exa / Perplexity, doc
  07); the provider-native server-side web tools remain deferred until the
  per-provider protocol work below exists in the request pipeline itself.
