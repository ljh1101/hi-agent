import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '../types.ts'
import { EMPTY_RULES, evaluate, type PermissionRules } from '../permissions.ts'
import { resolveInsideRoot } from './filesystem.ts'
import { commandLeaders, splitSubcommands } from '../command-parse.ts'

const DEFAULT_TIMEOUT_MS = 120_000
/** Hard cap for the per-call `timeout` argument, in seconds. */
const MAX_TIMEOUT_SECONDS = 300
/** Agent-level fallback timeout: must be >= MAX_TIMEOUT_SECONDS so the tool's
 * own timeout (which kills the process tree) always fires first. */
const AGENT_FALLBACK_TIMEOUT_MS = (MAX_TIMEOUT_SECONDS + 5) * 1000
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

/**
 * Built-in read-only commands that run without approval, mirroring Claude
 * Code's approach. A command is read-only only when *every* part of it (every
 * subcommand of a compound command) is read-only, has no redirection, and does
 * not contain command substitution.
 */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'echo',
  'pwd',
  'head',
  'tail',
  'grep',
  'find',
  'wc',
  'which',
  'diff',
  'stat',
  'du',
  'cd',
  'sort',
  'uniq',
  'printf',
  'whereis',
  'type',
  'dirname',
  'basename',
  'realpath',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'show',
  'diff',
  'rev-parse',
  'ls-files',
  'remote',
  'blame',
  'describe',
])

/**
 * Whether a single subcommand is safe to run without approval.
 *
 * Command substitutions (`$(...)`, backticks) and file redirections make the
 * command non-read-only outright. Descriptor redirections (`2>&1`, `>&2`) and
 * `/dev/null` are harmless and allowed. Write-capable flags on otherwise
 * read-only commands (`find -delete`, `git branch -D`) also disqualify.
 */
function isReadOnlySubcommand(command: string): boolean {
  // Command substitution can execute anything; never whitelist it.
  if (command.includes('$(') || command.includes('`')) return false
  // File redirections read or write files; never whitelist them.
  if (hasFileRedirection(command)) return false

  const { program, subcommand } = commandLeaders(command)
  // Path-prefixed programs (/bin/rm, ./script) are never whitelisted.
  if (program === '' || program.includes('/')) return false

  if (program === 'git') {
    if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
    // Write-capable flags on read-only git subcommands (e.g. `branch -D`).
    if (subcommand === 'branch' && /\s-D\b|\s-d\b|\s--delete\b/.test(command)) return false
    if (subcommand === 'tag' && /\s-d\b|\s--delete\b/.test(command)) return false
    // `git log --output=FILE` writes an arbitrary file.
    if (/\s--output(-\w+)*(=|\s)/.test(command)) return false
    return true
  }

  if (program === 'find') {
    // `find -delete` and `find -exec` are write/exec capabilities.
    if (/\s-delete\b|\s-exec\b|\s-execdir\b|\s-ok\b|\s-okdir\b|\s-fprint/.test(command)) return false
    return true
  }

  if (program === 'tail') {
    // `tail -f` never terminates; it just burns the timeout budget.
    if (/\s-[a-zA-Z]*f\b|\s--follow\b/.test(command)) return false
    return true
  }

  return READ_ONLY_COMMANDS.has(program)
}

/**
 * Detect a redirection to a real file. Descriptor duplications (`2>&1`,
 * `>&2`) and redirects into `/dev/null` are safe; anything else (`> file`,
 * `>> file`, `< file`, `2> file`) targets a file and needs approval.
 */
function hasFileRedirection(command: string): boolean {
  // Strip quoted strings first so `echo "a > b"` does not count.
  const unquoted = command.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
  // Remove harmless forms: fd duplication (`>&N`, `N>&M`) and /dev/null targets.
  const harmless = unquoted
    .replace(/\d*>&\d+/g, '')
    .replace(/>>?\s*\/dev\/null/g, '')
  return /\d*(>>|>|<)/.test(harmless)
}

/**
 * Whether a full command line is safe to run without approval: every
 * subcommand of the compound must be read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
  const parts = splitSubcommands(command)
  if (parts.length === 0) return false
  return parts.every((part) => isReadOnlySubcommand(part))
}

/** A shell invocation: the executable and its argument vector. */
interface ShellConfig {
  shell: string
  args: string[]
}

/**
 * Resolve the platform's default shell.
 *
 * Windows: `cmd.exe` (always present, no Git Bash requirement). Unix: `bash`
 * with a fallback to `sh`.
 */
function resolveShell(): ShellConfig {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c'] }
  }
  if (existsSync('/bin/bash')) return { shell: '/bin/bash', args: ['-c'] }
  return { shell: 'sh', args: ['-c'] }
}

/**
 * Kill a process and all its descendants, cross-platform.
 *
 * Unix relies on process groups (the child is spawned detached, so it leads its
 * own group; killing the negative pid takes out the whole tree). Windows has no
 * process groups, so we shell out to `taskkill /T`.
 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = spawn(taskkill, ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => {})
    } catch {
      // Best effort; the process may have already exited.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Fall back to killing just the direct child if the group kill failed.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already gone.
    }
  }
}

/**
 * Run a command in `cwd`, streaming stdout+stderr into a bounded buffer.
 *
 * Returns the exit code. Timeout and abort both kill the whole process tree.
 * An output buffer `size` is filled with the first 50KB; the full history is
 * never unbounded. When the command produces more than the limits, the returned
 * `text` keeps the *tail* (the last lines/bytes) and reports truncation.
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number | null; text: string; truncated: boolean; timedOut: boolean }> {
  const { shell, args } = resolveShell()

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let output = Buffer.alloc(0)
    let dropped = false
    let timedOut = false
    let settled = false

    const finish = (what: 'exit' | 'error' | 'timeout' | 'abort', exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const { text, truncated } = truncateTail(output, MAX_BYTES, MAX_LINES)
      const wasTruncated = truncated || dropped
      if (what === 'error') {
        reject(new Error(`Failed to spawn ${shell}`))
        return
      }
      if (what === 'timeout') {
        resolve({ exitCode: null, text, truncated: wasTruncated, timedOut: true })
        return
      }
      if (what === 'abort') {
        resolve({ exitCode: null, text, truncated: wasTruncated, timedOut: false })
        return
      }
      resolve({ exitCode, text, truncated: wasTruncated, timedOut: false })
    }

    // Only the tail is ever returned, so keep the buffer bounded: once it
    // exceeds the cap, drop the head. This bounds memory even for `yes`.
    const onData = (chunk: Buffer): void => {
      output = Buffer.concat([output, chunk])
      if (output.length > MAX_BYTES * 2) {
        output = output.subarray(output.length - MAX_BYTES)
        dropped = true
      }
    }
    const onAbort = (): void => {
      if (child.pid) killProcessTree(child.pid)
      finish('abort', null)
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', () => {
      if (child.pid) killProcessTree(child.pid)
      finish('error', null)
    })
    child.once('close', (code) => {
      if (timedOut) return
      finish('exit', code)
    })

    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killProcessTree(child.pid)
      finish('timeout', null)
    }, timeoutMs)
  })
}

/**
 * Keep the *tail* of a command's output, bounded by bytes then lines. Never
 * splits a multi-byte UTF-8 character and never returns a partial line.
 */
function truncateTail(
  buffer: Buffer,
  maxBytes: number,
  maxLines: number,
): { text: string; truncated: boolean } {
  if (buffer.length === 0) return { text: '', truncated: false }

  const truncatedByBytes = buffer.length > maxBytes
  const slice = truncatedByBytes ? buffer.subarray(buffer.length - maxBytes) : buffer

  // Back off to a UTF-8 character boundary if we landed mid-character.
  let start = 0
  if (truncatedByBytes) {
    while (start < slice.length && (slice[start]! & 0xc0) === 0x80) start++
  }
  const text = slice.subarray(start).toString('utf8')

  const lines = text.split(/\r?\n/)
  if (lines.length <= maxLines) {
    return { text, truncated: truncatedByBytes }
  }

  const tail = lines.slice(-maxLines).join('\n')
  return { text: tail, truncated: true }
}

export interface ShellToolOptions {
  /** Persistent permission rules from the project/global config. */
  rules?: PermissionRules
}

/**
 * Create the shell tool. Permission evaluation order:
 *
 *   1. read-only whitelist (no approval)
 *   2. persistent rules — deny wins over allow, allow approves only when every
 *      subcommand of a compound matches (no approval)
 *   3. approver hook; denied by default when absent
 */
export function createShellTool(options: ShellToolOptions = {}): Tool<{
  command: string
  timeout?: number
  workdir?: string
}> {
  const rules = options.rules ?? EMPTY_RULES
  return {
  name: 'shell',
  description:
    'Execute a shell command and return its stdout and stderr. Commands run inside ' +
    'the workspace root (or `workdir` relative to it). Read-only commands (ls, cat, ' +
    'grep, git status, ...) run without approval; anything else needs user approval. ' +
    'Output is truncated to the last 2000 lines or 50KB; a non-zero exit code is ' +
    'reported as an error. Prefer the dedicated tools (read_file, glob, grep, edit) ' +
    'over `ls`/`cat`/`grep` in the shell. If a command is denied, do not try to ' +
    'rephrase or restructure it to dodge the denial; ask the user instead.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: { type: 'integer', description: 'Timeout in seconds (default 120, max 300).' },
      workdir: { type: 'string', description: 'Directory to run in, relative to the workspace root.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  timeoutMs: AGENT_FALLBACK_TIMEOUT_MS,
  permission: 'dangerous',
  async execute({ command, timeout, workdir }, ctx) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('"command" must be a non-empty string')
    }
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1)) {
      throw new Error('"timeout" must be a positive integer number of seconds')
    }
    if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) {
      throw new Error(`"timeout" must be at most ${MAX_TIMEOUT_SECONDS} seconds`)
    }
    const cwd = workdir === undefined ? ctx.root : resolveInsideRoot(workdir, ctx)
    const timeoutMs = timeout !== undefined ? timeout * 1000 : DEFAULT_TIMEOUT_MS

    // Permission chain: read-only whitelist → persistent rules (deny wins) →
    // approver. Without an approver, anything not explicitly allowed is denied.
    const decision = isReadOnlyCommand(command)
      ? 'allow'
      : evaluate(command, rules)
    if (decision === 'deny') {
      throw new Error(
        'Command blocked by a deny rule in the project configuration. ' +
          'Do not try to work around it; ask the user instead.',
      )
    }
    if (decision === 'ask') {
      if (!ctx.approve) {
        throw new Error(
          'Command requires approval but no approver is configured. ' +
            'Pass `approver` when constructing the Agent to allow interactive confirmation, ' +
            'or add it to `permissions.allow` in hi-agent.json.',
        )
      }
      const where = workdir === undefined ? '' : ` (in ${workdir})`
      const allowed = await ctx.approve(`Run shell command: ${command}${where}`, command)
      if (!allowed) {
        throw new Error(
          'Command denied by user. Do not try to work around the denial; ask the user instead.',
        )
      }
    }

    let result
    try {
      result = await runCommand(command, cwd, timeoutMs, ctx.signal)
    } catch (error) {
      throw new Error(`Cannot run command: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (result.timedOut) {
      const detail = result.text ? `\n\nOutput (truncated):\n${result.text}` : ''
      throw new Error(`Command timed out after ${timeoutMs / 1000}s.${detail}`)
    }
    if (ctx.signal?.aborted) {
      throw new Error('Command aborted.')
    }
    if (result.exitCode !== 0 && result.exitCode !== null) {
      const detail = result.text ? `\n\nOutput:\n${result.text}` : ''
      throw new Error(`Command exited with code ${result.exitCode}.${detail}`)
    }

    const truncationNote = result.truncated ? '\n[output truncated; only the tail is shown]' : ''
    return result.text === '' ? '(no output)' : `${result.text}${truncationNote}`
  },
  }
}

/** Backwards-compatible singleton: shell tool without persistent rules. */
export const shellTool: Tool<{ command: string; timeout?: number; workdir?: string }> =
  createShellTool()