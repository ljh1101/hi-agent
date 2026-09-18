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
| `src/config.ts` | Config layering (CLI > env > project > global) | Secrets resolve here, never in the loop |
| `src/providers.ts` | Provider presets + `/models` listing | |
| `src/tools/*` | Tool set (registry, calculator, filesystem, search, edit, time) | Each tool is one object |
| `src/cli.ts` | Entry point, arg parsing, interactive REPL | |

## Design Principles

These three rules are the project's soul. Do not "optimize" them away:

1. **Tool failures are data, not crashes.** Bad JSON, unknown tools, thrown
   errors and timeouts all become `Error: ...` observations fed back to the
   model. The loop only throws on *provider* failures (auth, HTTP, network).
2. **The model is just an interface.** `LLM` has one method. Swapping providers
   means changing `src/llm.ts`, never the loop.
3. **Tools are just objects.** A tool is a name + description + JSON Schema +
   `execute`. There is no plugin system.

## Code Quality

- Read files in full before wide-ranging changes or editing files you have not
  fully inspected.
- No `any` unless absolutely necessary.
- Use only erasable TypeScript syntax (Node strip-only mode): no `enum`,
  `namespace`, parameter properties, or `import =`. Imports use `.ts` extensions.
- No inline imports (`await import()`, dynamic type imports).
- **Always ask before removing functionality or code that appears intentional.**
  Unimplemented capabilities (shell, persistence, parallel execution) are on the
  roadmap, not gaps to fill silently — propose before adding.

## Safety Boundaries

- Every filesystem tool must resolve paths through `resolveInsideRoot` and refuse
  to escape the workspace root (including `..` traversal).
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

## Git

- Only commit files changed in this session.
- Stage explicit paths (`git add <path>`); never `git add -A` or `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Commit messages are Chinese, concise, verb-first (`新增...`, `修复...`).
- Never run `git reset --hard`, `git clean -fd`, `git stash`, or force-push.

## User Override

If the user's instructions conflict with any rule in this document, ask for
explicit confirmation before overriding. Only then execute their instructions.
