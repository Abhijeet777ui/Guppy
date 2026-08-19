import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLiveModels } from '../src/live-models.js';

/** Minimal fake Response for the mocked global fetch. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchLiveModels — OpenAI-compatible providers', () => {
  it('returns model ids from GET {baseUrl}/models with the bearer key', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({ data: [{ id: 'qwen/qwen3.6-27b' }, { id: 'llama-3.3-70b-versatile' }] }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchLiveModels('groq', 'gk-123', 'https://api.groq.com/openai/v1');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen/qwen3.6-27b', 'llama-3.3-70b-versatile']);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer gk-123');
  });

  it('omits the auth header when no key is supplied', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ models: [{ name: 'local-model' }] }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchLiveModels('ollama', undefined, 'http://localhost:11434');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['local-model']);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });

  it('reports ok:false on an HTTP error', async () => {
    globalThis.fetch = (async () => fakeResponse({ error: 'unauthorized' }, 401)) as typeof fetch;
    const result = await fetchLiveModels('groq', 'bad', 'https://api.groq.com/openai/v1');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('401');
  });

  it('reports ok:false when the endpoint is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const result = await fetchLiveModels('groq', 'k', 'https://api.groq.com/openai/v1');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
  });
});

describe('fetchLiveModels — provider-specific shapes', () => {
  it('parses Ollama /api/tags { models: [{ name }] }', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({ models: [{ name: 'qwen3:27b' }, { name: 'llama3.1:8b' }] }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchLiveModels('ollama', undefined);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen3:27b', 'llama3.1:8b']);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://localhost:11434/api/tags');
  });

  it('parses Gemini /models with the models/ name prefix stripped', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchLiveModels('google', 'g-1');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/models?key=g-1');
  });
});
