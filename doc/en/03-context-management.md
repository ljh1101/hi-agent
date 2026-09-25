# 03 · Context Management: Projection, Accounting, Compaction (context.ts)

Covers: `src/context.ts`.

The core proposition: **history is truth, the request is a projection.**
The agent's `history` keeps full fidelity (the base for persistence and
rewind); the model only ever sees the output of `projectHistory`, and history
itself is never modified — the single exception is `compact()`, which
deliberately rewrites history (the detail loss is the explicit price of being
able to continue) and must leave it byte-identical on failure.

Three mechanisms, light to heavy:

1. **Pruning projection** (every request): old oversized tool results are cut
   to head + tail + an omission marker. Cheap, deterministic, model-free
   (mirroring dsh / opencode's tool-result pruner).
2. **Emergency projection** (only when 1 still leaves the request over
   budget): drops even the recent-turn age protection.
3. **LLM compaction** (when the estimate crosses the window threshold): the
   old history is summarized into one system message.

## 1. The pruning projection projectHistory()

For each `tool` message (system/user/assistant pass through untouched), two
rules are tested in order:

**Rule A (age rule)** — fires only when both hold:
- content longer than `pruneThresholdChars` (default 2000);
- message index earlier than the protection cutoff: tool results within the
  `protectedTurns` (default 3) most recent user turns are never pruned (the
  model probably still needs them).

When triggered, the result is cut to `pruneHeadChars` (300) +
`pruneTailChars` (300), the middle replaced by
`\n[... N characters pruned ...]\n`. Head and tail: the head carries the
shape of the output, the tail usually carries the error or summary line a
command ends with.

`protectedCutoff` walks backwards counting user messages to find the start of
the Nth-to-last turn; with fewer user turns than the protection window,
everything is protected.

**Rule B (ceiling rule)** — regardless of age, a single tool result over
`maxToolResultChars` (default 8000) is cut to half that at each end. The age
rule answers "does the model still need this result"; the ceiling answers "no
single observation may own the window": a 50KB shell dump landing in the turn
being answered is protected from the age rule and could push the request over
the model's limit on its own.

**The test order — A before B — is a fixed bug, not taste**: with the ceiling
tested first, an old result appeared in the request at its 8000-character
"ceiling size", *bigger* than the 600 characters the age rule would have kept
(measured: a 40k old result went from 600 to 8000). Setting `protectedTurns`
to 0 prunes every tool result — exactly the switch the emergency projection
uses.

The projection `map`s into new objects (`{ ...message, content }`), keeping
`tool_call_id`, `name`, and every other field; `test/context.test.ts` asserts
the projection never modifies the stored history.

## 2. The emergency projection projectRequestView()

```
view = projectHistory(normal budgets)
if contextWindow > 0 and contextUsage(view) > thresholdTokens:
    return projectHistory({ ...budgets, protectedTurns: 0 })   ← drop age protection
```

A successful compaction always lands well under budget (the cut keeps only
`retainRatio` of the window, and the projection shrinks it further), so
reaching here means compaction **failed** to do its job: the summarization
call failed or is unavailable while the history is already over the limit.
Sending anyway draws a context-length rejection that ends the turn; dropping
the age protection (recent tool results are otherwise kept whole) trades
detail for an answer. History is never touched.

## 3. Token accounting

- `estimateTokens(msg)`: characters / 4, including tool_calls' name +
  arguments. Deliberately conservative (overestimates for most languages),
  the same heuristic pi / opencode use.
- `contextUsage(messages, usages)`: a **hybrid strategy**. Walk backwards for
  the last message with a real usage report as the anchor (`usages` is
  maintained by the agent: assistant message index → the usage of the request
  that produced it; `totalTokens` inherently covers "everything before the
  anchor plus the anchor itself"); messages after the anchor are estimated at
  chars/4. Without any usage, everything is estimated. Returns
  `{ tokens, hasUsageBasis }` — the latter tells the UI whether the number is
  grounded in a real report.

## 4. LLM compaction (CompactionOptions)

| Option | Default | Meaning |
| --- | --- | --- |
| `contextWindow` | 0 | The model's total window in tokens. 0 = auto-compaction disabled. No reliable cross-provider discovery exists, so the caller supplies it (the CLI queries models.dev, doc 07; private deployments write it into `hi-agent.json`) |
| `thresholdRatio` | 0.8 | Triggers when the estimate exceeds `window * ratio`. A ratio, not a fixed reserve: fixed token reserves cannot scale across windows (a 16k reserve is 200% of an 8k window — the threshold goes negative and compaction never stops firing) |
| `retainRatio` | 0.2 | The fraction of the window kept verbatim after compaction |
| `reserveTokens` / `keepRecentTokens` | none | Explicit token overrides, taking precedence over the ratios; for when you know the exact budget |

`resolveCompactionOptions` clamps derived thresholds with `Math.max(1, …)`:
even a tiny window must be able to reach the threshold, or compaction fires
every step forever.

`shouldCompact(tokens, options)`: `contextWindow > 0` and the estimate
exceeds the threshold.

### findCutPoint(messages, keepRecentTokens)

Walks backwards accumulating token estimates until `keepRecentTokens` is
reached; then advances the cut to a legal boundary — **a tool message can
never be separated from its call**: the cut may only land on a user message
(a turn start) or an assistant message (its tool_calls and following results
are kept together). Landing on a tool message keeps moving forward.

### serializeForSummary(messages)

Serializes the messages being compacted away into the transcript the
summarizer reads: `[User]:` / `[Assistant]:` / `[Assistant tool call]:` /
`[Tool result]:` lines; each tool result capped at 2000 characters; when the
total exceeds 60000 characters, **the oldest lines are dropped first** (the
tail carries the most recent, most relevant context), with a
`[... N oldest lines dropped ...]` marker up front. The double budget keeps
the summarization request itself inside the window.

### SUMMARY_PROMPT

Demands a structured checkpoint: `## Goal` / `## Constraints & Preferences` /
`## Progress` (Done / In progress / Blocked, preserving exact file paths) /
`## Key Decisions` / `## Next Steps`. It explicitly tells the summarizer
"another assistant instance will continue using only your summary".

## 5. Full compaction semantics (how agent.compact() uses this)

`Agent.compact()` (call timing in doc 01) runs the algorithm above with three
data-level guarantees:

1. **System messages split in two classes**: the user's system prompts
   survive every compaction; old summaries (`summary === true`) are
   **replaced** by the new one, never stacked (the new summarizer does see
   the previous summary, so replacing loses nothing — whatever it captured
   is carried into the new one).
2. **usages.clear()**: usage anchors index into the old message list; after
   compaction every index is stale, estimates take over.
3. **Failure changes nothing**: an `llm.chat` throw (provider failure) → emit
   `{ type:'compaction', ok:false }`, return false, history byte-identical.
   The next request may hit the provider's window limit — safer than
   corrupting the conversation. The run loop's `compactionFailed` flag stops
   retrying within that run.

On success `onReplace(history)` fires: the persistence layer appends a
compaction snapshot line (doc 06); the pre-compaction lines stay on disk,
auditable.

## 6. Default values quick reference

| Constant | Value |
| --- | --- |
| pruneThresholdChars | 2000 |
| pruneHeadChars / pruneTailChars | 300 / 300 |
| protectedTurns | 3 |
| maxToolResultChars | 8000 |
| thresholdRatio | 0.8 |
| retainRatio | 0.2 |
| per-tool truncation in the summary transcript | 2000 chars |
| total summary transcript cap | 60000 chars |
