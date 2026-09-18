/**
 * Prefix permission rules for shell commands, following Claude Code's model.
 *
 * A rule is a command prefix with an optional trailing `*`:
 *   `npm run *`   matches `npm run test`, `npm run build`, and the bare `npm run`
 *   `git status`  matches exactly `git status`
 *
 * Evaluation order per command line: **deny beats allow beats ask**. A deny
 * rule that matches *any* subcommand of a compound rejects the whole line; an
 * allow only approves a line when *every* subcommand matches an allow rule
 * (mirroring the read-only classification). This keeps compound commands from
 * smuggling a risky part past an allow rule.
 */

import { commandLeaders, splitSubcommands } from './command-parse.ts'

export interface PermissionRules {
  /** Prefixes that run without approval. */
  allow: string[]
  /** Prefixes that are always rejected. Overrides allow. */
  deny: string[]
}

export const EMPTY_RULES: PermissionRules = { allow: [], deny: [] }

/** Whether `command` matches one prefix rule (`prefix`, `prefix *`). */
export function matchesPrefix(command: string, rule: string): boolean {
  const normalized = rule.trim()
  if (normalized === '') return false
  if (normalized.endsWith('*')) {
    const prefix = normalized.slice(0, -1)
    // A trailing wildcard also matches the bare prefix itself.
    return command === prefix.trim() || command.startsWith(prefix)
  }
  return command === normalized
}

/** Parse raw config values into validated rules. Invalid entries are dropped. */
export function parseRules(raw: unknown): PermissionRules {
  if (raw === null || typeof raw !== 'object') return EMPTY_RULES
  const record = raw as { allow?: unknown; deny?: unknown }
  const clean = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : []
  return { allow: clean(record.allow), deny: clean(record.deny) }
}

export type PermissionDecision = 'allow' | 'deny' | 'ask'

/**
 * Decide what to do with a full command line under the given rules.
 *
 * - any subcommand matching a deny rule  → deny the whole line
 * - every subcommand matching an allow rule → allow
 * - otherwise → ask
 */
export function evaluate(command: string, rules: PermissionRules): PermissionDecision {
  const parts = splitSubcommands(command)
  if (parts.length === 0) return 'ask'

  for (const part of parts) {
    if (rules.deny.some((rule) => matchesPrefix(part, rule))) return 'deny'
  }

  if (parts.every((part) => rules.allow.some((rule) => matchesPrefix(part, rule)))) {
    return 'allow'
  }

  return 'ask'
}

/**
 * Derive a stable prefix rule from a command the user just approved, so
 * "always allow" covers the natural family: the leading words up to and
 * including a meaningful subcommand (`npm run`, `git commit`), or the bare
 * program (`mkdir`).
 */
export function derivePrefixRule(command: string): string {
  const { program, subcommand } = commandLeaders(command)
  if (program === '') return ''
  // For programs with subcommands worth remembering, keep two words.
  const SUBCOMMAND_PROGRAMS = new Set([
    'npm', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'pip3', 'uv', 'make',
  ])
  if (subcommand && SUBCOMMAND_PROGRAMS.has(program)) {
    return `${program} ${subcommand} *`
  }
  return `${program} *`
}
