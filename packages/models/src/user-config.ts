/**
 * Per-user provider config (`~/.guppy/config.json`).
 *
 * Stores API keys and provider presets so `guppy run` / `guppy chat` work
 * without environment variables. Keys are stored in plaintext (as other coding
 * agents do) behind a best-effort 0600 file mode. Precedence when building the
 * runtime: an explicit CLI flag beats a preset, a preset beats an env var.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ProviderPreset {
  apiKey?: string;
  baseUrl?: string;
}

export interface DefaultModel {
  provider: string;
  model: string;
}

export interface UserConfig {
  version?: number;
  providers: Record<string, ProviderPreset>;
  default?: DefaultModel;
}

/** The CLI flags that compete with config presets for precedence. */
export interface RuntimeFlags {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Effective provider/model/baseUrl/apiKey after config resolution. */
export interface ResolvedRuntime {
  provider?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export function defaultConfigPath(): string {
  return process.env['GUPPY_CONFIG'] ?? join(homedir(), '.guppy', 'config.json');
}

export function loadUserConfig(path = defaultConfigPath()): UserConfig {
  try {
    if (!existsSync(path)) return { providers: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UserConfig>;
    return {
      providers:
        parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
      ...(parsed.default && typeof parsed.default === 'object' ? { default: parsed.default } : {}),
    };
  } catch {
    // A missing or corrupt config must never break the CLI — degrade to empty.
    return { providers: {} };
  }
}

export function saveUserConfig(config: UserConfig, path = defaultConfigPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/** Render a key for terminal display without leaking it. */
export function maskKey(key: string | undefined): string {
  if (!key) return '(unset)';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Provider ids whose endpoints don't need an API key (local runtimes served
 * from the host, e.g. Ollama / LM Studio). Used to skip the no-key gate.
 */
const NO_KEY_PROVIDERS = new Set(['ollama', 'lmstudio', 'lm-studio', 'local', 'vllm']);

/**
 * Provider id → the environment variable that conventionally holds its key.
 * Mirrors the core client's `PROVIDER_API_KEY_ENV` so first-run detection
 * doesn't depend on `@guppy/core` at runtime.
 */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  nim: 'NVIDIA_API_KEY',
  prime: 'PRIME_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
};

/**
 * True when some usable key exists — a configured preset key, a known
 * provider env var, or the generic OpenAI fallback. This drives the
 * first-run no-key gate: when false and nothing was explicitly supplied,
 * `run`/`chat` redirect to onboarding instead of hitting a dead fallback
 * model.
 */
export function hasAnyApiKey(config: UserConfig = loadUserConfig()): boolean {
  if (
    Object.values(config.providers).some(
      (p) => typeof p.apiKey === 'string' && p.apiKey.trim() !== '',
    )
  ) {
    return true;
  }
  return Object.values(PROVIDER_KEY_ENV).some((v) => process.env[v]);
}

/** True when the provider serves a local model that needs no API key. */
export function isNoKeyProvider(provider: string | undefined): boolean {
  return provider !== undefined && NO_KEY_PROVIDERS.has(provider);
}

/**
 * Resolve effective runtime identity from CLI flags + user config. The config
 * `default` (a provider/model pair) applies only when *neither* `--model` nor
 * `--provider` was given, so an explicit `--provider openrouter` never inherits
 * a default model meant for another provider.
 */
export function resolveRuntimeOptions(
  flags: RuntimeFlags,
  config: UserConfig,
  fallbackModel = 'claude-3-5-sonnet',
): ResolvedRuntime {
  const flagsHasModel = flags.model !== undefined;
  const flagsHasProvider = flags.provider !== undefined;

  let provider: string | undefined;
  let model: string;
  if (config.default && !flagsHasModel && !flagsHasProvider) {
    provider = config.default.provider;
    model = config.default.model;
  } else {
    // Leave provider unset when nothing configured — the caller's own default
    // (e.g. 'openai' in buildAgentRuntime) applies, and an unset provider keeps
    // chat's catalog browsing unfiltered.
    provider = flags.provider;
    model = flags.model ?? fallbackModel;
  }

  const preset = provider !== undefined ? config.providers[provider] : undefined;
  const baseUrl = flags.baseUrl ?? preset?.baseUrl;
  const apiKey = flags.apiKey ?? preset?.apiKey;
  return {
    ...(provider !== undefined ? { provider } : {}),
    model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}
