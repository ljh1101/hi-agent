/**
 * Shell command parsing shared by the shell tool (read-only classification)
 * and the permission rules engine (prefix matching). Quoting-aware splitting
 * of compound commands plus leading-word extraction.
 */

/**
 * Split a compound command into its subcommands. Shell separators: `&&`, `||`,
 * `;`, `|`, `|&` and newlines. Quoted strings are respected so a `;` inside
 * quotes does not split.
 */
export function splitSubcommands(command: string): string[] {
  const parts: string[] = []
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
    if (ch === '\\' && quote !== "'") {
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
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * The leading words of a single (non-compound) command, with environment
 * variable assignments (`FOO=bar cmd`) stripped.
 */
export function commandLeaders(command: string): { program: string; subcommand: string | undefined } {
  const words = command.trim().split(/\s+/)
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
    words.shift()
  }
  const program = words[0] ?? ''
  return {
    program,
    subcommand: words[1],
  }
}
