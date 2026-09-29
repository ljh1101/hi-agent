export { Agent, type AgentOptions, type RunOptions } from './agent.ts'
export { ChangeJournal } from './changes.ts'
export {
  expandCommandTemplate,
  findCustomCommand,
  loadCustomCommands,
  type CustomCommand,
} from './commands.ts'
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
  projectRequestView,
  resolveCompactionOptions,
  resolveContextOptions,
  serializeForSummary,
  shouldCompact,
  SUMMARY_PROMPT,
  textOfContent,
  truncateMiddle,
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
  type WebSearchBackend,
} from './config.ts'
export { LLMError, OpenAICompatibleLLM, createLLM, type CreateLLMOptions, type LLMProtocol, type OpenAICompatibleOptions } from './llm.ts'
export { AnthropicLLM, type AnthropicOptions } from './llm-anthropic.ts'
export { GoogleLLM, type GoogleOptions } from './llm-google.ts'
export {
  appendCompaction,
  appendMessage,
  createForkSession,
  createSession,
  deleteSession,
  flushSessions,
  historyUpToTurn,
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
export { createTaskTool } from './tools/task.ts'
export { createWebFetchTool, createWebSearchTool, webFetchTool, webSearchTool } from './tools/web.ts'
export type {
  AgentEvent,
  ChatMessage,
  ChatOptions,
  ContentBlock,
  FileChange,
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
  UndoResult,
} from './types.ts'
