# hi-agent

A general-purpose tool-using agent in TypeScript.

This is an LLM-driven loop that can call tools, read the results, and keep
going until it can answer. It runs on plain `node`, and the core four files
(`types.ts`, `agent.ts`, `llm.ts`, `tools/registry.ts`) are small enough to read
in one sitting.

```console
$ hi-agent "What is (23 * 17) + 9, and what is in the src/ directory?"

-> calculator({"expression":"(23 * 17) + 9"})
ok (23 * 17) + 9 = 400 (1ms)
-> list_dir({"path":"src"})
ok [file] agent.ts (8003 bytes)
[file] cli.ts (8480 bytes)
[dir] tools/
...

(23 * 17) + 9 = 400. src/ contains the agent core, the LLM client, the tool
registry, the built-in tools and the CLI entry point.
```

## Requirements

- **Node.js >= 22.18** (24 recommended). The sources are executed directly with
  Node's built-in TypeScript support, so there is no bundler and no `tsx`.
- An API key for any **OpenAI-compatible** endpoint: OpenAI, DeepSeek, Moonshot,
  Groq, Together, Ollama, vLLM, LM Studio, ...

## Quick start

```bash
npm install                 # only typescript + @types/node (dev)

npm run demo                # watch the loop work with a scripted model, no key needed
npm run dev "your question" # one turn, then exit (asks for your key the first time)
npm run dev                 # interactive session
```

## Configuration

On first run with no API key, the CLI walks you through it: pick a provider
from a preset list (OpenAI, DeepSeek, Moonshot, Groq, Ollama, ...) or enter a
custom base URL, give it your key, and it **queries that provider's
`/models` endpoint** to let you pick from the real, currently-available models —
the model is not hard-coded. Everything is saved to your home directory
(`~/.config/hi-agent/config.json` on Linux, platform-aware elsewhere), written
with `0600` permissions and never committed. You can also set an environment
variable or drop a `.env` file (loaded automatically). Resolution order,
highest to lowest:

1. CLI flags: `--model`, `--base-url`, `--api-key`, ...
2. Environment variables (or `.env`)
3. Project config `<root>/hi-agent.json` — shareable, **secret-free** defaults you can commit
4. Global config `~/.config/hi-agent/config.json` — your personal key and defaults

A project config holds only non-secret defaults and is safe to commit:

```json
{ "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini" }
```

See `hi-agent --list-providers` for the preset endpoints and
`hi-agent --setup` to re-run the guided setup. Inside an interactive session,
`/model` lists the provider's live models and switches on the spot (your
conversation is kept), and `/model <id>` jumps straight to a model by name.

| Variable | Purpose | Default |
| --- | --- | --- |
| `AGENT_API_KEY` | API key | falls back to `OPENAI_API_KEY`, then `DEEPSEEK_API_KEY` |
| `AGENT_BASE_URL` | OpenAI-compatible base URL, including `/v1` | `https://api.openai.com/v1` (DeepSeek's URL if only `DEEPSEEK_API_KEY` is set) |
| `AGENT_MODEL` | Model id | `gpt-4o-mini` (`deepseek-chat` for DeepSeek) |
| `HI_AGENT_CONFIG_DIR` | Override the global config directory | platform default |

CLI flags: `--model`, `--base-url`, `--api-key`, `--max-steps`, `--system`,
`--root`, `--verbose`. See `npm run dev -- --help`.

## How the core works

The whole agent is this loop (`src/agent.ts`):

```ts
history.push({ role: 'user', content: input })

for (let step = 1; step <= maxSteps; step++) {
  const reply = await llm.chat(history, tools)            // 1. ask the model
  history.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls })

  if (reply.toolCalls.length === 0) return reply.content   // 2. no tools? that is the answer
  for (const call of reply.toolCalls) {
    const observation = await runTool(call)                // 3. run every tool
    history.push({ role: 'tool', content: observation, tool_call_id: call.id })
  }                                                        // 4. loop: the model sees the results
}
```

Everything else is scaffolding around those four steps. Three design rules keep
it robust:

1. **Tool failures are data, not crashes.** Bad JSON arguments, unknown tool
   names, thrown errors and timeouts all become `Error: ...` observations that
   the model gets to read and recover from. The loop only throws when the
   *provider* fails (auth, HTTP, network), because there is nothing to recover
   from locally.
2. **The model is just an interface.** `LLM` (`src/types.ts`) has exactly one
   method. `OpenAICompatibleLLM` implements it over `fetch`; tests swap in a
   scripted fake. Swapping providers means changing one file, not the loop.
3. **Tools are just objects.** A tool is a name, a description, a JSON Schema
   and an `execute` function. There is no plugin system to learn.

## The tools

| Tool | What it does |
| --- | --- |
| `calculator` | Exact arithmetic, parsed by a hand-written recursive-descent parser — no `eval` anywhere |
| `current_time` | Current UTC + local time (the model otherwise has no clock) |
| `list_dir` | Directory listing with `[dir]`/`[file]` markers and sizes |
| `read_file` | Read a UTF-8 text file, optionally a numbered line range (`offset`/`limit`) |
| `write_file` | Create or overwrite a file, creating parent directories |
| `edit` | Replace a unique text span in place (str-replace, like Claude Code's Edit) |
| `glob` | Find files by path pattern (`**/*.ts`, `{a,b}`, `?`) |
| `grep` | Search file contents by regex, returning `file:line` matches with optional context |
| `shell` | Execute a shell command (cross-platform), gated by a read-only command whitelist + approval |

Adding one is a single object:

```ts
import type { Tool } from './types.ts'

export const wordCountTool: Tool<{ text: string }> = {
  name: 'word_count',
  description: 'Count the words in a piece of text.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to count.' } },
    required: ['text'],
    additionalProperties: false,
  },
  execute({ text }) {
    return `${text.trim().split(/\s+/).length} words`
  },
}
```

Then pass it in: `new Agent({ llm, tools: [...createDefaultTools(), wordCountTool] })`.

## Safety model

An agent that can touch the filesystem needs a boundary:

- **Workspace confinement.** File tools resolve relative to `--root` (the
  working directory by default) and refuse any path that escapes it, including
  `..` traversal.
- **No `eval`.** Model-supplied expressions are parsed against a fixed grammar
  and a whitelist of math functions.
- **Bounded cost.** `--max-steps` caps the number of model round-trips per turn,
  every model request has a 120s timeout, every tool a 30s timeout.
- **Approval gate.** The `shell` tool runs a built-in read-only whitelist
  (`ls`, `cat`, `grep`, `git status`, ...) without asking; anything else —
  including compound commands with a risky part, file redirections, and command
  substitution — goes through a three-layer permission system:
  1. **Session memory**: answer `a` at a prompt and that command prefix never
     asks again this session.
  2. **Persistent rules**: `hi-agent.json` supports
     `"permissions": { "allow": ["npm run *"], "deny": ["git push *"] }`
     (deny wins; team-shareable via git, edited by hand).
  3. **The approver prompt** for everything else — `y`/`a`/`n`. Without an
     approver configured (library use), risky commands are denied by default;
     `--yes` auto-approves everything for trusted containers/CI.
- **Errors over crashes.** Failures are reported to the model as observations.

## Using it as a library

```ts
import { Agent, OpenAICompatibleLLM, createDefaultTools } from './src/index.ts'

const agent = new Agent({
  llm: new OpenAICompatibleLLM({
    apiKey: process.env.AGENT_API_KEY!,
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  }),
  tools: createDefaultTools(),
  maxSteps: 12,
  onEvent: (event) => console.log(event),
})

const result = await agent.run('Summarize what this repository does')
console.log(result.content, result.stopReason, result.steps)

// `agent.history` keeps the conversation, so the next run() is multi-turn.
await agent.run('And which file implements the tool registry?')
```

`onEvent` emits `step`, `context_usage`, `assistant`, `tool_call`, `tool_result`,
`log`, `token`, `final` and `max_steps`. `context_usage` fires before each model
request with the estimated token count (provider-reported usage anchored,
chars/4 for newer messages); the CLI shows it as `[context ~12k tokens]` in
verbose mode. `agent.estimateContextTokens()` exposes the same number.
Set `stream: true` on the `Agent` (the default) to get `token` events as the
model streams its reply. Stream them to a UI, or ignore them.

## Project layout

```
src/
  types.ts             the whole contract: ChatMessage, LLM, Tool, events (~130 lines)
  agent.ts             the loop, history management, tool execution, error recovery
  llm.ts               OpenAI-compatible client + retry/backoff + SSE streaming
  context.ts           request projection + token accounting (usage-anchored, chars/4 fallback)
  config.ts            global vs project config loading + secret resolution
  providers.ts         provider presets + `/models` discovery
  permissions.ts       shell prefix permission rules (allow / deny, deny wins)
  command-parse.ts     shell command splitting + leading-word extraction
  index.ts             the library's public surface (re-exports)
  tools/
    registry.ts        name -> tool map, schema projection
    calculator.ts      recursive-descent expression parser
    filesystem.ts      read_file / write_file / list_dir + workspace confinement
    search.ts          glob / grep (find files by name or content)
    edit.ts            str-replace precise editing
    shell.ts           shell execution: read-only whitelist, rules, process-tree kill
    time.ts            current_time
    index.ts           the default toolset
  cli.ts               one-shot and interactive entry point
examples/demo.ts       the loop running against a scripted model, offline
test/                  suites: loop, parser, tools, search, edit, line endings, shell, permissions, config, context, streaming, end-to-end
```

## Tests

```bash
npm test              # all suites in one process, no network, no API key
npm run test:isolated # standard `node --test`, one process per file
npm run typecheck     # tsc --noEmit
```

The suite never calls a real provider. `test/helpers.ts` provides a
`ScriptedLLM` (fixes the model's replies) and `serveFakeProvider` (a throwaway
HTTP server that speaks `chat/completions`), which is enough to cover the wire
format, the loop's error recovery, and a full multi-step run where a file
genuinely gets written to disk.

> `npm test` imports the suites into a single process. `node --test` normally
> spawns one child per file, which sandboxed environments sometimes block; use
> `npm run test:isolated` when you want the standard isolated behaviour.

## Line endings

The model can only emit LF: `\r` cannot survive a tool-call argument, and the
read tools strip it. So the tools own line endings on the model's behalf.

- `read_file` and `grep` always present LF, for CRLF and LF files alike. With a
  line range, `read_file` marks a CRLF file in its header (`..., CRLF`).
- `edit` matches `old_string` in LF space and then restores the file's own
  ending, so editing a CRLF file does not rewrite its untouched lines.
- `write_file` keeps the ending of the file it overwrites; new files are LF.
- Detection is purity-based (CRLF only when *every* newline is `\r\n`), so one
  stray `\r\n` cannot reclassify an LF file and turn a small edit into a
  whole-file diff.
- Normalization only rewrites `\r\n`. A lone `\r` (classic Mac line ending) is
  not a recognized separator: it is passed through as ordinary text and never
  rewritten.

## Roadmap

Everything below is an addition on top of the same loop, not a rewrite:

- **Parallel tool execution** (the loop runs tool calls sequentially today).
- **Context management**: summarization or truncation once history outgrows the
  context window.
- **Persistence**: saving/resuming sessions, and long-term memory.
- **Multi-agent**: sub-agents, planners, or an MCP client.

Pick the one your use case needs first; the interfaces in `src/types.ts` are
small enough that none of them require touching the loop.
