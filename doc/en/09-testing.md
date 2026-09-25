# 09 · The Test System (test/*)

Covers: `test/`. The governing principle (a hard rule in AGENTS.md): **tests
never call a real provider** — no network, no real keys; they use the fake
model and fake endpoint from `test/helpers.ts`.

## 1. How to run

```bash
npm test               # all suites imported into one process (test/run.ts)
npm run test:isolated  # standard node --test, one child process per file
npm run typecheck      # tsc --noEmit
```

**Why the single process**: `node --test` spawns one child per file, which
some sandboxed environments block (children cannot open pipes).
`test/run.ts` imports every suite into one process instead, so `npm test`
works everywhere. When adding a test file, add its import to `run.ts` or
`npm test` will never reach it.

After code changes (not docs): `npm run typecheck` + `npm test` must be all
green before committing. A new or modified test file is run on its own and
iterated until it passes.

Scratch directories in tests use the `.tmp-*` prefix (gitignored).

## 2. Test infrastructure (helpers.ts)

| Tool | Purpose |
| --- | --- |
| `ScriptedLLM` | A deterministic fake model: replays scripted `LLMResponse`s and records every request (deep-copied messages + tools), so tests can assert what the model actually received |
| `toolCall(name, args, id?)` / `reply(content, ...calls)` | Convenience builders for scripts |
| `StreamingLLM` + `streamText(text)` | A fake model implementing only `stream()`; `streamText` splits a string into per-character deltas + done |
| `serveFakeProvider(responder, run)` | Boots a local HTTP server impersonating an OpenAI-compatible endpoint: captures every request (url/method/headers/body) and answers via the responder (status/payload/raw/delay/headers). The foundation of wire-format verification **without a network** |
| `completion(message, usage?)` | A shortcut for a chat-completions reply body |

ScriptedLLM does not implement `stream`, so it naturally covers the
"no-streaming falls back to chat" path; StreamingLLM's `chat` throws,
preventing accidental wrong-branch execution.

## 3. Suite map (14 files, ~230 cases)

| File | Cases | Coverage |
| --- | --- | --- |
| `shell.test.ts` | 45 | **The security-sensitive core**: execution/exit codes/timeout kills/output tail/workdir boundary; the adversarial matrix for the read-only classification (see §4); PowerShell encoding, resolution order, null devices; dual-dialect assertions |
| `agent.test.ts` | 40 | Full loop semantics: observations fed back, unknown tool/bad JSON/throwing recovery, maxSteps, event order, system prompt assembly, streaming tokens/tool collection/mid-stream abort, approver injection and denial-as-observation, projection vs history fidelity, usage anchoring, compaction (replacement not stacking/failure untouched/emergency projection), cancellation (per-run signal, cancelled calls still answered), undo (byte-exact restore including line endings, removing created files) |
| `llm.test.ts` | 26 | Wire format, history serialization, id synthesis, error classification (error payload/bad JSON/no choices), total timeout, retries (429/5xx/no retry on 401/Retry-After/backoff bounds/interruptible backoff), idle timeout (slow stream survives, silence fails), SSE reassembly, usage |
| `context.test.ts` | 24 | Pruning rules (head+tail+marker, short results untouched, **history never modified**, passthrough, identity preserved), the protection window, ceiling-vs-age order, the emergency projection, chars/4, usage anchors, ratio thresholds, cut points (never splitting call/result), summary transcript (per-tool cap/oldest-dropped) |
| `config.test.ts` | 17 | Layering precedence, DeepSeek trigger conditions, bad config throws, 0600, provider presets, listModels, window lookup (exact match/failures swallowed) |
| `search.test.ts` | 16 | Glob syntax, grep line formats/include/binary skip/context, root boundary, .gitignore, symlinks not followed, a directory vanishing mid-walk |
| `tools.test.ts` | 11 | Read/write round-trip, list_dir, boundary refusal (including **in-root link escape**), empty file/dir placeholders, line ranges and validation |
| `session.test.ts` | 11 | Round-trip, torn final line, snapshot replay (old lines stay on disk), **out-of-order appends still land in order + flush**, a second snapshot supersedes, listing metadata, id uniqueness/sortability, agent hooks firing |
| `edit.test.ts` | 10 | Unique match, 0/multiple rejections, the rest of the file untouched, root boundary, multi-line match in a CRLF file, EOL preservation, trailing newline and the mismatch hint |
| `permissions.test.ts` | 9 | Prefix matching, deny beats allow, all-subcommands allow, bare & splitting, lenient parsing, prefix derivation, the shell tool's wiring (allow without asking, **deny overrides the approver**, compounds cannot smuggle) |
| `calculator.test.ts` | 7 | Precedence, unary/right-associative powers, functions/constants, case and whitespace, malformed-input rejection, tool-layer validation |
| `eol.test.ts` | 6 | CRLF read as LF, EOL preservation on write, new files LF, purity-based detection, CRLF round-trip stability |
| `prompts.test.ts` | 4 | Tools-section generation (de-duplicated merge), empty with no tools, default assembly, the no-tools constant |
| `integration.test.ts` | 2 | Multi-step end-to-end (genuinely writes to disk), provider failure propagating out of the loop |

## 4. The testing discipline for security-relevant changes (AGENTS.md)

**Any** change to `isReadOnlyCommand` / `splitSubcommands` / `evaluate` must
add adversarial cases to `test/shell.test.ts`, covering:

- case types: compound commands (`&&`/`||`/`;`/`|`/`|&`/bare `&`/newlines),
  pipes, redirections (file / `2>&1` / null devices), command substitution
  (`$(...)`/backticks), PowerShell specifics (script blocks `{}`, splats
  `@`, subexpressions `()`);
- **both dialects asserted explicitly** (`'posix'` and `'powershell'` each),
  never relying on the host-platform default — a host-derived dialect can
  only ever be tested on the host, which is exactly how the PowerShell
  escaping bug (a `\;` letting a hidden command ride the read-only decision
  and delete outside the root without approval) stayed invisible for so long.

## 5. Typical patterns

Loop semantics via ScriptedLLM:

```ts
const llm = new ScriptedLLM([
  reply(null, toolCall('write_file', { path: 'a.txt', content: 'hi' })),
  reply('done'),
])
const agent = new Agent({ llm, tools: createDefaultTools(), root: tmp })
await agent.run('write a.txt')
assert.equal(llm.requests[1].messages.at(-1).content, 'hi')  // the model saw the observation
```

Wire format via serveFakeProvider:

```ts
await serveFakeProvider(
  (body, i) => (i === 0 ? { status: 429 } : { payload: completion({ content: 'ok' }) }),
  async (baseURL, captured) => {
    const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', maxRetries: 1 })
    assert.equal((await llm.chat([], [])).content, 'ok')
    assert.equal(captured.length, 2)   // the retry really issued a second request
  },
)
```
