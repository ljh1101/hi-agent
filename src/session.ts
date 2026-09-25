/**
 * Session persistence: JSONL files under the global config dir.
 *
 * Layout: `~/.config/hi-agent/sessions/<id>.jsonl` where `<id>` is a short
 * timestamped slug. Line 1 is a header record (kind: "header") with the session
 * id, creation time, and model; every following line is one chat message in
 * wire order. Appends are the common case (one line per message), so a crash
 * loses at most the in-flight turn.
 *
 * A rewrite of the whole history is recorded as a `compaction` line holding a
 * full snapshot rather than as markers — replaying from the last snapshot is
 * simpler and leaves the pre-snapshot lines on disk for auditing. Two things
 * write one: compaction, and `/reset` clearing the conversation.
 *
 * One-shot prompt mode does not create a session file at all; only persistent
 * (interactive) runs do.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from './types.ts'

interface SessionHeader {
  kind: 'header'
  id: string
  createdAt: string
  model: string
}

type SessionLine =
  | SessionHeader
  | ({ kind: 'message' } & { message: ChatMessage })
  | { kind: 'compaction'; history: ChatMessage[] }

export interface SessionMeta {
  id: string
  createdAt: string
  model: string
  messageCount: number
  /** First user message, for the list view. */
  title: string
  updatedAt: string
}

export function sessionsDir(configDir: string): string {
  return path.join(configDir, 'sessions')
}

function sessionPath(configDir: string, id: string): string {
  return path.join(sessionsDir(configDir), `${id}.jsonl`)
}

/**
 * Per-file write queues.
 *
 * Every append is its own `writeFile` (open, write, close), so two overlapping
 * calls can land in either order. The order matters: if the assistant message
 * carrying `tool_calls` is written after the tool result it requested, replaying
 * the file hands the provider a tool message that does not follow its call, and
 * it rejects the whole conversation. Chaining each write onto the previous one
 * for the same path keeps the file in the order the loop produced it.
 */
const writeQueues = new Map<string, Promise<void>>()

/** Run `write` after every write already queued for `file`. */
function enqueue(file: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.then(write)
  // The chain continues even if this write fails, so one bad write cannot wedge
  // every later one; the caller still sees the rejection through `next`.
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(file, tail)
  void tail.then(() => {
    if (writeQueues.get(file) === tail) writeQueues.delete(file)
  })
  return next
}

/**
 * Wait for every queued write to reach the disk. Call before exiting: an
 * interactive session that quits while an append is still in flight loses the
 * last message, which is exactly the turn the user just watched happen.
 */
export async function flushSessions(): Promise<void> {
  // Draining can uncover writes queued while awaiting; the loop ends as soon as
  // nothing new is added, which is the case on the exit path.
  while (writeQueues.size > 0) {
    await Promise.all([...writeQueues.values()])
  }
}

/** Create a new session id: sortable by creation time. */
export function newSessionId(): string {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('') + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0')
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

/** Write the header line, creating the session file. */
export async function createSession(
  configDir: string,
  id: string,
  model: string,
): Promise<void> {
  const dir = sessionsDir(configDir)
  await mkdir(dir, { recursive: true })
  const header: SessionHeader = {
    kind: 'header',
    id,
    createdAt: new Date().toISOString(),
    model,
  }
  await writeFile(sessionPath(configDir, id), `${JSON.stringify(header)}\n`, 'utf8')
}

/** Append one message to an existing session file. */
export async function appendMessage(
  configDir: string,
  id: string,
  message: ChatMessage,
): Promise<void> {
  const line: SessionLine = { kind: 'message', message }
  await enqueue(sessionPath(configDir, id), () =>
    writeFile(sessionPath(configDir, id), `${JSON.stringify(line)}\n`, {
      encoding: 'utf8',
      flag: 'a',
    }),
  )
}

/**
 * Append a snapshot of the whole history — a compaction, or the user clearing
 * the conversation with `/reset`. Earlier message lines stay on disk (the
 * original history remains auditable and recoverable); loading replays from the
 * LAST snapshot, so everything after it continues the conversation.
 */
export async function appendCompaction(
  configDir: string,
  id: string,
  history: readonly ChatMessage[],
): Promise<void> {
  const line: SessionLine = { kind: 'compaction', history: [...history] }
  await enqueue(sessionPath(configDir, id), () =>
    writeFile(sessionPath(configDir, id), `${JSON.stringify(line)}\n`, {
      encoding: 'utf8',
      flag: 'a',
    }),
  )
}

export interface LoadedSession {
  header: SessionHeader
  history: ChatMessage[]
}

/** Load a session file; returns undefined when it does not exist. */
export async function loadSession(
  configDir: string,
  id: string,
): Promise<LoadedSession | undefined> {
  let text: string
  try {
    text = await readFile(sessionPath(configDir, id), 'utf8')
  } catch {
    return undefined
  }

  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return undefined

  let header: SessionHeader | undefined
  const history: ChatMessage[] = []
  for (const line of lines) {
    let parsed: SessionLine
    try {
      parsed = JSON.parse(line) as SessionLine
    } catch {
      continue // tolerate a torn final line after a crash
    }
    if (parsed.kind === 'header') {
      header = parsed
    } else if (parsed.kind === 'compaction') {
      // A snapshot supersedes everything before it; replay continues after it.
      history.length = 0
      history.push(...parsed.history)
    } else if (parsed.kind === 'message' && parsed.message) {
      history.push(parsed.message)
    }
    // An unrecognised kind is skipped rather than pushed: a newer writer could
    // add a line this build does not know, and `parsed.message` would be
    // undefined there, poisoning the history with a hole.
  }
  if (!header) return undefined
  return { header, history }
}

/** List all sessions, newest first. */
export async function listSessions(configDir: string): Promise<SessionMeta[]> {
  let files: string[]
  try {
    files = await readdir(sessionsDir(configDir))
  } catch {
    return []
  }

  const metas: SessionMeta[] = []
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const id = file.slice(0, -'.jsonl'.length)
    let text: string
    try {
      text = await readFile(path.join(sessionsDir(configDir), file), 'utf8')
    } catch {
      continue
    }

    let header: SessionHeader | undefined
    let messageCount = 0
    let title = ''
    let updatedAt = ''
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed: SessionLine
      try {
        parsed = JSON.parse(line) as SessionLine
      } catch {
        continue
      }
      if (parsed.kind === 'header') {
        header = parsed
        continue
      }
      if (parsed.kind === 'compaction') {
        // The snapshot resets the effective history; re-derive the title too.
        messageCount = parsed.history.length
        title = parsed.history.find((m) => m.role === 'user')?.content?.slice(0, 60) ?? title
        continue
      }
      // Skip anything that is not a message record: an unknown kind carries no
      // `message`, and reading through it would throw out of the whole listing.
      if (parsed.kind !== 'message' || !parsed.message) continue
      messageCount++
      if (parsed.message.role === 'user' && title === '') {
        title = (parsed.message.content ?? '').slice(0, 60)
      }
    }
    if (!header) continue
    const stat = await statFile(path.join(sessionsDir(configDir), file))
    metas.push({
      id: header.id,
      createdAt: header.createdAt,
      model: header.model,
      messageCount,
      title: title || '(no user message)',
      updatedAt: stat?.mtime.toISOString() ?? header.createdAt,
    })
  }

  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Delete a session file (used by /session pruning later if needed). */
export async function deleteSession(configDir: string, id: string): Promise<void> {
  await rm(sessionPath(configDir, id), { force: true })
}

async function statFile(file: string): Promise<{ mtime: Date } | undefined> {
  try {
    return await stat(file)
  } catch {
    return undefined
  }
}
