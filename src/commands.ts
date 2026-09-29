/**
 * Custom slash commands: markdown prompt templates (roadmap item 5).
 *
 * `.hi-agent/commands/<name>.md` in the workspace and `<configDir>/commands/`
 * globally. The file body is a prompt template; `/name args` expands into a
 * user message with `$ARGUMENTS` replaced by what the user typed after the
 * command. This is declarative data, not code — design principle 3 (no plugin
 * system) stays intact: a template can say anything, but it can only become a
 * user message, never a new behavior.
 *
 * Precedence: built-in commands win (the CLI checks them first), then project
 * templates override global ones with the same name.
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export interface CustomCommand {
  /** The name the user types after `/`. */
  name: string
  /** The template body (the raw file content). */
  body: string
  /** Where the template came from; project overrides global on name clash. */
  source: 'project' | 'global'
}

/**
 * Replace `$ARGUMENTS` with the user's arguments. Split/join rather than
 * `replace`: a replacement string containing `$&` or `` $` `` would otherwise
 * be re-interpreted as a pattern reference. When the template has no
 * placeholder, the arguments are appended as their own paragraph — a template
 * that ignores its arguments would silently swallow what the user typed.
 */
export function expandCommandTemplate(body: string, args: string): string {
  if (body.includes('$ARGUMENTS')) return body.split('$ARGUMENTS').join(args)
  if (args === '') return body
  return `${body}\n\n${args}`
}

/**
 * Load every custom command template from the global and project directories.
 * A missing directory is the normal case, not an error. Only `*.md` files
 * with plain-name stems (`a-z0-9_-`) load; anything else would never be
 * reachable behind a single slash token.
 */
export async function loadCustomCommands(
  root: string,
  configDir: string,
  dirs: { project?: string; global?: string } = {},
): Promise<CustomCommand[]> {
  const byName = new Map<string, CustomCommand>()
  const candidates: Array<{ dir: string; source: 'project' | 'global' }> = [
    { dir: dirs.global ?? path.join(configDir, 'commands'), source: 'global' },
    { dir: dirs.project ?? path.join(root, '.hi-agent', 'commands'), source: 'project' },
  ]

  for (const { dir, source } of candidates) {
    // A missing directory is the normal case, not an error.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
    if (!entries) continue
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.slice(0, -'.md'.length)
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue
      const body = await readFile(path.join(dir, entry.name), 'utf8').catch(() => undefined)
      if (body === undefined) continue // unreadable template: skip rather than fail startup
      byName.set(name, { name, body, source }) // later source (project) wins
    }
  }

  return [...byName.values()]
}

/**
 * Match a slash input against the loaded commands: `/name args...` → the
 * command plus the argument text. Returns undefined when nothing matches
 * (built-ins never reach here — the CLI dispatches them first).
 */
export function findCustomCommand(
  commands: readonly CustomCommand[],
  input: string,
): { command: CustomCommand; args: string } | undefined {
  if (!input.startsWith('/')) return undefined
  const body = input.slice(1)
  const separator = body.search(/\s/)
  const name = separator === -1 ? body : body.slice(0, separator)
  const args = separator === -1 ? '' : body.slice(separator + 1).trim()
  const command = commands.find((candidate) => candidate.name === name)
  if (!command) return undefined
  return { command, args }
}
