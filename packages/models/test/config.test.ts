import { describe, expect, it } from 'vitest';
import { findModel, selectModel, toModelConfig } from '../src/index.js';

describe('ModelConfig mapping', () => {
  it('maps provider/id/baseUrl from the catalog', () => {
    const cfg = selectModel({ model: 'qwen/qwen3.6-27b', provider: 'groq' });
    expect(cfg).toBeDefined();
    expect(cfg!.provider).toBe('groq');
    expect(cfg!.model).toBe('qwen/qwen3.6-27b');
    expect(cfg!.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(cfg!.extraBody).toBeUndefined();
  });

  it('adds a thinking passthrough for a reasoning model', () => {
    const cfg = selectModel({
      model: 'qwen/qwen3.6-27b',
      provider: 'groq',
      thinkingLevel: 'high',
    });
    expect(cfg).toBeDefined();
    expect(cfg!.extraBody).toHaveProperty('reasoning_effort');
  });

  it('applies explicit overrides (apiKey, maxTokens, temperature, rpm)', () => {
    const cfg = selectModel({
      model: 'qwen/qwen3.6-27b',
      provider: 'groq',
      apiKey: 'sk-x',
      maxTokens: 512,
      temperature: 0.2,
      requestsPerMinute: 15,
    });
    expect(cfg!.apiKey).toBe('sk-x');
    expect(cfg!.maxTokens).toBe(512);
    expect(cfg!.temperature).toBe(0.2);
    expect(cfg!.requestsPerMinute).toBe(15);
  });

  it('returns undefined for an unknown model', () => {
    expect(selectModel({ model: 'nope', provider: 'groq' })).toBeUndefined();
  });

  it('toModelConfig maps a raw model and honors overrides', () => {
    const model = findModel('groq', 'qwen/qwen3.6-27b')!;
    expect(model).toBeDefined();
    const cfg = toModelConfig(model, { baseUrl: 'http://127.0.0.1:1234/v1', thinkingLevel: 'high' });
    expect(cfg.model).toBe('qwen/qwen3.6-27b');
    expect(cfg.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(cfg.extraBody).toHaveProperty('reasoning_effort');
  });

  it('does not default maxTokens from catalog display metadata', () => {
    const model = findModel('groq', 'qwen/qwen3.6-27b')!;
    const cfg = toModelConfig(model);
    expect(cfg.maxTokens).toBeUndefined();
  });
});
