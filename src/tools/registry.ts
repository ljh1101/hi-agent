import type { Tool, ToolDefinition } from '../types.ts'

/**
 * A source the registry can ask for tools at load time — the one seam added
 * for MCP (roadmap item 7): a hub implements `list()`, the registry registers
 * what it returns. Discovery is asynchronous, so the caller awaits
 * `loadSource` BEFORE constructing the Agent: the system prompt's tools
 * section is built from `registry.list()` at construction.
 */
export interface ToolSource {
  list(): Promise<Tool[]>
}

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

  /**
   * Register every tool a source provides. A source returning a name that is
   * already taken is skipped (the built-in wins) rather than thrown — a
   * misbehaving MCP server must not take the whole toolset down.
   */
  async loadSource(source: ToolSource): Promise<this> {
    for (const tool of await source.list()) {
      if (!this.tools.has(tool.name)) this.register(tool)
    }
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
