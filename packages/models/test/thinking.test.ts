import { describe, expect, it } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { buildThinkingBody, detectThinkingFormat } from '../src/index.js';

function mkModel(overrides: Record<string, unknown> = {}): Model<Api> {
  return {
    id: 'test/model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  } as Model<Api>;
}

describe('buildThinkingBody', () => {
  it('emits reasoning_effort for the default OpenAI shape', () => {
    expect(buildThinkingBody(mkModel(), 'high')).toEqual({ reasoning_effort: 'high' });
  });

  it('emits a nested reasoning object for OpenRouter', () => {
    const model = mkModel({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(buildThinkingBody(model, 'high')).toEqual({ reasoning: { effort: 'high' } });
  });

  it('emits thinking + reasoning_effort for DeepSeek', () => {
    const model = mkModel({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' });
    expect(buildThinkingBody(model, 'high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('prefers an explicit compat.thinkingFormat over auto-detection', () => {
    const model = mkModel({ compat: { thinkingFormat: 'openrouter' } });
    expect(detectThinkingFormat(model)).toBe('openrouter');
    expect(buildThinkingBody(model, 'high')).toEqual({ reasoning: { effort: 'high' } });
  });

  it('returns an empty body when the model cannot reason', () => {
    expect(buildThinkingBody(mkModel({ reasoning: false }), 'high')).toEqual({});
  });

  it('returns an empty body for level off', () => {
    expect(buildThinkingBody(mkModel(), 'off')).toEqual({});
  });

  it('uses the model thinkingLevelMap to override the sent effort', () => {
    const model = mkModel({ thinkingLevelMap: { high: 'max' } });
    expect(buildThinkingBody(model, 'high')).toEqual({ reasoning_effort: 'max' });
  });

  it('clamps an unsupported level to the nearest supported one', () => {
    const model = mkModel({
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high' },
    });
    // 'medium' is unsupported; clamp walks up to 'high'.
    expect(buildThinkingBody(model, 'medium')).toEqual({ reasoning_effort: 'high' });
  });
});

describe('detectThinkingFormat', () => {
  it('auto-detects by provider/baseUrl', () => {
    expect(detectThinkingFormat(mkModel())).toBe('openai');
    expect(
      detectThinkingFormat(mkModel({ provider: 'xai', baseUrl: 'https://openrouter.ai/api/v1' })),
    ).toBe('openrouter');
    expect(detectThinkingFormat(mkModel({ provider: 'groq' }))).toBe('openai');
  });
});
