import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from '../types.ts'
import {
  applyLineEnding,
  detectLineEnding,
  displayPath,
  normalizeLineEndings,
  resolveInsideRoot,
} from './filesystem.ts'

/**
 * `edit`: exact-string replacement in a file.
 *
 * The model supplies an `old_string` and a `new_string`. The tool finds the
 * `old_string` in the file and replaces it. This mirrors the str-replace editor
 * used by Claude Code, opencode, Cline and gemini-cli: replace the smallest
 * meaningful span instead of rewriting the whole file, so the diff is minimal
 * and other parts of the file are never disturbed.
 *
 * Rules:
 * - `old_string` must appear exactly once — zero or multiple matches is an error,
 *   because either case would make the edit ambiguous or a no-op.
 * - The replaced text must differ from `old_string`, otherwise nothing changed.
 */
export const editTool: Tool<{ path: string; old_string: string; new_string: string }> = {
  name: 'edit',
  description:
    'Replace a unique block of text in a file. Provide the exact text to replace ' +
    '(`old_string`) and its replacement (`new_string`). The old text must appear exactly once; ' +
    'use read_file first to get the exact current text. Prefer this over write_file for small, targeted changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit, e.g. "src/agent.ts".' },
      old_string: { type: 'string', description: 'Exact text currently in the file, to be replaced.' },
      new_string: { type: 'string', description: 'The replacement text.' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  permission: 'write',
  promptSnippet: 'change a span of an existing file by exact string replacement',
  promptGuidelines: [
    'Before editing, read the exact current text with read_file; old_string must match it character-for-character.',
    'If edit reports multiple matches, include more surrounding lines to make old_string unique.',
  ],
  async execute({ path: target, old_string, new_string }, ctx) {
    if (typeof old_string !== 'string' || old_string === '') {
      throw new Error('"old_string" must be a non-empty string')
    }
    if (typeof new_string !== 'string') {
      throw new Error('"new_string" must be a string')
    }
    if (old_string === new_string) {
      throw new Error('"old_string" and "new_string" are identical; no change to make')
    }

    const absolute = resolveInsideRoot(target, ctx)
    let raw: string
    try {
      raw = await readFile(absolute, 'utf8')
    } catch (error) {
      throw new Error(`Cannot edit "${target}": ${describeError(error)}`)
    }

    // Match in LF space and restore the file's own ending on write. The model
    // cannot emit `\r` in tool arguments, so a byte-wise comparison against a
    // CRLF file could never succeed for a multi-line `old_string`.
    const eol = detectLineEnding(raw)
    const content = normalizeLineEndings(raw)
    const needle = normalizeLineEndings(old_string)

    const occurrences = countOccurrences(content, needle)
    if (occurrences === 0) {
      const hint =
        eol === '\r\n' && old_string.includes('\r')
          ? ' The file uses CRLF line endings, but "old_string" contains CR; use plain LF.'
          : ''
      throw new Error(`"old_string" was not found in "${target}".${hint}`)
    }
    if (occurrences > 1) {
      throw new Error(
        `"old_string" appears ${occurrences} times in "${target}"; provide more surrounding text to make it unique`,
      )
    }

    const replaced = content.replace(needle, normalizeLineEndings(new_string))
    const updated = applyLineEnding(replaced, eol)
    try {
      await writeFile(absolute, updated, 'utf8')
    } catch (error) {
      throw new Error(`Cannot write "${target}": ${describeError(error)}`)
    }
    return `Edited ${displayPath(absolute, ctx)} (${occurrences} replacement).`
  },
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const found = haystack.indexOf(needle, from)
    if (found === -1) return count
    count++
    from = found + needle.length
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'no such file or directory'
    if (code === 'EISDIR') return 'is a directory'
    return error.message
  }
  return String(error)
}