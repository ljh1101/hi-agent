import type { LLM, Tool } from '../types.ts'
import type { WebSearchBackend } from '../config.ts'
import type { PermissionRules } from '../permissions.ts'
import { calculatorTool } from './calculator.ts'
import { editTool } from './edit.ts'
import { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
import { globTool, grepTool } from './search.ts'
import { createShellTool, shellTool } from './shell.ts'
import { currentTimeTool } from './time.ts'
import { createTaskTool } from './task.ts'
import { createWebFetchTool, createWebSearchTool, webFetchTool, webSearchTool } from './web.ts'

export { ToolRegistry } from './registry.ts'
export { calculatorTool, evaluateExpression } from './calculator.ts'
export { editTool } from './edit.ts'
export { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
export { globTool, grepTool } from './search.ts'
export { createShellTool, shellTool } from './shell.ts'
export { currentTimeTool } from './time.ts'
export { createTaskTool } from './task.ts'
export { createWebFetchTool, createWebSearchTool, webFetchTool, webSearchTool } from './web.ts'

/**
 * The default toolset: math, time, workspace read/write/search/edit, shell,
 * web access, and the task sub-agent. Pass `rules` to give the shell tool
 * persistent permission rules; pass `webSearch` to arm the web_search tool
 * with a backend; pass `getLLM` to enable the task tool (the sub-agent talks
 * to the model the closure returns, so `/model` swaps apply to it too).
 */
export function createDefaultTools(
  options: {
    rules?: PermissionRules
    webSearch?: WebSearchBackend
    getLLM?: () => LLM
  } = {},
): Tool[] {
  const tools: Tool[] = [
    calculatorTool as Tool,
    currentTimeTool as Tool,
    listDirTool as Tool,
    readFileTool as Tool,
    writeFileTool as Tool,
    editTool as Tool,
    globTool as Tool,
    grepTool as Tool,
    createShellTool({ rules: options.rules }),
    webFetchTool,
    createWebSearchTool({ backend: options.webSearch }),
  ]
  if (options.getLLM) tools.push(createTaskTool({ getLLM: options.getLLM }))
  return tools
}
