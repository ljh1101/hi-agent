import type { Tool } from '../types.ts'
import { calculatorTool } from './calculator.ts'
import { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
import { currentTimeTool } from './time.ts'

export { ToolRegistry } from './registry.ts'
export { calculatorTool, evaluateExpression } from './calculator.ts'
export { listDirTool, readFileTool, writeFileTool } from './filesystem.ts'
export { currentTimeTool } from './time.ts'

/** The MVP toolset: enough to reason about math, time and the local workspace. */
export function createDefaultTools(): Tool[] {
  return [
    calculatorTool as Tool,
    currentTimeTool as Tool,
    listDirTool as Tool,
    readFileTool as Tool,
    writeFileTool as Tool,
  ]
}
