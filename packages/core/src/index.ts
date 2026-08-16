/**
 * @guppy/core — Guppy's native agent core.
 *
 * Standalone by design: no pi, no prime, no external agent binary. This
 * package owns the model boundary (OpenAI-compatible client) and, in
 * subsequent slices, the in-process tool loop and CoreAgentRuntime.
 */

export type {
  ModelConfig,
} from './model.js';
export { resolveApiKey, resolveBaseUrl } from './model.js';
export type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
  CompletionResult,
} from './openai-client.js';
export {
  OpenAIChatClient,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from './openai-client.js';
export type {
  GuppyTool,
  ToolExecution,
} from './tools.js';
export { buildGuppyTools } from './tools.js';
export type { CoreRuntimeConfig } from './runtime.js';
export { CoreAgentRuntime, createCoreRuntime } from './runtime.js';
