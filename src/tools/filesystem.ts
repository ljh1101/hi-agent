import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext } from '../types.ts'

const MAX_READ_BYTES = 200_000

/** Line ending a file uses on disk. */
export type LineEnding = '\n' | '\r\n'

/**
 * Detect the line ending a file uses, so a write can restore it.
 *
 * Purity-based on purpose: a single stray `\r\n` inside an otherwise LF file
 * must not reclassify the whole file as CRLF, or one edited line turns into a
 * whole-file rewrite (and a destroyed git blame). A file counts as CRLF only
 * when *every* newline is part of a `\r\n` pair.
 *
 * Lone `\r` (classic Mac) is not treated as a line ending: it is read as
 * ordinary text, so it is never rewritten in a form the model cannot see.
 */
export function detectLineEnding(content: string): LineEnding {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 10) continue
    if (index > 0 && content.charCodeAt(index - 1) === 13) crlf++
    else lf++
  }
  return crlf > 0 && lf === 0 ? '\r\n' : '\n'
}

/**
 * Normalize to LF. This is the only line-ending form the model ever sees,
 * because it cannot emit `\r` inside tool arguments in the first place.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Rewrite LF separators to `eol`; `\n` is a no-op. */
export function applyLineEnding(text: string, eol: LineEnding): string {
  if (eol === '\n') return text
  return text.replace(/\n/g, '\r\n')
}

/**
 * Resolve a model-supplied path and refuse to leave the workspace root.
 *
 * This is the lexical half of the boundary and the first gate every filesystem
 * tool goes through: `..` traversal and absolute paths outside the root are
 * rejected here. It is pure string work, so it cannot see links — callers must
 * also go through `resolveToolPath`, which adds the link check. Never call this
 * directly from a tool.
 */
export function resolveInsideRoot(target: string, ctx: ToolContext): string {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('"path" must be a non-empty string')
  }
  const resolved = path.resolve(ctx.root, target)
  const relative = path.relative(ctx.root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${target}" is outside the workspace root (${ctx.root})`)
  }
  return resolved
}

/**
 * Resolve a path and refuse to leave the root through a link either.
 *
 * `resolveInsideRoot` compares strings, so a symlink or NTFS junction *inside*
 * the root that points outside it passes the check and the read or write then
 * follows the link out: measured, a junction at `<root>/link` made
 * `read_file link/secret.txt` return a file outside the root. This resolves the
 * deepest part of the target that exists — so a file about to be created is
 * checked through its parent — and re-checks the real path against the real
 * root.
 *
 * Every filesystem tool must resolve through this, and the shell tool's
 * `workdir` too.
 */
export async function resolveToolPath(target: string, ctx: ToolContext): Promise<string> {
  const absolute = resolveInsideRoot(target, ctx)
  const realRoot = await realRootOrNothing(ctx.root)
  // A root that does not exist yet cannot contain a link, so there is nothing
  // to resolve: `write_file` may create it (it makes parents recursively).
  if (realRoot === undefined) return absolute

  const realTarget = await realpathDeepestExisting(absolute)
  const relative = path.relative(realRoot, realTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Path "${target}" resolves outside the workspace root through a link (${realTarget})`,
    )
  }
  return absolute
}

/**
 * The real path of the root, or `undefined` when the root does not exist.
 *
 * Only "missing" is tolerated; any other failure (a permission error, a symlink
 * loop) propagates, because guessing there would turn an unresolvable root into
 * an allowed one.
 */
async function realRootOrNothing(root: string): Promise<string | undefined> {
  try {
    return await realpath(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new Error(`Cannot resolve the workspace root "${root}": ${describeError(error)}`)
  }
}

/**
 * `realpath` of the deepest ancestor that exists. A target that does not exist
 * yet (a file about to be written) is checked through its parent, which is the
 * directory the write will actually land in.
 *
 * Only "does not exist" walks up; anything else (a symlink loop, a permission
 * error) fails closed, because guessing would turn an unreadable path into an
 * allowed one.
 */
async function realpathDeepestExisting(target: string): Promise<string> {
  let current = target
  for (;;) {
    try {
      return await realpath(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`Cannot resolve "${target}": ${describeError(error)}`)
      }
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      current = parent
    }
  }
}

/** Path shown to the model: relative to the root, POSIX separators. */
export function displayPath(absolute: string, ctx: ToolContext): string {
  const relative = path.relative(ctx.root, absolute)
  return (relative === '' ? '.' : relative).split(path.sep).join('/')
}

/**
 * Split text into lines, handling both `\n` and `\r\n`, and dropping the
 * trailing empty element that a final newline produces.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'no such file or directory'
    if (code === 'EISDIR') return 'is a directory'
    if (code === 'ENOTDIR') return 'not a directory'
    return error.message
  }
  return String(error)
}

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file and return its contents. Paths are relative to the workspace root. ' +
    'Optionally read a line range: `offset` is the 1-based first line to return, ' +
    '`limit` is the maximum number of lines. Lines are numbered in the output when a range is given. ' +
    'Files over 200,000 bytes must be read in ranges.',
  promptSnippet: 'read a file, or a line range of a file',
  promptGuidelines: [
    'To explore code: glob/grep first to find candidates, then read_file the promising ones.',
    'For large files use grep to locate, then read_file with offset/limit around the match instead of reading the whole file.',
  ],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, e.g. "src/agent.ts".' },
      offset: { type: 'integer', description: '1-based first line to read.' },
      limit: { type: 'integer', description: 'Maximum number of lines to read.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute({ path: target, offset, limit }, ctx) {
    const absolute = await resolveToolPath(target, ctx)
    let raw: string
    try {
      raw = await readFile(absolute, 'utf8')
    } catch (error) {
      throw new Error(`Cannot read "${target}": ${describeError(error)}`)
    }
    // The model never sees `\r`: it cannot produce one in an edit, so exposing
    // it would only create text it cannot reproduce.
    const eol = detectLineEnding(raw)
    const content = normalizeLineEndings(raw)
    if (content === '') return `(${displayPath(absolute, ctx)} is empty)`

    if (offset === undefined && limit === undefined) {
      if (Buffer.byteLength(content) > MAX_READ_BYTES) {
        throw new Error(
          `File "${target}" is larger than ${MAX_READ_BYTES} bytes; read it in parts with "offset" and "limit" (1-based lines), or locate content with grep first.`,
        )
      }
      return content
    }

    const lines = splitLines(content)
    const start = offset === undefined ? 1 : offset
    const end = limit === undefined ? lines.length : start + limit - 1
    if (!Number.isInteger(start) || start < 1) {
      throw new Error('"offset" must be a positive integer')
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error('"limit" must be a positive integer')
    }
    if (start > lines.length) {
      return `(${displayPath(absolute, ctx)} has ${lines.length} lines; offset ${start} is out of range)`
    }

    const slice = lines.slice(start - 1, Math.min(end, lines.length))
    const numbered = slice.map((line, index) => `${start + index}: ${line}`).join('\n')
    // The cap bounds what is *returned*, not which files may be read: the
    // range read is the way out of the full-read error above, so it has to
    // work on a large file — but an unbounded range would otherwise smuggle
    // the whole file through as one observation.
    if (Buffer.byteLength(numbered) > MAX_READ_BYTES) {
      throw new Error(
        `Lines ${start}-${Math.min(end, lines.length)} of "${target}" exceed ${MAX_READ_BYTES} bytes; request a smaller "limit".`,
      )
    }
    const style = eol === '\r\n' ? ', CRLF' : ''
    const header = `${displayPath(absolute, ctx)} (lines ${start}-${start + slice.length - 1} of ${lines.length}${style})`
    return `${header}\n${numbered}`
  },
}

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file with the given content. Parent directories are created automatically. Paths are relative to the workspace root.',
  promptSnippet: 'create a new file or replace one entirely',
  promptGuidelines: [
    'For changing a few lines of an existing file, prefer edit over rewriting it with write_file.',
  ],
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute({ path: target, content }, ctx) {
    if (typeof content !== 'string') throw new Error('"content" must be a string')
    const absolute = await resolveToolPath(target, ctx)

    // An overwrite keeps the line ending the file already had, so rewriting a
    // CRLF file does not turn it into a whole-file diff. New files use LF.
    // The read doubles as the undo snapshot, so it must not swallow a real
    // failure as "the file is new".
    let eol: LineEnding = '\n'
    let before: string | null = null
    try {
      before = await readFile(absolute, 'utf8')
      eol = detectLineEnding(before)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read "${target}": ${describeError(error)}`)
      }
      before = null
    }
    const payload = applyLineEnding(normalizeLineEndings(content), eol)

    try {
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, payload, 'utf8')
    } catch (error) {
      throw new Error(`Cannot write "${target}": ${describeError(error)}`)
    }
    ctx.recordChange?.({ path: displayPath(absolute, ctx), before, after: payload })
    return `Wrote ${Buffer.byteLength(payload)} bytes to ${displayPath(absolute, ctx)}.`
  },
}

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  description:
    'List the entries of a directory, one per line, marked as [dir] or [file] with sizes. Defaults to the workspace root.',
  promptSnippet: 'see what lives in one directory',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path. Defaults to ".".' },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ path: target = '.' }, ctx) {
    const absolute = await resolveToolPath(target, ctx)
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      throw new Error(`Cannot list "${target}": ${describeError(error)}`)
    }
    if (entries.length === 0) return `(${displayPath(absolute, ctx)} is empty)`

    const lines = await Promise.all(
      entries
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (entry) => {
          const kind = entry.isDirectory() ? '[dir]' : '[file]'
          if (entry.isDirectory()) return `${kind} ${entry.name}/`
          let size = ''
          try {
            size = ` (${(await stat(path.join(absolute, entry.name))).size} bytes)`
          } catch {
            size = ''
          }
          return `${kind} ${entry.name}${size}`
        }),
    )
    return lines.join('\n')
  },
}
