export { Agent, type AgentOptions } from './agent.ts'
export {
  buildDefaultSystemPrompt,
  buildToolsSection,
  DEFAULT_SYSTEM_PROMPT,
} from './prompts/system.ts'
export {
  contextUsage,
  estimateTokens,
  findCutPoint,
  pruneMiddle,
  projectHistory,
  resolveCompactionOptions,
  resolveContextOptions,
  serializeForSummary,
  shouldCompact,
  SUMMARY_PROMPT,
  type CompactionOptions,
  type ContextOptions,
  type ContextUsage,
  type ResolvedCompactionOptions,
  type ResolvedContextOptions,
  type TokenUsage,
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
  appendCompaction,
  appendMessage,
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  newSessionId,
  sessionsDir,
  type LoadedSession,
  type SessionMeta,
} from './session.ts'
export {
  derivePrefixRule,
  evaluate,
  matchesPrefix,
  parseRules,
  type PermissionDecision,
  type PermissionRules,
} from './permissions.ts'
export {
  findProvider,
  listModels,
  lookupContextWindow,
  PROVIDERS,
  resetModelsDevCache,
  type ProviderPreset,
} from './providers.ts'
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
