# 06 · Session Persistence and Undo (session.ts + changes.ts)

Covers: `src/session.ts`, `src/changes.ts`, and the `undoLastTurn()`
cooperation logic in `agent.ts`.

## 1. Session files (session.ts)

### Layout and lifecycle

- Location: `<configDir>/sessions/<id>.jsonl`; configDir is platform-specific
  (doc 07), overridable via `HI_AGENT_CONFIG_DIR`.
- `<id>` = `yyyyMMdd-HHmmss-<first 8 of uuid>`: sortable by creation time and
  unique.
- **Only interactive runs persist**; one-shot prompt mode never creates a
  session file.
- Session creation is **lazy**: the header is written when the first message
  actually goes out (the CLI's `ensureSession`, doc 08).

### The three line kinds (SessionLine)

```json
{"kind":"header","id":"...","createdAt":"...","model":"..."}
{"kind":"message","message":{ ...ChatMessage... }}
{"kind":"compaction","history":[ ...the whole current history... ]}
```

- Line 1 is always the header; every line after is one message, in wire
  order.
- **Append-only philosophy**: the common case is one line per message (an
  independent writeFile), so a crash loses at most the in-flight turn.
- **A history rewrite = appending one snapshot line**, not rewriting in
  place: compaction and `/reset` both produce a compaction line. Replay
  resumes from the **last** snapshot; the original lines before it stay on
  disk — auditable and recoverable.

### The write queue (writeQueues) — why it must exist

Every append is an independent `writeFile` (open/write/close), so two
overlapping calls can land in either order. The order is not a matter of
taste: if the assistant message carrying `tool_calls` is written after the
tool result it requested, replaying the file hands the provider a
"result before call" conversation and the provider **rejects it wholesale**.

Implementation: one promise chain per file; `enqueue(file, write)` appends
to the chain; the chain continues after a single failure (one bad write
cannot wedge every later one) while the caller still sees this write's
rejection. Empty queues self-clean.

`flushSessions()`: resolves only when every queue has drained (draining can
uncover writes queued while awaiting, so it loops until nothing new is
added). **The process exit path must call it**: quitting while an append is
in flight loses exactly the turn the user just watched happen. The CLI calls
it in repl's finally (doc 08).

### Reading and listing

- `loadSession`: parses line by line with a **lenient strategy**:
  - a torn final line after a crash (parse failure) is skipped;
  - a compaction line → `history.length = 0`, then load the snapshot (the
    snapshot supersedes everything before it);
  - **unknown kinds are skipped**: a newer writer could emit lines this
    build does not know; reading `parsed.message` through would push
    undefined and poison the history with a hole. Forward compatibility by
    skipping.
  - no header → invalid, returns undefined.
- `listSessions`: walks the directory for metadata. `title` = the first 60
  characters of the first user message (re-derived from a compaction
  snapshot when one appears); `messageCount` is snapshot-aware the same way;
  sorted by file mtime (`updatedAt`) descending — newest first. A missing
  directory returns `[]` instead of throwing.
- `deleteSession`: `force: true` rm; a missing file is a no-op.

## 2. The undo journal (changes.ts)

### Motivation and scope (a faithful paraphrase of the header comment)

The agent's whole point is changing files, and `write_file`/`edit` run
without per-file approval (the boundary is the workspace root, doc 04) — a
wrong turn used to be permanent unless the file happened to be in git. The
journal records **what each turn replaced**, and `/undo` restores it.

Scope, stated plainly: it covers the **file tools only**. Files written by
shell commands are not tracked (the command string says nothing about what
it will touch); nothing outside the root is tracked. For both, the answer
remains git.

### Structure

```ts
interface Turn {
  boundary: ChatMessage | null   // the last message before the turn (a reference, not an index)
  changes: FileChange[]          // in the order they happened; undo walks them backwards
}
```

- `MAX_TURNS = 20`: the journal holds file contents in memory, so depth must
  be bounded; twenty is far more than anyone rewinds in practice and keeps a
  long session's footprint predictable. Overflow shifts the oldest out.
- **Why boundary is a message reference, not an index**: compaction can
  rewrite the history mid-turn; an index recorded earlier would then point
  past the end (or worse, past the wrong place) — measured, an index-based
  mark left 44 holes in the history and made every later request throw.
  Compaction reuses the same message objects for the region it retains, so
  the reference survives; when it does not survive (the boundary message was
  compacted away), the rewind is **refused** rather than guessed.
- `record` is silently ignored with no open turn (a bare tool call outside a
  run).
- `clear` runs on `reset()` and `restoreHistory()` — with the history gone,
  undo boundaries are meaningless.

### undo(root)

1. `findLastIndex` finds the most recent turn **with changes** (pure
   conversation turns are skipped);
2. the journal is truncated to that turn (it cannot be undone twice);
3. changes are restored **in reverse order**: a file written twice in one
   turn ends up with the content it had before the turn started;
   - `before: null` → `rm` (a file the turn created; undo removes it);
   - otherwise `writeFile(before)`.
4. every path is **re-validated through `resolveToolPath`** before restore:
   safe when recorded does not mean safe now — a link may have appeared
   since; undo must not be the one thing that writes outside the root.

## 3. The two halves of undo (agent.undoLastTurn)

Restoring files and rewinding the conversation **must happen together**:

- files restored without rewinding → a model that believes its edits are
  still on disk;
- conversation rewound without restoring files → a session describing code
  that no longer exists.

```
undone = journal.undo(root)          // nothing to undo → returns undefined
boundaryIndex = history.indexOf(undone.boundary)
rewound = boundary is null (history was empty before the turn; rewind to 0)
        or boundaryIndex >= 0 (boundary still present; truncate after it)
if rewound: history.length = keep; usages.clear(); onReplace(history)
          ← the disk must agree, or the next resume replays the undone turn
returns { restored, removed, droppedMessages, rewound }
```

When `rewound: false`: a compaction happened during that turn and the
boundary message was summarized away — the files are still restored, but the
conversation is **not** truncated (truncating to a guessed position is worse
than not truncating). The CLI has a dedicated message for this (doc 08).

## 4. Wiring the persistence hooks (agent ↔ session)

The Agent provides two injection points (`onAppend` / `onReplace`) that the
session layer fills:

- `onAppend`: fired after every message the loop appends (user/assistant/tool)
  → `appendMessage`;
- `onReplace`: fired whenever the whole history is rewritten — compaction,
  `reset()`, an undo rewind → `appendCompaction` (a snapshot line).

In the CLI these calls are fire-and-forget, but a rejection must not become
an unhandled rejection (which takes the process down in newer Node): the
error is printed to stderr ("session write failed") and the session stays
usable (doc 08).

## 5. Consistency summary (what touches the disk)

| Operation | Disk action |
| --- | --- |
| Every appended message | one `message` line appended |
| `compact()` success | one `compaction` line appended (snapshot) |
| `/reset` (agent.reset) | one `compaction` line appended (snapshot = system messages only) |
| `/undo` with rewind | one `compaction` line appended (snapshot = truncated history) |
| `/undo` without rewind | no disk action (conversation unchanged; file changes were never persisted anyway) |
| `/session new` / switching | none (the old file stays; the next turn lazily creates a new file) |
