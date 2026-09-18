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
