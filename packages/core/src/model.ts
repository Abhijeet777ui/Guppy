/**
 * Guppy-native model configuration.
 *
 * This replaces the pi-ai `Model` registry with a minimal, provider-agnostic
 * description of *any* OpenAI-compatible endpoint (OpenAI, OpenRouter, NVIDIA
 * NIM, Ollama, LM Studio, local proxies, …). Guppy owns this type — nothing
 * here depends on pi or prime.
 */

export interface ModelConfig {
  /** Provider label, used for API-key resolution (e.g. 'openrouter', 'nvidia'). */
  provider: string;
  /** Model id sent to the endpoint (e.g. 'nvidia/nemotron-3-nano-30b-a3b:free'). */
  model: string;
  /** OpenAI-compatible chat completions base URL. Defaults to OpenAI. */
  baseUrl?: string;
  /** API key for this provider. Resolved from the environment when omitted. */
  apiKey?: string;
  /** Max completion tokens. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Extra HTTP headers merged into each request. */
  headers?: Record<string, string>;
  /** Max retries on transient failures (429/5xx/network errors). Defaults to 2. */
  maxRetries?: number;
  /** Initial backoff delay in ms, doubled per retry. Defaults to 500. */
  retryBaseDelayMs?: number;
  /** Upper bound for a single backoff delay in ms. Defaults to 30_000. */
  retryMaxDelayMs?: number;
  /**
   * Per-request timeout in ms (connect + response headers). Defaults to
   * 120_000; a timed-out request is retried like a network error.
   */
  timeoutMs?: number;
}

/**
 * Provider name → environment variable holding its API key. Extend as needed;
 * this is a convenience for the CLI, not a registry.
 */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  nim: 'NVIDIA_API_KEY',
  prime: 'PRIME_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Resolve the effective API key for a model config: the explicit key wins,
 * then a provider-specific environment variable, then a generic fallback.
 */
export function resolveApiKey(config: ModelConfig): string | undefined {
  if (config.apiKey) return config.apiKey;
  const envVar = PROVIDER_API_KEY_ENV[config.provider];
  if (envVar && process.env[envVar]) return process.env[envVar];
  return process.env['OPENAI_API_KEY'];
}

export function resolveBaseUrl(config: ModelConfig): string {
  return config.baseUrl?.replace(/\/+$/, '') ?? DEFAULT_BASE_URL;
}
