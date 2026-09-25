# 08 · The CLI (cli.ts)

Covers: `src/cli.ts` — argument parsing, config wiring, one-shot mode, the
interactive REPL, the approval prompt, event rendering. All business logic
lives in the layers below; this file is UI and assembly only.

## 1. main() end to end

```
loadDotEnv → parseArgs
  → --help / --list-providers → print, exit
  → resolveConfig(options, {root})        ← the precedence chain in doc 07
  → (options.setup or no key with TTY) → setupFirstRun
  → still no key → error, exit (points to --setup / npm run demo)
  → load and merge permission rules (project + global, mergeRules in doc 04)
  → --continue / --resume → load the previous session (see §4)
  → new Agent({...}) + restoreHistory + setApprover
  → options.prompt present → one-shot mode; otherwise → repl()
```

## 2. Arguments (CliOptions)

| Flag | Effect |
| --- | --- |
| positional args | joined into a one-shot prompt |
| `-m/--model`, `--base-url`, `--api-key` | top of the config precedence chain |
| `--max-steps <n>` | model round-trips per turn (validated positive integer, default 12) |
| `--system <text>` | replaces the whole system prompt |
| `--root <dir>` | workspace root (default cwd) |
| `--setup` | force the first-run setup wizard |
| `--list-providers` | print the provider presets |
| `-c/--continue` | resume the most recent interactive session |
| `--resume <id>` | resume by id (exact, then prefix match, case-insensitive) |
| `--yes` | auto-approve everything (trusted containers/CI only) |
| `-s/--stream`, `--no-stream` | streaming toggle (default on) |
| `-v/--verbose` | model narration, full tool output, step/context lines |
| `-h/--help` | help |

## 3. setupFirstRun (the first-run wizard)

TTY only. Flow: print provider presets → pick a number or `0` for a manual
baseURL → enter the key → `pickModel` (`listModels` live discovery; manual
fallback, suggestedModel as default) → `lookupContextWindow` (skipped on
failure, with or without a notice) → `saveGlobalConfig`. Any empty required
answer cancels with an explanation.

## 4. Session resume (--continue / --resume)

`listSessions`, then by id (exact → prefix) or the newest one; `loadSession`
provides the history → `agent.restoreHistory`. The REPL's `store.id` points
at the original file, so **subsequent turns keep appending to the original
session file**. No match / nothing to resume → error, exit code 1.

## 5. One-shot mode (hi-agent "prompt")

- The approver is wired only when `stdin.isTTY && !options.yes` — piped/CI
  runs have nobody to answer approvals, so risky commands hit the "no
  approver, deny by default" path (doc 04).
- SIGINT → `AbortController.abort`: the turn ends cleanly as aborted (the
  shell tool kills its process tree, observations are completed, history
  stays replayable) instead of a stack trace killing the process.
- `stopReason !== 'final'` → exit code 1.

## 6. The interactive REPL

### Persistence wiring

- `ensureSession`: lazily creates the session file before the first turn
  (`newSessionId` + header); resumed sessions backfill createdAt from the
  file header.
- `agent.setPersistenceHooks`: `onAppend` → `appendMessage`, `onReplace` →
  `appendCompaction` (doc 06). Both are **fire-and-forget** (the loop never
  waits for disk), but a rejection must be caught — an unhandled rejection
  takes the process down in newer Node: `reportWriteError` prints in red and
  the session stays usable.
- `flushSessions()` in the exit finally: every in-flight append lands before
  the process exits.

### SIGINT's two meanings

`inFlight` holds the current turn's AbortController:

- first Ctrl+C during a turn → abort that turn ("interrupting... press
  Ctrl+C again to quit"), **not exit**; the conversation keeps what it did
  so far (with a pointer to `/undo` for the files);
- a second press (or one at the prompt) → `rl.close()`: the pending
  `question` promise rejects, the for loop breaks, the finally flushes and
  exits.

The handler is registered on both `rl.on('SIGINT')` and
`process.on('SIGINT')`.

### Slash commands

| Command | Behavior |
| --- | --- |
| `/reset` | `agent.reset()` (clears conversation, keeps system prompts; fires a snapshot to disk, doc 06) |
| `/session` | list sessions (newest first, current marked, with titles) |
| `/session new` | new session (the old file stays; `store.id = undefined`, lazily created on the next turn) |
| `/session <n or id>` | switch by list number or id (exact → prefix); `loadSession` → `restoreHistory` |
| `/model` | `listModels` live list → pick → `setLLM` (**conversation kept**) → window lookup → `saveGlobalConfig` |
| `/model <id>` | switch straight to a model by name |
| `/compact` | manual compaction; distinct success/failure messages |
| `/undo` | undo the last turn (three output variants, doc 06 §3) |
| `exit`/`quit`/`:q` | leave |

### The approval prompt makeApprover

```
[approval] Run shell command: <command> (in <workdir>)
Allow? [y]es / [a]lways this session / [n]o:
```

- Not a TTY → returns false (deny by default).
- **Session memory**: when every subcommand matches some prefix rule in
  `remembered`, pass without asking. Answering `a` adds
  `derivePrefixRule`'s result (doc 04: a two-word prefix like `git commit *`)
  to the set.
- `y`/`yes` approves once; anything else denies.

## 7. Event rendering renderEvent

| Event | non-verbose | verbose |
| --- | --- | --- |
| step | hidden | `[step N]` |
| context_usage | hidden | `[context ~12k tokens]` |
| compaction | always shown (dim on success / red on failure) | same |
| assistant | hidden | `[model] ...` |
| tool_call | `-> name(args first line, 120 chars)` (cyan arrow) | same |
| tool_result | `ok/!! first line (duration)` | `ok/!! full text (duration)` |
| token | written verbatim to stdout | same |
| final | newline terminator | same |
| max_steps | red notice | same |

The `streamed` flag: once a token arrived in this step, `final` only writes
a newline instead of reprinting the whole answer; without streaming, final
prints the full content. Colors go through `color()` and are stripped on
non-TTY.

## 8. Error presentation printError

`LLMError` gets a hint by status: 401/403 → the key was rejected, check
`AGENT_API_KEY`; 404 → check the `AGENT_BASE_URL` version segment and
`AGENT_MODEL`; 429 → rate limited, retry shortly. Anything else prints the
message verbatim.

## 9. Exit codes

| Case | exitCode |
| --- | --- |
| Final answer | 0 |
| One-shot stopReason ≠ final (aborted/max_steps/exception) | 1 |
| Bad args, no key, resume target not found | 1 |
