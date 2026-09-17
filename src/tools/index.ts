import type { Tool } from '../types.ts'
import { calculatorTool } from './calculator.ts'
import { editTool } from './edit.ts'
import { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
import { globTool, grepTool } from './search.ts'
import { currentTimeTool } from './time.ts'

export { ToolRegistry } from './registry.ts'
export { calculatorTool, evaluateExpression } from './calculator.ts'
export { editTool } from './edit.ts'
export { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
export { globTool, grepTool } from './search.ts'
export { currentTimeTool } from './time.ts'

/** The default toolset: math, time, and workspace read/write/search/edit. */
export function createDefaultTools(): Tool[] {
  return [
    calculatorTool as Tool,
    currentTimeTool as Tool,
    listDirTool as Tool,
    readFileTool as Tool,
    writeFileTool as Tool,
    editTool as Tool,
    globTool as Tool,
    grepTool as Tool,
  ]
}
