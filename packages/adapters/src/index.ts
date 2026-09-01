export * from "./claude-code.js";
export * from "./agent-context-cache.js";
export * from "./hosted-context.js";
export {
  changeAgentHook,
  detectAgentInstallation,
  detectAgentVersion,
  quoteHookArgument,
  readAgentHookStatus,
  validateAgentExecutableStamp
} from "./hook-installation.js";
export type {
  AgentInstallation,
  HookInstallOptions,
  HookMutationResult
} from "./hook-installation.js";
export {
  AGENT_COMPATIBILITY,
  HOOK_INPUT_MAX_BYTES,
  agentContextAdapterV1,
  antigravityAdapter,
  claudeCodeAdapter,
  codexCliAdapter,
  geminiCliAdapter,
  kimiCliAdapter,
  opencodeAdapter,
  runAgentHook
} from "./stubs.js";
export type {
  AgentAdapter,
  AgentContextAdapterV1,
  AgentContextAdapterV1Input,
  AgentContextAdapterV1Output,
  AgentContextDiagnosticCode,
  AgentCompatibilityGate,
  AgentHookRequest,
  AgentHookResult,
  AgentId
} from "./stubs.js";
