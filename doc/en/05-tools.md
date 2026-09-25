# 05 · The Tool Set (tools/*)

Covers: `src/tools/registry.ts`, `index.ts`, `calculator.ts`, `time.ts`,
`filesystem.ts`, `edit.ts`, `search.ts`, `shell.ts`.

Tools are plain objects: name + description + JSON Schema + `execute` (plus
optional `timeoutMs` / `permission` / `promptSnippet` / `promptGuidelines`).
There is no plugin system. The path boundary is doc 04 §1 and the shell
permission chain doc 04 §4 — this document covers each tool's own behavior
design.

## 1. Registry and the default tool set

`ToolRegistry`: a name → Tool Map. Duplicate registration throws. 
`definitions()` projects `{ name, description, parameters }` — the minimal
set advertised to the model; `execute` and other runtime details stay off
the wire.

`createDefaultTools({ rules })` returns the 9 tools; `rules` carries the
persistent permission rules from project/global config and feeds only the
shell tool:

| Tool | Permission | Default timeout | In one line |
| --- | --- | --- | --- |
| `calculator` | read | 30s | Exact arithmetic (recursive-descent parser, no eval) |
| `current_time` | read | 30s | Current UTC + local time |
| `list_dir` | read | 30s | Directory listing ([dir]/[file] + sizes) |
| `read_file` | read | 30s | Read a text file or a line range |
| `write_file` | write | 30s | Create/overwrite a file (no approval; escape hatch /undo) |
| `edit` | write (declarative) | 30s | Unique-string precise replacement (no approval; escape hatch /undo) |
| `glob` | read | 30s | Find files by path pattern |
| `grep` | read | 30s | Search contents by regex |
| `shell` | dangerous | 305s (tool-owned) | Run shell commands (permission chain + process-tree management) |

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

- `MAX_READ_BYTES = 200_000`: over the limit it errors and suggests reading
  a smaller part, rather than silently truncating.
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

## 9. New-tool checklist (hard requirements from AGENTS.md)

1. **Permission review**: a side-effecting tool gets its permission level
   reviewed before joining `createDefaultTools()`; if it needs approval, call
   `ctx.approve` inside `execute` (the `permission` field is currently
   declarative metadata the loop does not read — the actual gate is inside
   the tool, doc 01 §1).
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
