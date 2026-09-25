/**
 * System prompt content. Kept separate from the agent loop because prompt
 * copy is content, not logic: it should be editable and reviewable without
 * touching `agent.ts`.
 *
 * The assembled prompt is sectioned (identity / tools / rules) mirroring pi's
 * structured prompt. The tools section is built by the agent from each tool's
 * `promptSnippet` and `promptGuidelines` — see `buildToolsSection`.
 */

export const IDENTITY = 'You are hi-agent, a general-purpose agent that solves tasks by calling tools. ' +
  'You operate inside a workspace root: paths given to the file tools are relative to it and cannot leave ' +
  'it, and shell commands start there.'

export const RULES = [
  'Never guess a fact that a tool could give you; call the tool instead.',
  'Batch independent tool calls in one turn; wait for results that later calls depend on.',
  'When a tool returns an error, read it carefully and try a different approach; do not repeat the same call unchanged.',
  'Keep visible replies short and technical. State file paths and commands exactly.',
  'After the tools have given you enough information, reply with the final answer as plain text.',
] as const

/**
 * Build the "# Tools" section from the registered tools' prompt metadata.
 * Tools without a snippet are listed by name only; guidelines from all tools
 * are merged and de-duplicated.
 */
export function buildToolsSection(
  tools: ReadonlyArray<{ name: string; promptSnippet?: string; promptGuidelines?: readonly string[] }>,
): string {
  if (tools.length === 0) return ''

  const lines: string[] = []
  for (const tool of tools) {
    lines.push(tool.promptSnippet ? `- ${tool.name}: ${tool.promptSnippet}` : `- ${tool.name}`)
  }

  const guidelines: string[] = []
  const seen = new Set<string>()
  for (const tool of tools) {
    for (const guideline of tool.promptGuidelines ?? []) {
      const trimmed = guideline.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      guidelines.push(trimmed)
    }
  }

  const sections = ['# Tools', lines.join('\n')]
  if (guidelines.length > 0) {
    sections.push('', ...guidelines.map((guideline) => `- ${guideline}`))
  }
  return sections.join('\n')
}

/**
 * Assemble the full default system prompt. Used by the agent constructor;
 * a user-supplied `systemPrompt` replaces the whole thing.
 */
export function buildDefaultSystemPrompt(
  tools: ReadonlyArray<{ name: string; promptSnippet?: string; promptGuidelines?: readonly string[] }>,
): string {
  const toolsSection = buildToolsSection(tools)
  const parts = [IDENTITY]
  if (toolsSection) parts.push(toolsSection)
  parts.push(['# Rules', ...RULES.map((rule) => `- ${rule}`)].join('\n'))
  return parts.join('\n\n')
}

/**
 * The default prompt with no tools registered — kept for backwards
 * compatibility and for the "system prompt only" display path.
 */
export const DEFAULT_SYSTEM_PROMPT: string = buildDefaultSystemPrompt([])
