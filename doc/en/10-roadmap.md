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

## P1 — next up

### 1. Parallel tool execution

**Problem.** The system prompt already asks the model to batch independent
calls in one turn, but `agent.ts` executes them one at a time: a batch of
five file reads pays five sequential round-trips of latency. (pi runs tool
calls in parallel by default; dsh executes batched calls concurrently.)

**Sketch.** Run the `tool_calls` of one step concurrently, but append the
observations to history in the same order as the `tool_calls` array — the
stored history must stay replayable, and the per-file write queue in
`session.ts` serializes appends, so the order is decided before the first
write. Mutating tools (`write_file`, `edit`, shell) are serialized through
a queue; only reads run concurrently. A cancelled call still produces its
observation, as today (doc 01).

**Lands in.** `agent.ts` (tool execution), a serial/concurrent hint on
`Tool` in `types.ts` (or reuse `permission`), new cases in `test/`.

**Guardrails.** The `changes.ts` journal records per turn and restores in
reverse order; serializing writes keeps journal order equal to execution
order.

### 2. Web access: `web_fetch`, then `web_search`

**Problem.** hi-agent is fully offline: anything needing current
information — docs, package registries, APIs — fails. This is the largest
capability gap against both reference projects. (dsh ships `web_fetch` /
`web_search` with pluggable backends: DeepSeek search, Exa, Perplexity,
plain HTTP; pi leaves it to extensions.)

**Sketch.** `web_fetch`: GET over global `fetch` with timeout, redirect
cap and size cap; content-type gate (`text/*`, `application/json`); a
minimal HTML-to-text pass (drop `script`/`style`, decode entities — full
markdown conversion is not a v1 requirement); truncation consistent with
the other tools. It never executes JS. Requests to loopback/private
addresses go through the approver: a tool that fetches
`http://localhost:…` is a door into the intranet. Whatever the provider,
`web_fetch` stays a client-side implementation: provider-independent,
offline-testable, approvable — and fetching a user-given URL is a need
no search backend covers.

`web_search` lands after `web_fetch`, with two backend classes. The
default one is a thin client for a config-chosen search API (Brave /
Exa / Perplexity), i.e. a fetch of a search API. The second class is the
provider's native server-side web tool — DeepSeek's native web search
(Anthropic-style tool declaration), Anthropic's `web_search` /
`web_fetch` server tools, OpenRouter's `:online` suffix. These are not
standard OpenAI Chat Completions fields: they are reachable only through
the per-provider protocol work of item 3, and their results arrive as
content blocks (`server_tool_use`, citations) that only 3.2's message
model can carry. They complement the client-side tools rather than
replace them — provider-tied and billed per call, where the client-side
tools work against every endpoint.

**Lands in.** `src/tools/web.ts` (new), `config.ts` (search backend key),
`prompts/system.ts` (tool snippets).

**Guardrails.** Doc 05's new-tool checklist applies; `permission` must be
reviewed like any side effect (see the maintenance decision below).

### 3. Reasoning content, content blocks, native providers

**Problem.** `ChatMessage` is text-only. OpenAI-compatible reasoning
providers (DeepSeek included) stream `reasoning_content`, which `llm.ts`
drops today; Anthropic and Google native APIs are unreachable; images have
no carrier. (pi normalizes ~35 providers behind one streaming event
vocabulary with explicit thinking levels; dsh exposes per-route reasoning
effort.)

**Sketch.** Staged, each stage useful on its own:

1. Capture `reasoning_content` into an optional `reasoning` field on the
   assistant message: displayed by the CLI, stripped by the projection in
   `context.ts` so it is never sent back (reasoning providers reject
   requests that echo it), excluded from the token estimate.
2. Promote `ChatMessage.content` to blocks (text / image / thinking) with
   a text-compatible shape. Session files survive unchanged: message lines
   are JSON and the loader tolerates optional fields. `serializeForSummary`
   in `context.ts` learns to flatten blocks.
3. Native adapters — `llm-anthropic.ts`, `llm-google.ts` — implementing the
   same `LLM` interface from `types.ts`, selected by a `protocol` field on
   the provider preset in `providers.ts`. The loop never learns about wire
   formats; "the model is just an interface" (doc README, principle 2)
   holds.

**Lands in.** `types.ts`, `llm.ts` (+ the new adapter files), `context.ts`,
`cli.ts`, `providers.ts`.

### 4. Session fork (then a branch tree)

**Problem.** Sessions can only be switched, not split: one wrong direction
poisons the rest of the file. (pi has `/tree`, `/fork`, `/clone` with
edit-and-resubmit; dsh forks at turn boundaries.)

**Sketch.** `/fork [n]` first: write a new session file containing a
header plus a full-history snapshot line of the current history up to
turn `n`. The compaction snapshot already defines exactly this line
format, so replay needs no new code path. A real branch tree (parent
pointers per line, `/tree` navigation, edit-and-resubmit) is a later,
separate change; note that compaction already keeps pre-snapshot lines on
disk, which is what a future tree will need.

**Lands in.** `session.ts`, `cli.ts`.

### 5. Custom slash commands (prompt templates)

**Problem.** The slash commands are hard-coded in `cli.ts`; users cannot
add their own reusable prompts. (pi: registered commands plus markdown
prompt templates; dsh: a commands registry dispatched without a model
turn.)

**Sketch.** `.hi-agent/commands/<name>.md` (project) and
`<configDir>/commands/` (global). The file body is a prompt template;
`$ARGUMENTS` is substituted with what the user typed after the command;
`/name args` expands into a user message. Declarative data, not code —
design principle 3 (no plugin system) stays intact. Built-ins keep
precedence.

**Lands in.** `cli.ts`, `config.ts`, both doc trees.

### 6. Sub-agents: the `task` tool

**Problem.** One context carries everything; a broad exploration drowns
the main thread and there is no way to parallelize research. (dsh: a
subagent registry plus control tools like send/interrupt; pi: an official
extension example.)

**Sketch.** A `task` tool whose `execute` spawns a nested `Agent` with its
own history, a restricted tool set (read-only by default), its own
`maxSteps`, and the parent's abort signal. The final answer — or the stop
reason — becomes the observation; "tool failures are data" means a failed
sub-agent is an `Error: …` observation, not a crash. Approvals propagate
to the same `ctx.approve`. Sub-runs are not persisted as sessions in v1.

**Lands in.** `src/tools/task.ts` (new). Ideally no change to `agent.ts`:
a sub-agent is a library caller, which is what the public surface in
`src/index.ts` exists for.

**Guardrails.** Writes inside a sub-agent are untracked by `/undo` unless
explicitly allowlisted — the default read-only tool set exists for that
reason.

### 7. MCP client

**Problem.** The MCP ecosystem (databases, browsers, APIs) is unreachable,
and hand-writing every integration contradicts the minimal core. (dsh
mounts external MCP servers as native tools; pi deliberately has none —
which makes this a differentiator, not cargo-culting.)

**Sketch.** stdio transport only. MCP over stdio is newline-delimited
JSON-RPC between the agent and a child process — the process management
`shell.ts` already does, with no SDK, no runtime dependency, and none of
the dynamic imports AGENTS.md forbids. `mcpServers` in config declares
command, args, and an explicit env map (never `process.env` — same rule as
`childEnv()`). Discovered tools are exposed as `mcp__<server>__<tool>` via
a dynamic tool source; `tools/registry.ts` (static today) gains exactly
one concept: a registry that can also ask a source for its tools. MCP
tool failures normalize into observations like any other tool.

**Lands in.** `src/mcp.ts` (new), `tools/registry.ts`, `config.ts`.

**Guardrails.** An MCP server is arbitrary third-party code running with
user rights — the same trust class as the shell. Every MCP tool call
requires approval unless allow-listed in config, and the docs say so
plainly.

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

## A maintenance decision, not a feature

**`Tool.permission` is declarative today, and nothing reads it.** The loop
never consults the field; `write_file` and `edit` run without approval
(their boundary is the workspace root plus `/undo`). Decide before adding
the side-effecting tools from items 2, 6, 7 and 14: either wire
`permission` into a real approval waterfall (deny rules → allow rules →
per-tool policy → approver, mirroring the shell chain), or drop the
field. Carrying a dead security-looking field is the worst option.

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
