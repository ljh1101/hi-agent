/**
 * Undo journal: what each turn wrote, and how to put it back.
 *
 * The agent's whole point is changing files, and until now there was no way
 * back: `write_file` and `edit` run without asking (the boundary is the
 * workspace root, not the user's consent per file), so a wrong turn was
 * permanent unless the file happened to be in git. This records the content
 * each write replaced, per turn, so `/undo` can restore it and drop the
 * conversation that produced it.
 *
 * Scope, stated plainly: it covers the filesystem *tools*. A file changed by a
 * shell command is invisible here (the command string says nothing about what
 * it will touch), and neither is anything outside the workspace root. For those,
 * the answer is still git.
 */

import { rm, writeFile } from 'node:fs/promises'
import type { ChatMessage, FileChange } from './types.ts'
import { resolveToolPath } from './tools/filesystem.ts'

/**
 * How many turns stay undoable. The journal holds file contents in memory, so
 * the depth has to be bounded; twenty turns is far more than anyone rewinds in
 * practice and keeps a long session's footprint predictable.
 */
const MAX_TURNS = 20

interface Turn {
  /**
   * The last message that existed before the turn started, or `null` when the
   * history was empty.
   *
   * A message *reference*, not an index: compaction can rewrite the history in
   * the middle of a turn, and an index recorded before that then points past the
   * end or (worse) past the wrong place — measured, an index-based mark left 44
   * holes in the history and made every later request throw. Compaction keeps
   * the same message objects for the region it retains, so the reference
   * survives the rewrite, and when it does not survive the rewind is refused
   * rather than guessed.
   */
  boundary: ChatMessage | null
  /** Changes in the order they happened; undo walks them backwards. */
  changes: FileChange[]
}

/** What undo did. */
export interface UndoFiles {
  boundary: ChatMessage | null
  restored: string[]
  removed: string[]
}

export class ChangeJournal {
  private turns: Turn[] = []

  /** Start recording a turn, marking where an undo should rewind to. */
  beginTurn(boundary: ChatMessage | null): void {
    this.turns.push({ boundary, changes: [] })
    if (this.turns.length > MAX_TURNS) this.turns.shift()
  }

  /** Note a change. Ignored when no turn is open (a bare tool call outside a run). */
  record(change: FileChange): void {
    this.turns.at(-1)?.changes.push(change)
  }

  /** Whether there is a turn with anything to undo. */
  canUndo(): boolean {
    return this.turns.some((turn) => turn.changes.length > 0)
  }

  /** Drop everything (history was reset or replaced wholesale). */
  clear(): void {
    this.turns = []
  }

  /**
   * Put the newest undoable turn back.
   *
   * Files are restored in reverse order, so a file written twice in one turn
   * ends up with the content it had before the turn started. Paths are
   * re-validated on the way out: they were safe when recorded, but a link could
   * have appeared since, and undo must not be the one thing that writes outside
   * the root.
   */
  async undo(root: string): Promise<UndoFiles | undefined> {
    const index = this.turns.findLastIndex((turn) => turn.changes.length > 0)
    if (index === -1) return undefined

    const turn = this.turns[index]!
    this.turns = this.turns.slice(0, index)

    const restored: string[] = []
    const removed: string[] = []
    for (const change of [...turn.changes].reverse()) {
      const absolute = await resolveToolPath(change.path, { root, log: () => {} })
      if (change.before === null) {
        await rm(absolute, { force: true })
        removed.push(change.path)
      } else {
        await writeFile(absolute, change.before, 'utf8')
        restored.push(change.path)
      }
    }
    return { boundary: turn.boundary, restored, removed }
  }
}
