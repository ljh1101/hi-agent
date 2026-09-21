export { Agent, DEFAULT_SYSTEM_PROMPT, type AgentOptions } from './agent.ts'
export {
  pruneMiddle,
  projectHistory,
  resolveContextOptions,
  type ContextOptions,
  type ResolvedContextOptions,
} from './context.ts'
export {
  globalConfigDir,
  globalConfigFile,
  loadGlobalConfig,
  loadProjectConfig,
  projectConfigFile,
  resolveConfig,
  saveGlobalConfig,
  type ConfigOverride,
  type HiAgentConfig,
  type ResolvedConfig,
} from './config.ts'
export { LLMError, OpenAICompatibleLLM, type OpenAICompatibleOptions } from './llm.ts'
export {
  derivePrefixRule,
  evaluate,
  matchesPrefix,
  parseRules,
  type PermissionDecision,
  type PermissionRules,
} from './permissions.ts'
export { PROVIDERS, findProvider, listModels, type ProviderPreset } from './providers.ts'
export { ToolRegistry, createDefaultTools } from './tools/index.ts'
export { editTool } from './tools/edit.ts'
export { globTool, grepTool } from './tools/search.ts'
export { shellTool } from './tools/shell.ts'
export type {
  AgentEvent,
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLM,
  LLMResponse,
  Role,
  RunResult,
  StopReason,
  StreamEvent,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './types.ts'
