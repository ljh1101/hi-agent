# 07 · Configuration and Providers (config.ts + providers.ts)

Covers: `src/config.ts`, `src/providers.ts`, and `.env` loading (in cli.ts).

## 1. Config layering (config.ts)

### The two-file design

Following opencode / dsh, it resolves the "keys must not enter git, defaults
want to" tension:

| File | Contents | Permissions | Committed |
| --- | --- | --- | --- |
| Global `config.json` | API key + personal defaults | `chmod 0600` after first write | never |
| Project `<root>/hi-agent.json` | secret-free defaults (baseURL, model, permissions, contextWindow) | normal | shared with the repo |

### Locations

| Platform | Global directory |
| --- | --- |
| macOS | `~/Library/Application Support/hi-agent` |
| Windows | `%APPDATA%\hi-agent` |
| Linux/other | `$XDG_CONFIG_HOME/hi-agent`, default `~/.config/hi-agent` |

`HI_AGENT_CONFIG_DIR` overrides the whole path (tests isolate with it too).
Session files live under its `sessions/` (doc 06).

### The precedence chain (high → low)

```
CLI flags > environment variables > project hi-agent.json > global config.json
```

Within the environment, `AGENT_*` outranks `OPENAI_*` / `DEEPSEEK_*`.
`firstDefined` skips undefined and empty strings.

### resolveConfig details

- **The exact DeepSeek-default trigger**: only when `DEEPSEEK_API_KEY` is set
  **and** neither `AGENT_API_KEY` nor `OPENAI_API_KEY` is — i.e. the user
  chose DeepSeek's dedicated key and no higher-precedence key exists. Then
  baseURL defaults to `https://api.deepseek.com/v1` and model to
  `deepseek-chat`; the presence of any higher-precedence key disables the
  DeepSeek defaults even if `DEEPSEEK_API_KEY` is also set (preventing a
  mismatched baseURL/model pair when two keys are set).
- Full fallback chains per field:
  - `apiKey`: override → `AGENT_API_KEY` → `OPENAI_API_KEY` →
    `DEEPSEEK_API_KEY` → project → global;
  - `baseURL`: override → `AGENT_BASE_URL` → `OPENAI_BASE_URL` → project →
    global → DeepSeek/OpenAI default;
  - `model`: override → `AGENT_MODEL` → `OPENAI_MODEL` → project →
    global → DeepSeek/OpenAI default;
  - `contextWindow`: project → global (must be a positive number; undefined =
    auto-compaction disabled). File layers only; no CLI/env passthrough.
- **Parse-time validation**: a JSON syntax error or a non-object root throws
  immediately with the file path — bad config must explode at startup, not
  silently fall back mid-run. The `permissions` field goes through
  `parseRules` during parsing (invalid entries dropped, doc 04).
- `saveGlobalConfig(patch, dir)`: **merge semantics** — read, shallow-merge,
  write back; keys the patch does not mention are never clobbered; the
  directory is created recursively; `chmod 0600` is applied best-effort
  afterwards (failure tolerated; Windows file permissions differ).

### `.env` support

The CLI's `loadDotEnv` calls Node's built-in `process.loadEnvFile('.env')`
(availability-probed for engine differences), silently skipping a missing
file. `.env.example` documents every variable and the recommended setup
(which is actually no `.env` at all: run setup once, it writes the global
config).

## 2. The provider catalog (providers.ts)

### PROVIDERS presets

| id | label | baseURL |
| --- | --- | --- |
| openai | OpenAI | `https://api.openai.com/v1` |
| deepseek | DeepSeek | `https://api.deepseek.com/v1` |
| moonshot | Moonshot (Kimi) | `https://api.moonshot.cn/v1` |
| groq | Groq | `https://api.groq.com/openai/v1` |
| together | Together AI | `https://api.together.xyz/v1` |
| openrouter | OpenRouter | `https://openrouter.ai/api/v1` |
| ollama | Ollama (local) | `http://localhost:11434/v1` |

Presets only solve the baseURL. **The model is deliberately not hard-coded**:
every OpenAI-compatible endpoint exposes `GET {baseURL}/models`, and setup
plus `/model` query the real list for the user to pick;
`suggestedModel` is only a fallback hint when the endpoint is unreachable.

### listModels(baseURL, apiKey?)

`GET /models` (with an optional Bearer), validates that `data` is an array,
extracts string ids, returns them sorted. Non-2xx or a wrong shape throws.
10s timeout, cancellable via `AbortSignal.timeout`. The CLI's `pickModel`
uses it for live model discovery, falling back to manual entry on failure.

### lookupContextWindow(modelId) — the models.dev community catalog

Purpose: auto-compaction (doc 03) needs to know the model's window size.
Source: `https://models.dev/api.json` (200+ providers, free, no key),
cached in-process for the whole session (at most one fetch per session;
**a failed fetch does not poison the cache** — the catch clears it so the
next call retries).

Matching rules (each has a reason):

- **Exact id match**, searched across all providers (the catalog's provider
  keys often mismatch our preset ids, e.g. moonshotai vs moonshot; ids are
  near-globally unique, so crossing providers is safe). Prefix guessing
  would mis-size the window and mistime compaction — not done.
- OpenRouter-style `vendor/model` ids contribute their bare tail.
- **When several providers list the same id with different windows, the
  smallest wins**: underestimating is safe (compacts earlier),
  overestimating hits the provider's hard limit.
- Any failure (offline, blocked, 5s timeout) → undefined, **never fatal**:
  the caller keeps its configured window or stays without auto-compaction.

`resetModelsDevCache` exists for tests.

## 3. The full configuration lifecycle

```
First run (no key, TTY)
  → setupFirstRun: pick a provider (or enter a baseURL) → enter the key
  → listModels discovers models live → pick by number (manual entry on failure)
  → lookupContextWindow (skipped on failure; compaction stays disabled)
  → saveGlobalConfig({apiKey, baseURL, model, contextWindow?})  0600
Subsequent runs
  → resolveConfig: CLI > env(.env) > project > global > defaults
  → /model switch: setLLM (conversation kept) + saveGlobalConfig({model, contextWindow?})
```

A committable project config example:

```json
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "contextWindow": 128000,
  "permissions": { "allow": ["npm run *"], "deny": ["git push *"] }
}
```

The semantics and merging of `permissions` are doc 04 §3; `contextWindow`
is set here manually for private deployments models.dev cannot size.
