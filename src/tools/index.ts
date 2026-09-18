import type { Tool } from '../types.ts'
import type { PermissionRules } from '../permissions.ts'
import { calculatorTool } from './calculator.ts'
import { editTool } from './edit.ts'
import { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
import { globTool, grepTool } from './search.ts'
import { createShellTool, shellTool } from './shell.ts'
import { currentTimeTool } from './time.ts'

export { ToolRegistry } from './registry.ts'
export { calculatorTool, evaluateExpression } from './calculator.ts'
export { editTool } from './edit.ts'
export { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
export { globTool, grepTool } from './search.ts'
export { createShellTool, shellTool } from './shell.ts'
export { currentTimeTool } from './time.ts'

/**
 * The default toolset: math, time, workspace read/write/search/edit, and shell.
 * Pass `rules` to give the shell tool persistent permission rules.
 */
export function createDefaultTools(options: { rules?: PermissionRules } = {}): Tool[] {
  return [
    calculatorTool as Tool,
    currentTimeTool as Tool,
    listDirTool as Tool,
    readFileTool as Tool,
    writeFileTool as Tool,
    editTool as Tool,
    globTool as Tool,
    grepTool as Tool,
    createShellTool({ rules: options.rules }),
  ]
}
