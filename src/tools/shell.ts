import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path, { join } from 'node:path'
import type { Tool } from '../types.ts'
import { EMPTY_RULES, evaluate, type PermissionRules } from '../permissions.ts'
import { resolveInsideRoot } from './filesystem.ts'
import {
  commandLeaders,
  defaultDialect,
  splitSubcommands,
  type ShellDialect,
} from '../command-parse.ts'

const DEFAULT_TIMEOUT_MS = 120_000
/** Hard cap for the per-call `timeout` argument, in seconds. */
const MAX_TIMEOUT_SECONDS = 300
/** Agent-level fallback timeout: must be >= MAX_TIMEOUT_SECONDS so the tool's
 * own timeout (which kills the process tree) always fires first. */
const AGENT_FALLBACK_TIMEOUT_MS = (MAX_TIMEOUT_SECONDS + 5) * 1000
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

const IS_WINDOWS = process.platform === 'win32'

/**
 * Built-in read-only commands that run without approval, mirroring Claude
 * Code's approach. A command is read-only only when *every* part of it (every
 * subcommand of a compound command) is read-only, has no redirection, and does
 * not contain command substitution.
 *
 * This set is shared by both dialects and stays valid on Windows: there these
 * names resolve to PowerShell aliases (`ls` → Get-ChildItem, `type` →
 * Get-Content, `diff` → Compare-Object, `sort` → Sort-Object), all read-only,
 * and where a name does not exist (`head`, `wc`, `which`, ...) it costs one
 * failed call, never an approval prompt. A GNU coreutils install on PATH is
 * read-only for the same names.
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
 * Read-only PowerShell commands, added on top of the shared set on Windows.
 *
 * PowerShell resolves command names case-insensitively, so the lookup
 * lowercases the program name first. Every entry is either a cmdlet that only
 * reads or an alias whose definition is one of those cmdlets (checked against
 * `Get-Alias`). The dangerous aliases are deliberately absent: `rm`/`del`
 * (Remove-Item), `sc` (Set-Content), `set` (Set-Variable), `ac`, `ni`, `si`,
 * `sp`, `mv`, `cp`, `iex` (Invoke-Expression), `ii` (Invoke-Item), `tee`
 * (Tee-Object), and `where` (Where-Object — a script-block filter, not a
 * command lookup; the external tool is `where.exe`).
 */
const POWERSHELL_READ_ONLY_COMMANDS = new Set([
  // Cmdlets that only read.
  'get-childitem',
  'get-content',
  'get-item',
  'get-itemproperty',
  'get-location',
  'get-command',
  'get-help',
  'get-member',
  'get-date',
  'get-variable',
  'get-alias',
  'get-process',
  'get-service',
  'get-module',
  'get-psdrive',
  'get-filehash',
  'get-acl',
  'get-culture',
  'get-uiculture',
  'get-host',
  'get-history',
  'get-random',
  'select-string',
  'select-object',
  'sort-object',
  'measure-object',
  'compare-object',
  'group-object',
  'test-path',
  'resolve-path',
  'split-path',
  'join-path',
  'convertto-json',
  'convertfrom-json',
  'convertto-csv',
  'convertfrom-csv',
  'format-list',
  'format-table',
  'format-wide',
  'format-custom',
  'out-string',
  'out-host',
  'write-output',
  'write-host',
  'write-verbose',
  'write-warning',
  // Read-only aliases of the cmdlets above.
  'ls',
  'dir',
  'gci',
  'cat',
  'gc',
  'type',
  'pwd',
  'gl',
  'echo',
  'write',
  'gm',
  'sls',
  'select',
  'measure',
  'compare',
  'group',
  'ft',
  'fl',
  'fw',
  'fc',
  'json',
  // External tools shipped with Windows that only read.
  'findstr',
  'tree',
  'where.exe',
  'hostname',
  'whoami',
])

/** `git remote` subcommands that rewrite `.git/config`. */
const GIT_REMOTE_WRITE_SUBCOMMANDS = /\bremote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/

/**
 * Whether a single subcommand is safe to run without approval.
 *
 * Command substitutions (`$(...)`, backticks) and file redirections make the
 * command non-read-only outright. Descriptor redirections (`2>&1`, `>&2`) and
 * redirects into the null device are harmless and allowed. Write-capable flags
 * on otherwise read-only commands (`find -fls`, `sort -o`, `git branch -D`)
 * also disqualify, as do PowerShell script blocks: `{...}` and `@...` are code,
 * and cmdlets such as `Sort-Object` and `Select-Object` evaluate the script
 * blocks they are handed.
 */
function isReadOnlySubcommand(command: string, dialect: ShellDialect): boolean {
  const isPowerShell = dialect === 'powershell'
  // Command substitution can execute anything; never whitelist it. The backtick
  // is PowerShell's escape and bash's substitution delimiter, so rejecting it
  // outright is correct in both dialects.
  if (command.includes('$(') || command.includes('`')) return false
  // In PowerShell a script block, a splat and a parenthesized subexpression are
  // code, not data: `Write-Output (Remove-Item x)` runs Remove-Item, and
  // `Sort-Object { ... }` evaluates its script block. Quoted text is exempt, so
  // a regex like `Select-String "a(b)c"` stays whitelisted.
  if (isPowerShell && /[(@{]/.test(withoutQuotedText(command))) return false
  // File redirections read or write files; never whitelist them.
  if (hasFileRedirection(command, dialect)) return false

  const leaders = commandLeaders(command)
  // Path-prefixed programs (/bin/rm, C:\tools\x.exe, ./script) are never
  // whitelisted. PowerShell command lookup is case-insensitive.
  const program = isPowerShell ? leaders.program.toLowerCase() : leaders.program
  const subcommand = isPowerShell ? leaders.subcommand?.toLowerCase() : leaders.subcommand
  if (program === '' || program.includes('/') || program.includes('\\')) return false

  if (program === 'git') {
    if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
    // Write-capable flags on read-only git subcommands (e.g. `branch -D`).
    if (subcommand === 'branch' && /\s-D\b|\s-d\b|\s--delete\b/.test(command)) return false
    if (subcommand === 'tag' && /\s-d\b|\s--delete\b/.test(command)) return false
    // `git remote add|set-url|...` rewrites .git/config.
    if (subcommand === 'remote' && GIT_REMOTE_WRITE_SUBCOMMANDS.test(command)) return false
    // `git log --output=FILE` writes an arbitrary file.
    if (/\s--output(-\w+)*(=|\s)/.test(command)) return false
    return true
  }

  if (program === 'sort') {
    // `sort -o FILE` (and the bundled `-ro FILE`) writes an arbitrary file.
    if (/(^|\s)-[A-Za-z]*o|\s--output(=|\s|$)/.test(command)) return false
    return true
  }

  if (program === 'find') {
    // Every predicate that writes a file or runs a program, spelled out in
    // full rather than pattern-matched. Matching `-fprint` as a substring
    // happened to cover `-fprint`/`-fprint0`/`-fprintf` but silently missed
    // `-fls`, which GNU and BSD find both provide: `find . -fls OUT` wrote an
    // arbitrary file while classified read-only. `-printf` is deliberately
    // absent — it writes to stdout, not to a file.
    if (/(^|\s)-(delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)(\s|$)/.test(command)) {
      return false
    }
    return true
  }

  if (program === 'tail') {
    // `tail -f` never terminates; it just burns the timeout budget.
    if (/\s-[a-zA-Z]*f\b|\s--follow\b/.test(command)) return false
    return true
  }

  if (isPowerShell) {
    // Parameters that act outside the workspace or never terminate, on cmdlets
    // that are otherwise read-only. PowerShell parameter names are
    // case-insensitive, so these matches are too.
    if (program === 'get-help' && /\s-online\b/i.test(command)) return false
    if (program === 'get-content' && /\s-wait\b/i.test(command)) return false
    if (POWERSHELL_READ_ONLY_COMMANDS.has(program)) return true
  }

  return READ_ONLY_COMMANDS.has(program)
}

/**
 * Strip quoted strings, so a syntax check sees only the text the shell itself
 * would parse. `Select-String "a(b)c" file` searches for a literal, and the
 * parentheses inside the quotes must not be read as a subexpression.
 */
function withoutQuotedText(command: string): string {
  return command.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
}

/**
 * Detect a redirection to a real file. Descriptor duplications (`2>&1`,
 * `>&2`) and redirects into the null device (`/dev/null`, PowerShell `$null`,
 * Windows `nul`) are safe; anything else (`> file`, `>> file`, `< file`,
 * `2> file`) targets a file and needs approval.
 */
function hasFileRedirection(command: string, dialect: ShellDialect): boolean {
  // Strip quoted strings first so `echo "a > b"` does not count.
  let harmless = withoutQuotedText(command)
    .replace(/\d*>&\d+/g, '')
    .replace(/>>?\s*\/dev\/null/g, '')
  // `$null` and `nul` are null devices only in PowerShell; elsewhere they are
  // ordinary names (`$null` is not even a name), and `nul.txt` is an ordinary
  // file name everywhere.
  if (dialect === 'powershell') {
    harmless = harmless
      .replace(/>>?\s*\$null(?![A-Za-z0-9_])/gi, '')
      .replace(/>>?\s*nul(?![A-Za-z0-9_.])/gi, '')
  }
  return /\d*(>>|>|<)/.test(harmless)
}

/**
 * Whether a full command line is safe to run without approval: every
 * subcommand of the compound must be read-only.
 *
 * `dialect` must be the dialect of the shell that will run the command — the
 * split and the grammar checks below are meaningless if they use the other
 * shell's rules. Defaults to the host's shell.
 */
export function isReadOnlyCommand(
  command: string,
  dialect: ShellDialect = defaultDialect(),
): boolean {
  const parts = splitSubcommands(command, dialect)
  if (parts.length === 0) return false
  return parts.every((part) => isReadOnlySubcommand(part, dialect))
}

/** A shell invocation: the executable, its fixed arguments, and a command prefix. */
interface ShellConfig {
  shell: string
  args: string[]
  /** Text prepended to every command (only used for Windows PowerShell 5.1). */
  prefix: string
  /**
   * The grammar commands must be parsed with. Classification reads this, never
   * the host platform directly, so the parser and the shell can never disagree
   * about which dialect is running.
   */
  dialect: ShellDialect
}

/**
 * Pin PowerShell's own output encoding to UTF-8.
 *
 * Measured on a Chinese Windows: `[Console]::OutputEncoding` is `gb2312` in
 * both pwsh 7 and 5.1, while the collector decodes UTF-8 — so every PowerShell
 * error message arrived as `�Ҳ���·����...` and the model could not read it.
 * The preamble must stay on line 1 so error line numbers remain accurate.
 * Legacy native tools still write the OEM code page; that part is not fixable
 * from here, because their bytes never pass through PowerShell's encoder.
 */
const POWERSHELL_ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/**
 * Resolve the PowerShell executable to run.
 *
 * Order: PowerShell 7 where an installer would put it, then `pwsh.exe` on PATH
 * (a Microsoft Store install has no `Program Files` entry, only a `WindowsApps`
 * execution alias), then the Windows PowerShell 5.1 that ships with the OS.
 *
 * `exists` is injected so the order can be tested without spawning anything.
 */
export function resolvePowerShellPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const programFiles = env.ProgramFiles ?? env.ProgramW6432 ?? 'C:\\Program Files'
  const installed = path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  if (exists(installed)) return installed

  const pathValue = env.PATH ?? env.Path ?? ''
  for (const dir of pathValue.split(path.win32.delimiter)) {
    if (dir === '') continue
    const candidate = path.win32.join(dir, 'pwsh.exe')
    if (exists(candidate)) return candidate
  }

  return path.win32.join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

/**
 * Resolve the platform's shell.
 *
 * Windows: PowerShell (`pwsh` 7, else the bundled 5.1) — `cmd.exe` is
 * deliberately not used, because its dialect, quoting and OEM code page all
 * differ from what the model writes. Unix: `bash`, else `sh`.
 */
let cachedShell: ShellConfig | undefined

function resolveShell(): ShellConfig {
  if (cachedShell) return cachedShell
  if (IS_WINDOWS) {
    cachedShell = {
      shell: resolvePowerShellPath(),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      prefix: POWERSHELL_ENCODING_PREAMBLE,
      dialect: 'powershell',
    }
    return cachedShell
  }
  cachedShell = existsSync('/bin/bash')
    ? { shell: '/bin/bash', args: ['-c'], prefix: '', dialect: 'posix' }
    : { shell: 'sh', args: ['-c'], prefix: '', dialect: 'posix' }
  return cachedShell
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
  const { shell, args, prefix } = resolveShell()
  // PowerShell parses the command text itself: pass it as ONE argv element and
  // let Node do the Windows quoting (PowerShell understands the `\"` escape).
  const full = `${prefix}${command}`

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, full], {
      cwd,
      detached: !IS_WINDOWS,
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
 *   1. persistent deny rules — always win, including over the whitelist below
 *   2. persistent allow rules — approve only when every subcommand matches
 *   3. read-only whitelist (no approval)
 *   4. approver hook; denied by default when absent
 */
export function createShellTool(options: ShellToolOptions = {}): Tool<{
  command: string
  timeout?: number
  workdir?: string
}> {
  const rules = options.rules ?? EMPTY_RULES
  // The model must know which dialect it is writing: `ls` is a wasted round-trip
  // on Windows and `Get-ChildItem` is a wasted one everywhere else.
  const dialectHint = IS_WINDOWS
    ? 'Commands run through PowerShell: use PowerShell syntax and cmdlets ' +
      '(Get-ChildItem, Get-Content, Select-String, $env:NAME), not cmd.exe batch syntax. '
    : 'Commands run through bash: use POSIX syntax and paths. '
  const readOnlyExamples = IS_WINDOWS
    ? 'Read-only commands (Get-ChildItem, Get-Content, Select-String, git status, ...)'
    : 'Read-only commands (ls, cat, grep, git status, ...)'
  return {
  name: 'shell',
  description:
    'Execute a shell command and return its stdout and stderr. Commands run inside ' +
    `the workspace root (or \`workdir\` relative to it). ${dialectHint}${readOnlyExamples} ` +
    'run without approval; anything else needs user approval. ' +
    'Output is truncated to the last 2000 lines or 50KB; a non-zero exit code is ' +
    'reported as an error. Prefer the dedicated tools (read_file, glob, grep, edit) ' +
    'over listing and searching with the shell. If a command is denied, do not try to ' +
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
  promptSnippet:
    'run shell commands (tests, builds, git, installs); read-only commands run ' +
    'without approval, anything else asks the user first',
  promptGuidelines: [
    'Reach for shell only when no dedicated tool fits (running tests/builds, git, installing deps).',
    'Prefer glob/grep/read_file/edit over shell ls/find/grep/cat/sed: they need no approval.',
    'Chain dependent commands with && in one call instead of several sequential calls.',
    'If the user denies a command, do not rephrase it to dodge the denial; ask them instead.',
  ],
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

    // Permission chain: persistent deny rules → explicit allow rules → the
    // read-only whitelist → the approver. Deny is evaluated first, *before* the
    // whitelist can short-circuit it: the whitelist is a convenience heuristic,
    // and a user who has written `deny: ["cat *"]` must be able to close a hole
    // the heuristic opens. Without an approver, anything not explicitly allowed
    // is denied.
    const { dialect } = resolveShell()
    const ruled = evaluate(command, rules, dialect)
    if (ruled === 'deny') {
      throw new Error(
        'Command blocked by a deny rule in the project configuration. ' +
          'Do not try to work around it; ask the user instead.',
      )
    }
    if (ruled !== 'allow' && !isReadOnlyCommand(command, dialect)) {
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