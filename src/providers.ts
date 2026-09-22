/**
 * A small catalog of OpenAI-compatible providers, so first-run setup can fill
 * in the right base URL once the user picks a provider, instead of making them
 * hunt it down themselves.
 *
 * The model is deliberately *not* hard-coded here: every OpenAI-compatible
 * provider exposes `GET {baseURL}/models`, so setup queries that endpoint and
 * lets the user pick from the real, currently-available list. `suggestedModel`
 * is only a fallback hint when the endpoint is unreachable.
 */

export interface ProviderPreset {
  id: string
  label: string
  baseURL: string
  /** Fallback hint only; real models are discovered via the `/models` endpoint. */
  suggestedModel: string
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    suggestedModel: 'gpt-4o-mini',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    suggestedModel: 'deepseek-chat',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseURL: 'https://api.moonshot.cn/v1',
    suggestedModel: 'moonshot-v1-8k',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    suggestedModel: 'llama-3.1-8b-instant',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    suggestedModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    suggestedModel: 'openai/gpt-4o-mini',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    suggestedModel: 'llama3.2',
  },
]

export function findProvider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

// ---------------------------------------------------------------------------
// Context window discovery via models.dev
// ---------------------------------------------------------------------------

const MODELS_DEV_URL = 'https://models.dev/api.json'

interface ModelsDevModel {
  id?: string
  limit?: { context?: number; output?: number }
}

interface ModelsDevCatalog {
  [provider: string]: { models?: Record<string, ModelsDevModel> } | string
}

/** In-process cache: the catalog is fetched at most once per session. */
let catalogCache: Promise<ModelsDevCatalog> | undefined

/** Drop the cached catalog; the next lookup refetches. */
export function resetModelsDevCache(): void {
  catalogCache = undefined
}

function fetchCatalog(
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ModelsDevCatalog> {
  catalogCache ??= (async () => {
    const response = await fetchImpl(MODELS_DEV_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch models.dev catalog (HTTP ${response.status})`)
    }
    return (await response.json()) as ModelsDevCatalog
  })()
  // A failed fetch must not poison the cache for later retries.
  catalogCache.catch(() => {
    catalogCache = undefined
  })
  return catalogCache
}

/**
 * Look up a model's context window in the models.dev community catalog
 * (200+ providers, free, no key). Model ids are matched across all providers
 * because ids are near-globally-unique and provider keys in the catalog do
 * not always match our preset ids (e.g. moonshotai vs moonshot).
 *
 * Only exact id matches count: prefix guessing would mis-size the window and
 * mistime compaction. When several providers list the same id with different
 * windows, the smallest wins — underestimating is safe (compacts earlier),
 * overestimating hits the provider limit. Returns undefined when nothing is
 * found: callers keep their configured window or stay without
 * auto-compaction.
 */
export async function lookupContextWindow(
  modelId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<number | undefined> {
  if (!modelId) return undefined
  let catalog: ModelsDevCatalog
  try {
    catalog = await fetchCatalog(fetchImpl, timeoutMs)
  } catch {
    return undefined // offline or blocked: window stays unknown, never fatal
  }

  // OpenRouter-style ids are "vendor/model"; the bare part is what catalogs list.
  const needle = modelId.includes('/') ? modelId.split('/').pop()! : modelId
  const needleLower = needle.toLowerCase()

  let smallest: number | undefined
  for (const provider of Object.values(catalog)) {
    if (!provider || typeof provider === 'string') continue
    for (const model of Object.values(provider.models ?? {})) {
      const context = model.limit?.context
      if (!context || context <= 0) continue
      const id = model.id ?? ''
      if (id.toLowerCase() === needleLower) {
        smallest = smallest === undefined ? context : Math.min(smallest, context)
      }
    }
  }
  return smallest
}

/**
 * Fetch the list of model ids advertised by an OpenAI-compatible endpoint.
 * This is the same `GET /models` call `opencode models` and the dsh CLI rely on.
 */
export async function listModels(
  baseURL: string,
  apiKey?: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 10_000,
): Promise<string[]> {
  const endpoint = `${baseURL.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Failed to list models (HTTP ${response.status})`)
  }
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
  if (!Array.isArray(payload.data)) {
    throw new Error('Unexpected /models response shape')
  }
  return payload.data
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort((a, b) => a.localeCompare(b))
}
