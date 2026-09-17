import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext } from '../types.ts'

const MAX_READ_BYTES = 200_000

/**
 * Resolve a user/model supplied path and refuse to leave the workspace root.
 *
 * This is the agent's main safety boundary: the model can read and write inside
 * `ctx.root`, never outside it.
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
    '`limit` is the maximum number of lines. Lines are numbered in the output when a range is given.',
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
    const absolute = resolveInsideRoot(target, ctx)
    let content: string
    try {
      content = await readFile(absolute, 'utf8')
    } catch (error) {
      throw new Error(`Cannot read "${target}": ${describeError(error)}`)
    }
    if (Buffer.byteLength(content) > MAX_READ_BYTES) {
      throw new Error(
        `File "${target}" is larger than ${MAX_READ_BYTES} bytes; read a smaller part instead.`,
      )
    }
    if (content === '') return `(${displayPath(absolute, ctx)} is empty)`

    if (offset === undefined && limit === undefined) return content

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
    const header = `${displayPath(absolute, ctx)} (lines ${start}-${start + slice.length - 1} of ${lines.length})`
    return `${header}\n${numbered}`
  },
}

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file with the given content. Parent directories are created automatically. Paths are relative to the workspace root.',
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
    const absolute = resolveInsideRoot(target, ctx)
    try {
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')
    } catch (error) {
      throw new Error(`Cannot write "${target}": ${describeError(error)}`)
    }
    return `Wrote ${Buffer.byteLength(content)} bytes to ${displayPath(absolute, ctx)}.`
  },
}

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  description:
    'List the entries of a directory, one per line, marked as [dir] or [file] with sizes. Defaults to the workspace root.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path. Defaults to ".".' },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ path: target = '.' }, ctx) {
    const absolute = resolveInsideRoot(target, ctx)
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
