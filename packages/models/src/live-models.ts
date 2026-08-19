/**
 * Live model discovery — fetch the models a provider actually serves for a
 * given API key, so the setup/launch pickers never ask the user to remember
 * model ids by heart (M2).
 *
 * All OpenAI-compatible providers expose `GET {baseUrl}/models` returning
 * `{ data: [{ id, ... }] }`. The handful of non-OpenAI-compatible providers
 * the catalog marks as "native-only" (google, anthropic) get their own
 * endpoint shapes. Best-effort: any network/auth/parse failure returns
 * `{ ok: false }` and the caller falls back to the static catalog.
 */

export interface LiveModelsResult {
  ok: boolean;
  /** Model ids the endpoint returned (only when ok). */
  models?: string[];
  /** Human-readable failure reason (only when !ok). */
  reason?: string;
}

/** Provider → base URL for the live /models endpoint (catalog fallback). */
const FALLBACK_BASE_URLS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  deepseek: 'https://api.deepseek.com',
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.ai/v1',
  mistral: 'https://api.mistral.ai',
  xai: 'https://api.x.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference',
  'openai-compatible': 'https://api.openai.com/v1',
};

/** Local runtimes that list models without an API key. */
const NO_KEY_LIST_PROVIDERS = new Set(['ollama', 'lmstudio', 'lm-studio', 'local', 'vllm']);

/**
 * Fetch the live model list for a provider.
 *
 * `baseUrl` overrides everything (used for custom OpenAI-compatible
 * endpoints). Otherwise the catalog provider's baseUrl wins; the static map
 * is the last resort. The request is best-effort with an 8s timeout — a dead
 * or slow endpoint must never block onboarding.
 */
export async function fetchLiveModels(
  provider: string,
  apiKey: string | undefined,
  baseUrl?: string,
): Promise<LiveModelsResult> {
  try {
    if (NO_KEY_LIST_PROVIDERS.has(provider)) {
      // Ollama & friends: GET /api/tags, no auth → { models: [{ name }] }.
      const url = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '') + '/api/tags';
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const ids = (body.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => typeof n === 'string' && n !== '');
      return { ok: true, models: ids };
    }

    if (provider === 'google') {
      // Gemini: GET /v1beta/models?key=... → { models: [{ name: 'models/x' }] }.
      const base = (baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
      const res = await fetch(`${base}/models?key=${encodeURIComponent(apiKey ?? '')}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const ids = (body.models ?? [])
        .map((m) => m.name?.replace(/^models\//, ''))
        .filter((n): n is string => typeof n === 'string' && n !== '');
      return { ok: true, models: ids };
    }

    const base = (baseUrl ?? FALLBACK_BASE_URLS[provider] ?? FALLBACK_BASE_URLS['openai-compatible'] ?? 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
    const res = await fetch(`${base}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
    return { ok: true, models: ids };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
