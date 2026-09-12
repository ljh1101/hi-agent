import type { Tool, ToolDefinition } from '../types.ts'

/**
 * Holds the tools the agent may use and renders them for the model.
 *
 * Kept intentionally tiny: a name-indexed map plus the schema projection the
 * LLM client needs.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  definitions(): ToolDefinition[] {
    return this.list().map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  }
}
