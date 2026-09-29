import type { Tool } from '../types.ts'
import type { WebSearchBackend } from '../config.ts'

/**
 * Web access: `web_fetch` and `web_search`.
 *
 * `web_fetch` is a client-side implementation on purpose (roadmap item 2):
 * provider-independent, offline-testable, and approvable — fetching a URL the
 * model was given is a need no search backend covers. It is a plain GET over
 * the global `fetch`: a timeout, a download cap, a content-type gate
 * (`text/*`, `application/json`, XML/XHTML), and a minimal HTML-to-text pass
 * (drop `script`/`style`, decode entities — full markdown conversion is not a
 * v1 requirement). It never executes JavaScript.
 *
 * The one real risk is the intranet: a tool that can fetch
 * `http://localhost:…` or `http://192.168.…` is a door into whatever the user
 * can reach. Requests to loopback/private addresses therefore go through
 * `ctx.approve` before anything is sent, and a redirect that lands on a
 * private address is blocked even when the original target was public.
 *
 * `web_search` is a thin client for a config-chosen search API (Brave, Exa,
 * Perplexity). Provider-native server-side web tools are a different,
 * later mechanism (they need item 3's per-provider protocol work). With no
 * backend configured the tool explains how to configure one instead of
 * failing silently.
 */

const DEFAULT_TIMEOUT_MS = 20_000
/** Hard cap on the response body actually read, whatever the content type. */
const MAX_DOWNLOAD_BYTES = 2_000_000
/** Cap on the text returned to the model, mirroring the other tools' budgets. */
const MAX_CONTENT_CHARS = 20_000
const MAX_ERROR_BODY_CHARS = 500

// ---------------------------------------------------------------------------
// Private/loopback address detection (the SSRF gate)
// ---------------------------------------------------------------------------

/**
 * Whether a hostname is loopback, private, link-local, or otherwise "inside".
 *
 * Literal addresses only, by design: a DNS name that resolves to a private IP
 * is the deeper SSRF shape, but resolving names here would make every fetch
 * pay a DNS round-trip and duplicate the resolver the request itself uses.
 * The gate is consent (an approval prompt for obviously-inside targets), not
 * containment (doc 04) — the docs say so plainly.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true

  // IPv6: loopback/unspecified, IPv4-mapped, unique-local (fc00::/7),
  // link-local (fe80::/10).
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (host.startsWith('::ffff:')) return isPrivateHost(host.slice('::ffff:'.length))
    const first = host.split(':')[0] ?? ''
    const value = Number.parseInt(first, 16)
    if (Number.isFinite(value)) {
      if ((value & 0xfe00) === 0xfc00) return true
      if ((value & 0xffc0) === 0xfe80) return true
    }
    return false
  }

  // IPv4 dotted quad: 0.0.0.0/8, 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16.
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => octet > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  cent: '¢',
  pound: '£',
  yen: '¥',
  euro: '€',
  sect: '§',
  deg: '°',
}

/** Decode the entities a text page actually carries: named (small map) + numeric. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      return whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

const BLOCK_TAGS =
  'p|div|br|hr|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|h[1-6]|title|section|article|header|footer|nav|aside|main|blockquote|pre|figure|figcaption|form|fieldset|option'

/**
 * Convert HTML to plain text: comments, `script`/`style`/`noscript`/`template`
 * subtrees dropped, block tags become line breaks, remaining tags stripped,
 * entities decoded, whitespace collapsed. Never renders, never executes.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function truncateNote(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[... truncated, ${text.length - max} characters omitted ...]`
}

/**
 * Read a response body as text with a hard byte cap. Reading is incremental:
 * an oversized body is abandoned mid-stream instead of downloaded whole. The
 * `truncated` flag is reported separately — the caller composes its own
 * marker, because a marker buried mid-body would be cut off by the content
 * truncation that follows.
 */
async function readBodyCapped(
  response: Response,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        const room = Math.max(0, cap - (total - value.byteLength))
        text += decoder.decode(value.subarray(0, room), { stream: true })
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    if (!truncated) text += decoder.decode()
  }
  return { text, truncated }
}

/** Combine the tool's timeout with the caller's cancellation signal. */
function requestSignal(ctx: { signal?: AbortSignal }, timeoutMs: number): AbortSignal {
  const parts: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (ctx.signal) parts.push(ctx.signal)
  return parts.length === 1 ? parts[0] : AbortSignal.any(parts)
}

function isAbortTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export interface WebFetchToolOptions {
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof globalThis.fetch
  timeoutMs?: number
}

/**
 * Create the `web_fetch` tool. Fetches public URLs without approval; private
 * and loopback targets require `ctx.approve` (denied by default when no
 * approver is configured).
 */
export function createWebFetchTool(options: WebFetchToolOptions = {}): Tool<{ url: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: 'web_fetch',
    description:
      'Fetch a URL with HTTP GET and return its text content. HTML pages are converted to ' +
      'plain text (scripts and styles dropped); JSON and other text formats are returned as-is. ' +
      'JavaScript is never executed, so pages that need it come back nearly empty. ' +
      'Requests to localhost/private addresses need user approval.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    promptSnippet: 'fetch a URL over HTTP and return its text content (no JS execution)',
    promptGuidelines: [
      'web_fetch never runs JavaScript: pages that need it return almost no text; prefer API endpoints, raw files, or print-friendly URLs.',
      'To read a page found with web_search, fetch its URL with web_fetch.',
    ],
    async execute({ url }, ctx) {
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error('"url" must be a non-empty string')
      }
      let target: URL
      try {
        target = new URL(url)
      } catch {
        throw new Error(`"${url}" is not a valid absolute URL`)
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`Only http and https URLs can be fetched, got "${target.protocol}"`)
      }

      const privateTarget = isPrivateHost(target.hostname)
      let approved = false
      if (privateTarget) {
        if (!ctx.approve) {
          throw new Error(
            `Fetching ${target.href} requires approval (private or loopback address) ` +
              'but no approver is configured.',
          )
        }
        approved = await ctx.approve(`Fetch ${target.href} (private or loopback address)`)
        if (!approved) {
          throw new Error('Fetch denied by user. Do not try to work around it; ask the user instead.')
        }
      }

      let response: Response
      try {
        response = await fetchImpl(target.href, {
          method: 'GET',
          redirect: 'follow',
          headers: { accept: 'text/html,text/*,application/json;q=0.9,*/*;q=0.1' },
          signal: requestSignal(ctx, timeoutMs),
        })
      } catch (error) {
        if (ctx.signal?.aborted) throw new Error('Fetch aborted.')
        if (isAbortTimeout(error)) {
          throw new Error(`Fetch of ${target.href} timed out after ${timeoutMs}ms`)
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`Cannot fetch ${target.href}: ${reason}`)
      }

      // A redirect chain can end somewhere the approval never covered: check
      // the final URL against the same gate before any content is shown. A
      // private address is only exempt when it is the very host that was
      // approved — approval of 127.0.0.1 does not extend to `localhost`.
      const approvedHost = privateTarget ? target.hostname.toLowerCase() : undefined
      if (response.url) {
        const finalUrl = new URL(response.url)
        if (
          isPrivateHost(finalUrl.hostname) &&
          finalUrl.hostname.toLowerCase() !== approvedHost
        ) {
          throw new Error(
            `Blocked: ${target.href} redirected to the private address ${finalUrl.href}.`,
          )
        }
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(
          `Fetch of ${target.href} failed with HTTP ${response.status}` +
            (body ? `: ${body.slice(0, MAX_ERROR_BODY_CHARS)}` : ''),
        )
      }

      const contentType = response.headers.get('content-type') ?? ''
      const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
      const textLike =
        mime.startsWith('text/') ||
        mime === 'application/json' ||
        mime === 'application/xml' ||
        mime === 'application/xhtml+xml'
      if (!textLike) {
        throw new Error(
          `Unsupported content type "${contentType || 'unknown'}"; ` +
            'web_fetch returns text and JSON only.',
        )
      }

      const { text: raw, truncated: downloadCapped } = await readBodyCapped(response, MAX_DOWNLOAD_BYTES)
      const isHtml = mime.includes('html')
      let text = isHtml ? htmlToText(raw) : raw
      if (text === '') return `(${target.href} returned no text content)`
      text = truncateNote(text, MAX_CONTENT_CHARS)
      // The download marker goes last, where content truncation cannot bury it.
      if (downloadCapped) {
        text += `\n[... download capped at ${MAX_DOWNLOAD_BYTES} bytes; the content above may be incomplete ...]`
      }
      return text
    },
  }
}

/** Backwards-compatible singleton. */
export const webFetchTool: Tool<{ url: string }> = createWebFetchTool()

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

const SEARCH_RESULTS = 8

export interface WebSearchToolOptions {
  /** Backend from config; when absent the tool explains how to configure one. */
  backend?: WebSearchBackend
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof globalThis.fetch
  timeoutMs?: number
}

interface SearchResultLine {
  title: string
  url: string
  snippet: string
}

function formatResults(lines: SearchResultLine[]): string {
  if (lines.length === 0) return '(no results)'
  const text = lines
    .map((line, index) => `[${index + 1}] ${line.title} — ${line.url}\n    ${line.snippet}`)
    .join('\n')
  return truncateNote(text, MAX_CONTENT_CHARS)
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    if (isAbortTimeout(error)) throw new Error(`${label} timed out`)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} failed: ${reason}`)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `${label} returned HTTP ${response.status}` +
        (body ? `: ${body.slice(0, MAX_ERROR_BODY_CHARS)}` : ''),
    )
  }
  return (await response.json()) as Record<string, unknown>
}

/**
 * Create the `web_search` tool: a thin client for one config-chosen search
 * API. The API key travels only to the search provider's own endpoint.
 */
export function createWebSearchTool(options: WebSearchToolOptions = {}): Tool<{ query: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: 'web_search',
    description:
      'Search the web via the configured search API and return result titles, URLs and snippets. ' +
      'Requires a "webSearch" section in hi-agent.json (Brave, Exa, or Perplexity).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    promptSnippet: 'search the web via the configured search API (Brave/Exa/Perplexity)',
    promptGuidelines: [
      'Follow web_search results by fetching the relevant URLs with web_fetch.',
    ],
    async execute({ query }, ctx) {
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('"query" must be a non-empty string')
      }
      const backend = options.backend
      if (!backend) {
        throw new Error(
          'web_search is not configured. Add a "webSearch" section to hi-agent.json ' +
            '(or the global config), e.g. { "webSearch": { "provider": "brave", "apiKey": "..." } }. ' +
            'Providers: brave, exa, perplexity.',
        )
      }
      const signal = requestSignal(ctx, timeoutMs)

      if (backend.provider === 'brave') {
        const endpoint =
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_RESULTS}`
        const data = await requestJson(
          fetchImpl,
          endpoint,
          {
            headers: { 'x-api-key': backend.apiKey, accept: 'application/json' },
            signal,
          },
          'web_search (Brave)',
        )
        const web = data.web as { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } | undefined
        const lines = (web?.results ?? []).map((result) => ({
          title: typeof result.title === 'string' ? result.title : '(untitled)',
          url: typeof result.url === 'string' ? result.url : '',
          snippet: typeof result.description === 'string' ? result.description : '',
        }))
        return formatResults(lines)
      }

      if (backend.provider === 'exa') {
        const data = await requestJson(
          fetchImpl,
          'https://api.exa.ai/search',
          {
            method: 'POST',
            headers: { 'x-api-key': backend.apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({ query, numResults: SEARCH_RESULTS }),
            signal,
          },
          'web_search (Exa)',
        )
        const results = data.results as Array<{ title?: unknown; url?: unknown; summary?: unknown; text?: unknown }> | undefined
        const lines = (results ?? []).map((result) => {
          const raw = typeof result.summary === 'string'
            ? result.summary
            : typeof result.text === 'string'
              ? result.text.slice(0, 300)
              : ''
          return {
            title: typeof result.title === 'string' ? result.title : '(untitled)',
            url: typeof result.url === 'string' ? result.url : '',
            snippet: raw,
          }
        })
        return formatResults(lines)
      }

      // perplexity: a chat-completions-style answer with citations.
      const data = await requestJson(
        fetchImpl,
        'https://api.perplexity.ai/chat/completions',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${backend.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'sonar',
            messages: [{ role: 'user', content: query }],
          }),
          signal,
        },
        'web_search (Perplexity)',
      )
      const choices = data.choices as Array<{ message?: { content?: unknown } }> | undefined
      const answer = typeof choices?.[0]?.message?.content === 'string'
        ? choices[0].message.content
        : '(no answer)'
      const citations = Array.isArray(data.citations)
        ? data.citations.filter((entry): entry is string => typeof entry === 'string')
        : []
      const sources = citations.length > 0
        ? `\n\nSources:\n${citations.map((url, index) => `[${index + 1}] ${url}`).join('\n')}`
        : ''
      return truncateNote(`${answer}${sources}`, MAX_CONTENT_CHARS)
    },
  }
}

/** Backwards-compatible singleton: unconfigured, explains how to configure. */
export const webSearchTool: Tool<{ query: string }> = createWebSearchTool()
