# 02 · The LLM Client (llm.ts)

Covers: `src/llm.ts` — **the only file in the project that knows the OpenAI
wire format**. Swapping providers means editing this one file; the loop,
tools, and context layer never move. Built on Node 18+'s global `fetch`, zero
dependencies, compatible with any `/chat/completions` endpoint: OpenAI /
DeepSeek / Moonshot / Groq / Ollama / vLLM / LM Studio and alike.

## 1. Construction (OpenAICompatibleOptions)

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Missing → throws `LLMError('Missing API key')` at construction |
| `baseURL` | `https://api.openai.com/v1` | Must include the version segment (`/v1`); trailing slashes are stripped before appending `/chat/completions` |
| `model` | required | |
| `temperature` / `maxTokens` | not sent | The field is omitted from the request body when unset |
| `timeoutMs` | 120000 | Total timeout for chat / idle timeout for stream — dual semantics, see §3 |
| `maxRetries` | 2 | Extra retry attempts (2 = up to 3 requests), matching the OpenAI SDK |
| `baseDelayMs` / `maxDelayMs` | 500 / 30000 | Base and ceiling of exponential backoff |
| `fetch` | global fetch | Test injection point |

## 2. LLMError

The unified error type for transport failures and non-2xx responses:
`status` (HTTP code), `body` (raw response text), `retryAfterMs` (parsed from
the `Retry-After` header). The CLI turns `status` into human hints (401/403 →
key rejected; 404 → check the baseURL version segment and model name; 429 →
rate limited). The retry logic prefers `retryAfterMs` to honor server
instructions.

## 3. Two timeout philosophies (the easiest thing to misread)

- **Non-streaming `chat()`: a total timeout.** No progress is observable
  until the whole answer is ready, so a total bound is the only option.
  `combineSignals(external signal, AbortSignal.timeout(timeoutMs))` merges
  via `AbortSignal.any` — the engine requires >= 22.18 where it has always
  existed. A previous hand-rolled fallback returned just the external signal
  when `any` was missing, **silently dropping the timeout** and leaving a
  hung request with no bound at all; hence the hard requirement now.
- **Streaming `stream()`: an idle timeout.** A reasoning model legitimately
  spends minutes on one answer; a total timeout kills it mid-sentence while
  the connection is perfectly healthy (measured: a provider trickling a body
  every 300ms was cut off at the then-configured bound). So `startIdleTimeout`
  is used instead: every chunk calls `keepAlive()` and pushes the deadline
  out — it measures **silence**, not total duration.

`startIdleTimeout` returns an `IdleTimeout`: `signal` (aborts itself when the
deadline fires), `controller` (for caller-initiated cancellation),
`keepAlive()` (feed the dog), `dispose()` (stop the timer), `timedOut()`
(distinguishing "the model went quiet" from "the user cancelled" — the former
is wrapped into an explainable `LLMError`, the latter propagates untouched).

The external signal is bridged into the idle controller via
`addEventListener('abort')`; the listener is removed and dispose runs in
`finally`.

## 4. chat() flow

```
buildBody → fetchWithRetry(total-timeout signal) → response.text()
  → JSON.parse failure → LLMError("Model returned invalid JSON: <first 500 chars>")
  → parsed.error?.message → LLMError (HTTP 200 but an error payload in the body)
  → no choices → LLMError("Model returned no choices")
  → normalize: content / toolCalls (synthesize call_${index} when id missing) / usage
```

## 5. stream() flow

```
body.stream = true; body.stream_options = { include_usage: true }
fetchWithRetry(idle.signal, external signal, onAttempt = idle.keepAlive())
  ← onAttempt gives each retry its own fresh idle deadline, unburdened by time
    the previous attempt already spent
for await chunk of parseSSE(response):
  idle.keepAlive()                     ← feed the dog on every frame
  delta.content → accumulate + yield { type:'delta' }
  delta.tool_calls → reassemble by index: id overwrite, name overwrite,
                     arguments append (cross-chunk reassembly is the
                     de-facto SSE tool-call protocol)
  finish_reason / usage recorded
afterwards yield { type:'tool_call' } in index order, then { type:'done' }
  ← done carries the full content, finishReason, usage — no reassembly upstream
```

Error path: `toLLMError(error, external signal, idle.timedOut())` — an
external cancellation propagates untouched (the caller is checking its own
signal); `timedOut` → "Model stalled for Nms with no data; giving up";
everything else while reading the body → "Reading the model response
failed: ...". This normalization is necessary: errors thrown while reading
the response body bypass `requestOnce`'s catch and used to escape as bare
`DOMException`s ("The operation was aborted due to timeout"), defeating every
CLI status hint.

## 6. parseSSE: frame parsing

The wire format is a sequence of `data: {json}\n\n` frames terminated by
`data: [DONE]`:

- `TextDecoder` with `stream: true` decodes incrementally, so multi-byte
  characters (Chinese) split across chunks survive;
- frames split on `\n\n`, the remainder stays in the buffer;
- within each frame, lines starting with `data:` are processed, `[DONE]`
  returns, and malformed JSON throws `LLMError` (a provider error, not a raw
  `SyntaxError` escaping as an untyped crash);
- at end-of-stream the trailing frame without a final blank line is flushed;
- an empty `response.body` → `LLMError('Streaming response had no body')`.

## 7. Retry and backoff (fetchWithRetry)

```
attempts = maxRetries + 1
each round: onAttempt?.() → requestOnce(body, signal, cancel)
on failure: not retryable, or last round → throw
      external cancel / bound signal already aborted → throw
        (cancellation must not be eaten by a retry)
      delay = retryAfterMs ?? backoffDelay(attempt)
      await delayOrAbort(delay, signal)   ← backoff is interruptible by the external signal
```

`isRetryable`: only `LLMError` retries. No status (network error, timeout) =
retryable; `429` and `5xx` = retryable; other 4xx (bad key, bad request) are
the caller's mistake and will not improve on retry — no retry.

`backoffDelay(attempt, base, max)`: full-jitter exponential backoff,
`floor(random() * min(max, base * 2^attempt))`. The random source is
injectable so tests assert deterministic bounds. `parseRetryAfter` accepts
both seconds and HTTP-date forms.

In `requestOnce`, `cancel` (the caller's signal) and `signal` (the imposed
bound) stay separate: when `cancel` fires the error propagates untouched
(the agent checks its own signal and converts the run to aborted), while a
timeout we imposed is wrapped as an `LLMError`. Non-2xx reads the body and
constructs `LLMError` with status and Retry-After (body truncated to 500
characters).

## 8. Wire format conversion

`toWireMessage`: builds a fresh object containing only provider-recognized
fields (role/content/tool_calls/tool_call_id) — local markers like
`summary: true` therefore never go online. `content ?? ''`: null content
becomes an empty string on the wire.

`toToolCall`: missing `function.name` throws `LLMError`; a missing id is
synthesized as `call_${index}` (some providers omit ids; without a stable id
results cannot be linked back). Missing arguments default to `'{}'`.

`buildBody`: `tools` and `tool_choice: 'auto'` are only sent when the tool
list is non-empty — some local endpoints reject an empty tools array.

## 9. Relationship to tests

`fetch` is injectable, and `backoffDelay` / `parseRetryAfter` /
`startIdleTimeout` are exported; `test/llm.test.ts` covers the wire format,
retries, timeouts, SSE reassembly, and error classification through
`serveFakeProvider` (a local HTTP fake, doc 09) — no network, no real keys.
