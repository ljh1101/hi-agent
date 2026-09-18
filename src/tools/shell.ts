import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '../types.ts'
import { resolveInsideRoot } from './filesystem.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

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
    let timedOut = false
    let settled = false

    const finish = (what: 'exit' | 'error' | 'timeout' | 'abort', exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const { text, truncated } = truncateTail(output, MAX_BYTES, MAX_LINES)
      if (what === 'error') {
        reject(new Error(`Failed to spawn ${shell}`))
        return
      }
      if (what === 'timeout') {
        resolve({ exitCode: null, text, truncated, timedOut: true })
        return
      }
      if (what === 'abort') {
        resolve({ exitCode: null, text, truncated, timedOut: false })
        return
      }
      resolve({ exitCode, text, truncated, timedOut: false })
    }

    const onData = (chunk: Buffer): void => {
      output = Buffer.concat([output, chunk])
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

export const shellTool: Tool<{ command: string; timeout?: number; workdir?: string }> = {
  name: 'shell',
  description:
    'Execute a shell command and return its stdout and stderr. Commands run inside ' +
    'the workspace root (or `workdir` relative to it). Output is truncated to the last ' +
    '2000 lines or 50KB; a non-zero exit code is reported as an error. Prefer the ' +
    'dedicated tools (read_file, glob, grep, edit) over `ls`/`cat`/`grep` in the shell.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: { type: 'integer', description: 'Timeout in seconds (default 120).' },
      workdir: { type: 'string', description: 'Directory to run in, relative to the workspace root.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async execute({ command, timeout, workdir }, ctx) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('"command" must be a non-empty string')
    }
    const cwd = workdir === undefined ? ctx.root : resolveInsideRoot(workdir, ctx)
    const timeoutMs = timeout !== undefined ? timeout * 1000 : DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeout) && timeout !== undefined) {
      throw new Error('"timeout" must be an integer number of seconds')
    }
    if (timeoutMs <= 0) {
      throw new Error('"timeout" must be a positive number of seconds')
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