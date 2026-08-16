import { describe, expect, it } from 'vitest';
import {
  describeModel,
  findModel,
  isCoreCompatible,
  listModels,
  listProviders,
} from '../src/index.js';

describe('model catalog', () => {
  it('lists providers with counts and marks core compatibility', () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(30);

    const groq = providers.find((p) => p.id === 'groq');
    expect(groq).toBeDefined();
    // Groq serves only OpenAI-compatible models.
    expect(groq!.coreCompatibleCount).toBe(groq!.modelCount);
    expect(groq!.coreCompatibleCount).toBeGreaterThan(0);

    // Google's catalog models use the native Gemini API, not chat completions.
    const google = providers.find((p) => p.id === 'google');
    expect(google).toBeDefined();
    expect(google!.coreCompatibleCount).toBe(0);
  });

  it('filters models by provider and core compatibility', () => {
    const groqModels = listModels({ provider: 'groq' });
    expect(groqModels.length).toBeGreaterThan(0);
    expect(groqModels.every((m) => m.provider === 'groq')).toBe(true);
    expect(groqModels.every((m) => m.coreCompatible)).toBe(true);

    const googleCore = listModels({ provider: 'google', coreCompatibleOnly: true });
    expect(googleCore).toEqual([]);
  });

  it('searches by a case-insensitive query', () => {
    const hits = listModels({ provider: 'groq', query: 'QWEN' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) => m.id.toLowerCase().includes('qwen'))).toBe(true);
  });

  it('finds a model globally by unambiguous id', () => {
    const model = findModel(undefined, 'qwen/qwen3.6-27b');
    expect(model).toBeDefined();
    expect(isCoreCompatible(model!)).toBe(true);
  });

  it('finds a model by explicit provider', () => {
    const first = listModels({ provider: 'openrouter', coreCompatibleOnly: true, limit: 1 })[0];
    expect(first).toBeDefined();
    const model = findModel('openrouter', first!.id);
    expect(model).toBeDefined();
    expect(model!.provider).toBe('openrouter');
  });

  it('returns undefined for unknown models', () => {
    expect(findModel('groq', 'does-not-exist')).toBeUndefined();
    expect(describeModel(undefined, 'does-not-exist')).toBeUndefined();
  });

  it('describeModel returns the Guppy-safe shape', () => {
    const desc = describeModel('groq', 'qwen/qwen3.6-27b');
    expect(desc).toBeDefined();
    expect(desc!.provider).toBe('groq');
    expect(desc!.coreCompatible).toBe(true);
    expect(desc!.contextWindow).toBeGreaterThan(0);
    expect(desc!.reasoning).toBe(true);
  });

  it('respects the limit option', () => {
    const two = listModels({ provider: 'openrouter', limit: 2 });
    expect(two).toHaveLength(2);
  });
});
