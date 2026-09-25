# Development Rules

## Project Identity

hi-agent is a general-purpose tool-using agent in TypeScript. It is an
LLM-driven loop that can call tools, read the results, and keep going until it
can answer.

Hard constraints — violating any of these is a regression:

- **No `eval`.** Model-supplied expressions go through the recursive-descent
  parser in `src/tools/calculator.ts`.
- **Filesystem safety.** Every filesystem tool must resolve paths through
  `resolveInsideRoot` and refuse to escape the workspace root.
- **No bundler, no `tsx`.** Source runs directly on Node >= 22.18 via built-in
  type stripping. Imports must carry the real `.ts` extension.
- **Shell approval chain.** The shell tool evaluates commands through:
  persistent deny rules → explicit allow rules → read-only whitelist →
  approver. Deny is evaluated *first*, before the whitelist can short-circuit
  it: the whitelist is a convenience heuristic, and a user who writes
  `deny: ["cat *"]` must be able to close a hole the heuristic opens. The
  stored history is never pruned in place; only the request projection is.

## Conversational Style

- Keep answers short, direct, and technical. No emojis, no fluff, no cheerful filler.
- When the user asks a question, answer it before making edits or running commands.
- Explain non-trivial designs as: problem, concrete example, then solution.
  State why the solution is necessary and distinguish it from optional complexity.
- When responding to feedback, say explicitly whether you agree or disagree
  before describing what you changed.

## Architecture Map

| File | Role | Rules |
| --- | --- | --- |
| `src/types.ts` | The contract: `ChatMessage`, `LLM`, `Tool`, events | Shared by everything; changing it ripples everywhere |
| `src/agent.ts` | The loop, history, tool execution, error recovery | Do not add business logic here |
| `src/llm.ts` | OpenAI-compatible client + retry/backoff + SSE streaming | Swap providers by editing this file only |
| `src/context.ts` | Request projection + token accounting + LLM compaction | History is the source of truth; the model only ever sees a projection. Compaction is the one operation that intentionally rewrites history — failure must leave it untouched |
| `src/prompts/system.ts` | System prompt assembly: identity, tools section, rules | Tools section is built from each tool's `promptSnippet`/`promptGuidelines`; prompt copy lives here, not in `agent.ts` |
| `src/session.ts` | JSONL session persistence | Appends are the common case; compaction APPENDS a snapshot line (pre-compaction lines stay on disk, replay resumes from the last snapshot). One-shot prompt mode never persists |
| `src/config.ts` | Config layering (CLI > env > project > global) | Secrets resolve here, never in the loop |
| `src/providers.ts` | Provider presets + `/models` listing | |
| `src/permissions.ts` | Shell prefix rules (allow / deny, deny wins) | |
| `src/command-parse.ts` | Shell command splitting + leading-word extraction | Quoting-aware; shared by shell and permissions |
| `src/tools/*` | Tool set (registry, calculator, filesystem, search, edit, shell, time) | Each tool is one object |
| `src/cli.ts` | Entry point, arg parsing, interactive REPL, approval prompts | |

## Design Principles

These rules are the project's soul. Do not "optimize" them away:

1. **Tool failures are data, not crashes.** Bad JSON, unknown tools, thrown
   errors and timeouts all become `Error: ...` observations fed back to the
   model. The loop only throws on *provider* failures (auth, HTTP, network).
2. **The model is just an interface.** `LLM` has `chat` plus an optional
   `stream`. Swapping providers means changing `src/llm.ts`, never the loop.
3. **Tools are just objects.** A tool is a name + description + JSON Schema +
   `execute` (plus optional `promptSnippet`/`promptGuidelines` that feed the
   system prompt's tools section). There is no plugin system.
4. **History is truth, requests are projections.** `agent.history` keeps full
   fidelity (base for persistence/rewind). Everything the model sees goes
   through `projectHistory`; never mutate stored messages. The single
   exception is `compact()`: it deliberately trades detail for the ability to
   continue, and on failure it must leave history byte-identical.

## Code Quality

- Read files in full before wide-ranging changes or editing files you have not
  fully inspected.
- No `any` unless absolutely necessary.
- Use only erasable TypeScript syntax (Node strip-only mode): no `enum`,
  `namespace`, parameter properties, or `import =`. Imports use `.ts` extensions.
- No inline imports (`await import()`, dynamic type imports).
- **Always ask before removing functionality or code that appears intentional.**
  Unimplemented capabilities (context compaction via LLM summary, persistence,
  parallel execution, sub-agents, MCP) are on the roadmap, not gaps to fill
  silently — propose before adding.

## Safety Boundaries

- Every filesystem tool must resolve paths through `resolveInsideRoot` and refuse
  to escape the workspace root (including `..` traversal).
- The shell tool's read-only whitelist is security-sensitive: any change to
  `isReadOnlyCommand` needs adversarial test cases (compound commands, pipes,
  redirections, command substitution, and **both shell dialects** — the parser
  is dialect-aware because bash and PowerShell disagree about escaping, and a
  parser that believes a separator is escaped while the shell does not lets the
  hidden command ride along on the first subcommand's allow decision) in
  `test/shell.test.ts`. Assert both dialects explicitly rather than relying on
  the host platform: a host-derived dialect can only ever be tested for the
  host, which is exactly how the PowerShell escaping bug stayed invisible.
- New tools with side effects should be reviewed for a permission level before
  being added to `createDefaultTools()`.

## Commands

- After code changes (not docs): run `npm run typecheck` and `npm test`. Fix all
  errors before committing.
- If you create or modify a test file, run that file and iterate on test or
  implementation until it passes.
- Tests never call a real provider. Use `test/helpers.ts` (`ScriptedLLM`,
  `serveFakeProvider`) — no real API keys or network.
- Scratch dirs in tests use the `.tmp-*` prefix (gitignored).
- Never commit unless the user asks.
- **Never push unless the user explicitly asks for a push.** A request to
  commit is not a request to push.

## Git

- Only commit files changed in this session.
- Stage explicit paths (`git add <path>`); never `git add -A` or `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Commit messages are Chinese, concise, verb-first (`新增...`, `修复...`).
- Never run `git reset --hard`, `git clean -fd`, `git stash`, or force-push
  (unless the user explicitly asks for a force-push).

## User Override

If the user's instructions conflict with any rule in this document, ask for
explicit confirmation before overriding. Only then execute their instructions.
