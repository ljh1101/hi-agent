import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext } from '../types.ts'
import { displayPath, resolveToolPath, splitLines } from './filesystem.ts'

const MAX_MATCHES = 200
const MAX_GREP_LINE = 500
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.cache'])

/**
 * Recursively collect every file under `dir`.
 *
 * Robustness guarantees:
 * - unreadable subdirectories are skipped, not fatal (permission races, deleted dirs)
 * - symlinked directories are not followed, so cycles cannot recurse forever
 * - directories listed in `.gitignore` are pruned (in addition to DEFAULT_SKIP_DIRS)
 *
 * Returns absolute paths so the caller can resolve them relative to the root.
 */
async function walk(dir: string, skipDirs: Set<string>): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out // unreadable directory: skip and keep going
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      out.push(...(await walk(absolute, skipDirs)))
    } else if (entry.isFile()) {
      out.push(absolute)
    }
    // symlinks (isSymbolicLink) are neither file nor dir, so they are ignored.
  }
  return out
}

/**
 * Read `.gitignore` from the workspace root and merge its directory entries into
 * the skip set. Lines are parsed leniently: blanks and comments are dropped, and
 * a trailing `/` or `/`-free name both mean "this directory name, anywhere".
 */
async function collectSkipDirs(root: string): Promise<Set<string>> {
  const skipDirs = new Set(DEFAULT_SKIP_DIRS)
  let text: string
  try {
    text = await readFile(path.join(root, '.gitignore'), 'utf8')
  } catch {
    return skipDirs // no .gitignore: defaults only
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    // A `/`-prefixed or `/`-containing entry is a path, not a bare name.
    const name = line.replace(/\/+$/, '').split('/')[0] ?? ''
    if (name !== '' && name !== '*') skipDirs.add(name)
  }
  return skipDirs
}

/**
 * Convert a glob pattern into a RegExp. Matches against POSIX-style relative
 * paths (always `/`-separated), so platform separators never matter here.
 *
 * Supported syntax:
 *   `**`  any number of path segments        `*.js`   one segment
 *   `?`   single character                   `{a,b}`  alternation
 */
function globToRegex(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` (optionally followed by a slash) matches any depth.
        re += '.*'
        i += 2
        if (pattern[i] === '/') i++
      } else {
        re += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      re += '[^/]'
      i++
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end !== -1) {
        const options = pattern.slice(i + 1, end).split(',').map(escapeRegex)
        re += `(${options.join('|')})`
        i = end + 1
      } else {
        re += '\\{'
        i++
      }
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i)
      if (end !== -1) {
        re += pattern.slice(i, end + 1)
        i = end + 1
      } else {
        re += '\\['
        i++
      }
    } else {
      re += escapeRegex(ch)
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: 'glob',
  description:
    'Find files whose path matches a glob pattern, e.g. "**/*.ts" or "src/*.{js,ts}". ' +
    'Returns relative paths. Use this to locate files by name before reading them.',
  promptSnippet: 'find files by name pattern',
  promptGuidelines: [
    'Prefer glob and grep over shell ls/find/grep: they need no approval and return compact results.',
  ],
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute({ pattern, path: target = '.' }, ctx) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error('"pattern" must be a non-empty string')
    }
    const absolute = await resolveToolPath(target, ctx)
    const regex = globToRegex(pattern)
    const skipDirs = await collectSkipDirs(ctx.root)

    let files: string[]
    try {
      files = await walk(absolute, skipDirs)
    } catch (error) {
      throw new Error(`Cannot search "${target}": ${describeError(error)}`)
    }

    const matches = files
      .map((file) => displayPath(file, ctx))
      .filter((rel) => regex.test(rel))
      .sort((a, b) => a.localeCompare(b))

    if (matches.length === 0) return `No files match "${pattern}".`
    const truncated = matches.length > MAX_MATCHES
    const shown = truncated ? matches.slice(0, MAX_MATCHES) : matches
    return [
      `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${pattern}":`,
      ...shown,
      ...(truncated ? [`... (${matches.length - MAX_MATCHES} more, truncated)`] : []),
    ].join('\n')
  },
}

export const grepTool: Tool<{
  pattern: string
  path?: string
  include?: string
  context?: number
}> = {
  name: 'grep',
  description:
    'Search file contents for a regular expression and return matching lines with file:line. ' +
    'Searches the workspace root (or the given directory). Use this to find code or text by content. ' +
    'Set `context` to also return that many lines before and after each match.',
  promptSnippet: 'find where specific content appears, with file:line to follow up on',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
      include: { type: 'string', description: 'Glob to restrict files, e.g. "*.ts".' },
      context: { type: 'integer', description: 'Lines of context before and after each match.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute({ pattern, path: target = '.', include, context = 0 }, ctx) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error('"pattern" must be a non-empty string')
    }
    if (!Number.isInteger(context) || context < 0) {
      throw new Error('"context" must be a non-negative integer')
    }
    const absolute = await resolveToolPath(target, ctx)
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`)
    }

    const includeRegex = include ? globToRegex(include) : undefined
    const includeBasename = include && !include.includes('/')
    const skipDirs = await collectSkipDirs(ctx.root)

    let files: string[]
    try {
      files = await walk(absolute, skipDirs)
    } catch (error) {
      throw new Error(`Cannot search "${target}": ${describeError(error)}`)
    }

    const results: string[] = []
    for (const file of files) {
      const rel = displayPath(file, ctx)
      if (includeRegex) {
        const subject = includeBasename ? path.basename(rel) : rel
        if (!includeRegex.test(subject)) continue
      }

      let buffer: Buffer
      try {
        buffer = await readFile(file)
      } catch {
        continue
      }
      // Skip binary files: a NUL byte anywhere means it is not text.
      if (buffer.includes(0)) continue

      const text = buffer.toString('utf8')
      const lines = splitLines(text)

      if (context === 0) {
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!
          if (!regex.test(line)) continue
          const body = line.length > MAX_GREP_LINE ? `${line.slice(0, MAX_GREP_LINE)}...` : line
          results.push(`${rel}:${index + 1}:${body}`)
          if (results.length >= MAX_MATCHES) break
        }
        if (results.length >= MAX_MATCHES) break
        continue
      }

      const matchIndexes: number[] = []
      for (let index = 0; index < lines.length; index++) {
        if (regex.test(lines[index]!)) matchIndexes.push(index)
      }

      for (const index of matchIndexes) {
        if (results.length >= MAX_MATCHES) break
        const from = Math.max(0, index - context)
        const to = Math.min(lines.length - 1, index + context)
        for (let lineNo = from; lineNo <= to; lineNo++) {
          const line = lines[lineNo]!
          const marker = lineNo === index ? ':' : '-'
          const body = line.length > MAX_GREP_LINE ? `${line.slice(0, MAX_GREP_LINE)}...` : line
          results.push(`${rel}${marker}${lineNo + 1}${marker}${body}`)
        }
        results.push('--')
      }
      if (results.length >= MAX_MATCHES) break
    }

    // Drop a trailing separator.
    if (results.at(-1) === '--') results.pop()

    if (results.length === 0) return `No matches for /${pattern}/.`
    return [
      `${results.length} line${results.length === 1 ? '' : 's'} for /${pattern}/:`,
      ...results,
    ].join('\n')
  },
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'no such file or directory'
    if (code === 'ENOTDIR') return 'not a directory'
    return error.message
  }
  return String(error)
}
