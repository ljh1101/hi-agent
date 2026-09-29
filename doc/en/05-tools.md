# 05 · The Tool Set (tools/*)

Covers: `src/tools/registry.ts`, `index.ts`, `calculator.ts`, `time.ts`,
`filesystem.ts`, `edit.ts`, `search.ts`, `shell.ts`, `web.ts`, `task.ts`.

Tools are plain objects: name + description + JSON Schema + `execute` (plus
optional `timeoutMs` / `concurrency` / `promptSnippet` / `promptGuidelines`).
There is no plugin system. The path boundary is doc 04 §1 and the shell
permission chain doc 04 §4 — this document covers each tool's own behavior
design.

`concurrency` schedules the calls of one batch (doc 01): `concurrent` (the
default) overlaps with the rest of the batch; `serial` runs one at a time in
`tool_calls` order. The mutating tools are `serial` — `write_file`, `edit`,
`shell` — because the undo journal records in execution order (doc 06).

Approval behavior lives *inside* each tool, not on a field: the old
`Tool.permission` badge (read/write/dangerous) was declarative metadata the
loop never read, and every real gate in this codebase is per-call (the shell
command, the fetched URL, the MCP allow-list), so the field was dropped.
Where a call needs consent the tool calls `ctx.approve` in `execute`.

## 1. Registry and the default tool set

`ToolRegistry`: a name → Tool Map. Duplicate registration throws. 
`definitions()` projects `{ name, description, parameters }` — the minimal
set advertised to the model; `execute` and other runtime details stay off
the wire.

`createDefaultTools({ rules, webSearch, getLLM })` returns the 12 tools;
`rules` carries the persistent permission rules from project/global config and
feeds only the shell tool; `webSearch` arms `web_search` with its backend
(doc 07); `getLLM` enables the `task` sub-agent tool (its model is resolved
per call, so `/model` swaps apply to sub-agents too):

| Tool | Approval | Default timeout | In one line |
| --- | --- | --- | --- |
| `calculator` | none | 30s | Exact arithmetic (recursive-descent parser, no eval) |
| `current_time` | none | 30s | Current UTC + local time |
| `list_dir` | none | 30s | Directory listing ([dir]/[file] + sizes) |
| `read_file` | none | 30s | Read a text file or a line range |
| `write_file` | none (bounded by the root + `/undo`) | 30s | Create/overwrite a file |
| `edit` | none (bounded by the root + `/undo`) | 30s | Unique-string precise replacement |
| `glob` | none | 30s | Find files by path pattern |
| `grep` | none | 30s | Search contents by regex |
| `shell` | deny → allow → read-only whitelist → approver | 305s (tool-owned) | Run shell commands (permission chain + process-tree management) |
| `web_fetch` | public URLs free; private/loopback → approver | 20s (tool-owned) | Fetch a URL, HTML → text (no JS execution) |
| `web_search` | none (calls the configured search API) | 20s (tool-owned) | Web search via the configured backend (doc 07) |
| `task` | approvals propagate to the parent | 600s (tool-owned) | Sub-agent with its own context and a read-only tool set |

## 2. calculator (calculator.ts)

The expression a model supplies is **untrusted input**, so evaluation is a
hand-written recursive-descent parser:

```
expression := term (('+' | '-') term)*
term       := unary (('*' | '/' | '%') unary)*
unary      := ('+' | '-') unary | power
power      := primary ('^' unary)?          ← right associative
primary    := number | identifier | '(' expression ')'
```

- Function whitelist: `sqrt abs round floor ceil min max pow log sin cos
  tan`; constants: `pi`, `e`. Identifiers are case-insensitive; numbers
  support scientific notation.
- Explicit errors instead of guessing: division by zero, exponentiation
  overflowing to a non-finite value, NaN/overflow from a function, unknown
  function/identifier, missing parenthesis, trailing characters.
- Returns `expression = value`. The tool layer validates `expression` as a
  non-empty string.

This is where the hard constraint "no eval" lands: not a single
`new Function`/`eval` anywhere.

## 3. current_time (time.ts)

The model has no clock. Returns three lines: ISO 8601 UTC, the local time
string, and the `UTC+HH:MM` offset. No parameters.

## 4. filesystem (filesystem.ts): read_file / write_file / list_dir

Behavior design beyond the path boundary (doc 04):

### read_file

- `MAX_READ_BYTES = 200_000` bounds what the tool **returns**, not which
  files may be read: a full read of a larger file errors and points at
  `offset`/`limit` (which work on files of any size); a range read whose
  lines exceed the cap errors asking for a smaller `limit`. Nothing is
  silently truncated.
- Line ranges: `offset` (1-based) + `limit`; range mode numbers the lines
  and emits the header `path (lines a-b of N, CRLF?)`. An out-of-range
  `offset` degrades gracefully (reports the line count instead of throwing);
  non-positive integers error immediately.
- An empty file returns `(path is empty)` — the model can tell "empty" from
  "failed".
- The model only ever sees LF (line-ending system in §5).

### write_file

- Parent directories created recursively (`mkdir -p`).
- **Line-ending preservation**: overwriting an existing file keeps that
  file's EOL; new files use LF (§5).
- **Failure semantics of the before-snapshot read**: the file is read once
  before writing, both to detect the EOL and to snapshot for undo. That read
  tolerates **only ENOENT** (treated as a new file, `before: null`); any
  other read failure (permissions etc.) throws — swallowing a real failure
  as "the file is new" would make undo *delete* a file that exists.
- On success `recordChange({ path, before, after: payload })`, returning the
  written byte count.

### list_dir

Entries sorted; directories as `[dir] name/`, files as
`[file] name (N bytes)` (a failed stat omits the size rather than failing
the whole listing). Empty directories get a placeholder.

## 5. The line-ending subsystem (in filesystem.ts, shared by three tools)

Root cause: **the model can only emit LF** — `\r` cannot survive a
tool-call argument, and the read side strips `\r\n`; exposing `\r` would
only create text the model cannot reproduce. So the tools manage line
endings on the model's behalf:

- `detectLineEnding`: **purity-based** — a file counts as CRLF only when
  *every* newline is part of a `\r\n` pair. One stray `\r\n` must not
  reclassify an LF file, or editing one line becomes a whole-file rewrite
  (and a destroyed git blame). A lone `\r` (classic Mac) is not a line
  ending: it passes through as ordinary text and is never rewritten.
- `normalizeLineEndings` (only `\r\n` → `\n`, the model's view) and
  `applyLineEnding` (restore the file's own EOL on write).
- `splitLines`: splits on both endings, dropping the trailing empty element
  a final newline produces.

## 6. edit (edit.ts)

Exact-string replacement (str-replace, like Claude Code's Edit / opencode /
Cline): replace the smallest meaningful span instead of rewriting the file,
so the diff is minimal and the rest of the file is never disturbed.

Rules and design:

1. `old_string` must appear in the file **exactly once** — 0 is an error
   (not found), >1 is an error (ambiguous); the error message coaches the
   model to include more surrounding lines for uniqueness.
2. `old_string === new_string` is rejected (nothing would change).
3. **Match in LF space**: file and needle are both normalized to LF before
   comparison, and the file's own EOL is restored on write. The model cannot
   emit `\r`, so a byte-wise comparison would make a multi-line
   `old_string` in a CRLF file match *never*. If `old_string` contains `\r`
   and the file is CRLF, a hint suggests plain LF.
4. `recordChange({ path, before: raw, after: updated })` — the snapshot is
   the **raw bytes** (CRLF included), so undo restores exactly
   (`test/agent.test.ts` asserts down to line endings).

## 7. search (search.ts): glob / grep

### The directory walk (shared by both)

- Unreadable subdirectories are skipped, not fatal (permission races,
  deleted dirs);
- **symlinked directories are not followed** (isSymbolicLink is neither file
  nor dir — ignored), so cycles cannot recurse forever and links cannot read
  outside the root;
- the skip set = built-in `DEFAULT_SKIP_DIRS` (node_modules/.git/dist/
  .next/build/.cache) ∪ directory entries from the root `.gitignore` (parsed
  leniently: comments/negations/blanks dropped, first path segment taken);
- `ctx.signal` aborts the walk, and `throwIfAborted` turns cancellation into
  an error rather than delivering a partial list that looks complete.

### globToRegex (hand-rolled, no dependency)

Matches against POSIX-separated relative paths. `**` = any depth (swallows
slashes), `*` = anything within one segment, `?` = one character,
`{a,b}` = alternation, `[...]` = passed through as a character class, every
other character escaped.

### glob

Results are relative paths, sorted, capped at `MAX_MATCHES = 200` with the
remainder reported. "No matches" is stated explicitly (distinct from an
error).

### grep

- An invalid regex errors with the regex engine's message (readable by the
  model);
- an `include` glob filters files (matched against the basename when it has
  no `/`);
- **binary files are skipped**: a NUL byte anywhere means not text;
- each line is truncated at 500 characters; results capped at 200 lines;
- `context: N` emits context blocks (`file-N-line-N-content`; matching lines
  marked with `:`, context lines with `-`, blocks separated by `--`, the
  trailing separator stripped); `context: 0` uses the compact
  `file:line:content` format.

## 8. shell (shell.ts)

Arguments: `command` (required, non-empty), `timeout` (seconds, 1–300),
`workdir` (relative to the root, **validated through `resolveToolPath`**).
Execution and the security machinery are doc 04 §4–§6; the loop-facing
contract here:

- Permission chain first, spawn second; any rejection along the chain
  **throws** (the agent converts it to an observation), and the message
  instructs the model not to rephrase or restructure around the denial but
  to ask the user — the same discipline repeated in the tool description and
  promptGuidelines.
- `timeoutMs: AGENT_FALLBACK_TIMEOUT_MS` (305s) overrides the agent default
  of 30s: the tool's own 300s cap (including killing the tree) fires first;
  the agent-level timeout is only a backstop.
- Output: stdout+stderr merged, tail kept (2000 lines / 50KB), truncation
  marked `[output truncated; only the tail is shown]`.
- Non-zero exit, timeout, and abort all throw with the captured output — the
  model can read the failure scene.

## 9. web (web.ts): web_fetch / web_search

**web_fetch** is deliberately a client-side implementation (roadmap item 2):
provider-independent, offline-testable, approvable. One GET over the global
`fetch`:

- **Bounds**: a 20s timeout (combined with `ctx.signal` through
  `AbortSignal.any`), a 2MB *incremental* download cap (the stream is
  abandoned mid-body, never downloaded whole), and a 20,000-character content
  cap with a truncation marker. Redirects follow the platform default cap;
  the **final** URL is re-checked against the private-address gate below
  before any content is shown.
- **Content-type gate**: `text/*`, `application/json`, `application/xml`,
  `application/xhtml+xml`; anything else (binary payloads) is refused. HTML
  goes through a minimal converter: comments and
  `script`/`style`/`noscript`/`template` subtrees dropped, block tags become
  line breaks, remaining tags stripped, named + numeric entities decoded,
  whitespace collapsed. It never renders and never executes JavaScript. JSON
  passes through untouched.
- **The intranet gate (consent, not containment — doc 04)**: a fetch tool is
  one call away from the user's network. `isPrivateHost` classifies hostname
  literals — `localhost`/`*.localhost`/`*.local`, IPv4 `0/8`, `10/8`, `127/8`,
  `172.16/12`, `192.168/16`, `169.254/16`, IPv6 `::1`, `::`, `::ffff:`-mapped
  IPv4, `fc00::/7`, `fe80::/10` — and a request to any of them requires
  `ctx.approve` (denied by default with no approver). Approving one host does
  not extend to a *different* private host reached by redirect: an approval
  for `127.0.0.1` does not cover `localhost`.

**web_search** is a thin client for one config-chosen API: `brave` (GET
`api.search.brave.com`, `x-api-key` header), `exa` (POST `api.exa.ai/search`),
or `perplexity` (POST `api.perplexity.ai/chat/completions`, an answer plus
citations). The backend comes from config (doc 07); with none configured the
tool explains how to add one instead of failing silently. Results format as
`[n] title — url` with a snippet, capped like `web_fetch`. Provider-native
server-side web tools (DeepSeek / Anthropic / OpenRouter `:online`) are a
different, later mechanism — they need roadmap item 3's per-provider protocol
work and item 3.2's content blocks.

## 10. task (task.ts): the sub-agent

`execute` spawns a nested `Agent` — a library caller, no `agent.ts` changes:

- **Own context, own tool set**: the sub-agent's history starts empty with the
  prompt as the brief; its default tools are the read-only set (calculator,
  current_time, list_dir, read_file, glob, grep). No writers and no shell —
  sub-agent writes would be untracked by the parent's `/undo` journal, so the
  default gives them nothing to write with; write-capable sets are an explicit
  `tools` opt-in whose changes stay in the sub-agent's own throwaway journal.
- **Own step budget** (`maxSteps`, default 12) and a 600s tool timeout — the
  30s default would kill real sub-runs.
- **Shared cancellation and consent**: the parent's abort signal is the
  sub-agent's signal; `ctx.approve` becomes the sub-agent's approver, so a
  sub-agent cannot escape the consent chain.
- **The result contract**: final answer → observation text; `max_steps` →
  RunResult's "Stopped after N steps..." content; abort → `Error: the task
  was cancelled`; a provider failure throws and becomes an `Error: ...`
  observation like any other tool ("tool failures are data").
- **No recursion** (the default set excludes `task` itself) and **no
  persistence** (sub-runs never become sessions in v1).
- The LLM arrives through a `getLLM()` closure resolved per call — a
  mid-session `/model` swap applies to sub-agents too.

## 11. New-tool checklist (hard requirements from AGENTS.md)

1. **Approval review**: a side-effecting tool has its approval behavior
   reviewed before joining `createDefaultTools()`; where a call needs
   consent, `execute` calls `ctx.approve` with a per-call check (the shell
   command, the fetched URL, the configured allow-list) — there is no static
   risk field, and a tool that would need one per tool rather than per call
   is the wrong shape.
2. **Writing a file requires `ctx.recordChange`** with the replaced content —
   a writer that skips it makes its own change un-undoable.
3. **Anything touching the filesystem goes through `resolveToolPath`**
   (never `resolveInsideRoot` directly — it cannot see links).
4. **Feed the system prompt**: write `promptSnippet` (when to reach for it)
   and `promptGuidelines` (behavior rules; merged and de-duplicated with the
   other tools').
5. **Parameter schema**: `additionalProperties: false` + precise
   descriptions; say when to use it and when a sibling tool fits better.
6. If the tool lets the model write shell commands or touches command
   parsing: changes to `isReadOnlyCommand` require dual-dialect adversarial
   cases in `test/shell.test.ts`.
7. Timeout budget: default 30s; long-running tasks declare `timeoutMs`.
