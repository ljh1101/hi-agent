/**
 * Shell command parsing shared by the shell tool (read-only classification)
 * and the permission rules engine (prefix matching). Quoting-aware splitting
 * of compound commands plus leading-word extraction.
 *
 * The parser is dialect-aware, because the two shells this project drives
 * disagree about escaping:
 *
 *   bash:       `\` escapes the next character — outside quotes and inside
 *               `"…"`. Inside `'…'` nothing is special.
 *   PowerShell: the BACKTICK escapes the next character (in the same three
 *               contexts); `\` is an ordinary character, which is why
 *               `"C:\dir\"` is a complete string in PowerShell but an
 *               escaped quote in bash.
 *
 * Getting this wrong is not cosmetic. If the parser believes a separator is
 * escaped while the real shell does not, the hidden command rides along on the
 * first subcommand's allow decision: measured on Windows, a `Get-Content` line
 * with an escaped `\;` was classified read-only and deleted a file outside the
 * workspace root without any approval. Every dialect rule here errs toward
 * SPLITTING, which is the stricter direction — a part that should not have
 * been split can only ever make the whole line harder to approve.
 */

/** The shell whose grammar a command is written in. */
export type ShellDialect = 'posix' | 'powershell'

/** The dialect of the shell this process will actually spawn. */
export function defaultDialect(): ShellDialect {
  return process.platform === 'win32' ? 'powershell' : 'posix'
}

/** The character that escapes the next one in `dialect`. */
function escapeChar(dialect: ShellDialect): string {
  return dialect === 'powershell' ? '`' : '\\'
}

/**
 * Split a compound command into its subcommands. Shell separators: `&&`, `||`,
 * `;`, `|`, `|&`, a bare `&` and newlines. Quoted strings are respected so a
 * `;` inside quotes does not split.
 *
 * A bare `&` is a separator in both dialects this project speaks: it
 * backgrounds the preceding command in POSIX shells, and it is the background
 * operator in PowerShell 7 (in earlier PowerShell it is the call operator,
 * which reads a following command as the program to run — splitting there is
 * the strict reading of both). Leaving it out let `type a.txt & del a.txt`
 * pass the read-only test on its first word alone. The redirection forms
 * `2>&1`, `>&2` and bash's `&>file` contain `&` too, so a `&` adjacent to `>`
 * is never treated as a separator.
 */
export function splitSubcommands(
  command: string,
  dialect: ShellDialect = defaultDialect(),
): string[] {
  const parts: string[] = []
  const escape = escapeChar(dialect)
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    // Neither dialect honors escapes inside single quotes, so `'` is exempt
    // from the escape rule in both — one of the few things they agree on.
    if (ch === escape && quote !== "'") {
      current += ch
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = undefined
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '|&') {
      parts.push(current)
      current = ''
      i++
      continue
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      parts.push(current)
      current = ''
      continue
    }
    // A bare `&` separates commands; `&` touching a `>` is a redirection.
    if (ch === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Environment variable assignments that may be stripped before reading the
 * command's leading word.
 *
 * Stripping *every* `NAME=value` prefix was a hole: the prefix changes the
 * environment the command runs in, so `PATH=./evil cat x` ran a model-supplied
 * `cat` while the classifier saw the whitelisted name (likewise `LD_PRELOAD`
 * and `GIT_EXTERNAL_DIFF`, which are code execution by themselves). Only
 * variables that cannot change what gets executed or which file gets read are
 * stripped. Anything else keeps its assignment, so the leading word no longer
 * matches a whitelisted program and the command goes to the approver.
 *
 * `LC_*` is covered by prefix: the locale categories are interchangeable in
 * kind and none of them influences program lookup or file selection.
 */
const SAFE_ENV_ASSIGNMENTS = new Set([
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLUMNS',
  'LINES',
  'NO_COLOR',
  'FORCE_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
])

function isSafeEnvAssignment(word: string): boolean {
  const name = word.slice(0, word.indexOf('='))
  return SAFE_ENV_ASSIGNMENTS.has(name) || name.startsWith('LC_')
}

/**
 * The leading words of a single (non-compound) command, with known-safe
 * environment variable assignments (`LANG=C cmd`) stripped.
 */
export function commandLeaders(command: string): { program: string; subcommand: string | undefined } {
  const words = command.trim().split(/\s+/)
  while (
    words.length > 0 &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) &&
    isSafeEnvAssignment(words[0]!)
  ) {
    words.shift()
  }
  const program = words[0] ?? ''
  return {
    program,
    subcommand: words[1],
  }
}
