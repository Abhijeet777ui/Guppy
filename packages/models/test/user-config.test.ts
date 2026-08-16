import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfigPath,
  loadUserConfig,
  maskKey,
  resolveRuntimeOptions,
  saveUserConfig,
  type UserConfig,
} from '../src/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guppy-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CONFIG: UserConfig = {
  providers: {
    groq: { apiKey: 'gsk_groq' },
    openrouter: { apiKey: 'sk_openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  },
  default: { provider: 'groq', model: 'qwen/qwen3.6-27b' },
};

describe('user config file', () => {
  it('loads empty when the file is missing', () => {
    expect(loadUserConfig(join(dir, 'config.json'))).toEqual({ providers: {} });
  });

  it('round-trips save/load and stamps a version', () => {
    const path = join(dir, 'config.json');
    saveUserConfig(CONFIG, path);
    expect(existsSync(path)).toBe(true);

    const loaded = loadUserConfig(path);
    expect(loaded.providers.groq?.apiKey).toBe('gsk_groq');
    expect(loaded.providers.openrouter?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(loaded.default).toEqual({ provider: 'groq', model: 'qwen/qwen3.6-27b' });
    expect((JSON.parse(readFileSync(path, 'utf8')) as { version?: number }).version).toBe(1);
  });

  it('degrades to empty on corrupt JSON', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ not json', 'utf8');
    expect(loadUserConfig(path)).toEqual({ providers: {} });
  });

  it('masks keys without leaking them', () => {
    expect(maskKey(undefined)).toBe('(unset)');
    expect(maskKey('short')).toBe('••••••••');
    expect(maskKey('gsk_abcdefghijklmnop')).toBe('gsk_…mnop');
  });

  it('honors the GUPPY_CONFIG env var for the default path', () => {
    const original = process.env.GUPPY_CONFIG;
    process.env.GUPPY_CONFIG = '/tmp/fake-guppy-config.json';
    try {
      expect(defaultConfigPath()).toBe('/tmp/fake-guppy-config.json');
    } finally {
      if (original === undefined) delete process.env.GUPPY_CONFIG;
      else process.env.GUPPY_CONFIG = original;
    }
  });
});

describe('resolveRuntimeOptions', () => {
  it('applies the config default when no flags are given', () => {
    expect(resolveRuntimeOptions({}, CONFIG)).toEqual({
      provider: 'groq',
      model: 'qwen/qwen3.6-27b',
      apiKey: 'gsk_groq',
    });
  });

  it('explicit flags win over presets', () => {
    expect(
      resolveRuntimeOptions(
        { provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'cli-key' },
        CONFIG,
      ),
    ).toEqual({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'cli-key',
    });
  });

  it('does not inherit a default model when the provider is explicit', () => {
    const resolved = resolveRuntimeOptions({ provider: 'openrouter' }, CONFIG);
    expect(resolved.provider).toBe('openrouter');
    // Fallback model (not groq's default) because --provider was explicit.
    expect(resolved.model).toBe('claude-3-5-sonnet');
    expect(resolved.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(resolved.apiKey).toBe('sk_openrouter');
  });

  it('falls back to the fallback model with no provider when nothing is configured', () => {
    expect(resolveRuntimeOptions({}, { providers: {} })).toEqual({
      model: 'claude-3-5-sonnet',
    });
  });
});
