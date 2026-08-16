/**
 * Unit tests for the pure, terminal-agnostic TUI logic (no TTY required).
 */

import { describe, expect, it } from 'vitest';
import {
  Transcript,
  buildModelItems,
  compactTokens,
  renderStatusLine,
  selectListTheme,
} from '../src/tui-logic.js';

describe('compactTokens', () => {
  it('formats thousands, millions, and small counts', () => {
    expect(compactTokens(0)).toBe('0');
    expect(compactTokens(999)).toBe('999');
    expect(compactTokens(131072)).toBe('131k');
    expect(compactTokens(1048576)).toBe('1.0M');
  });
});

describe('buildModelItems', () => {
  it('maps catalog models to picker items with token metadata', () => {
    const items = buildModelItems([
      { provider: 'groq', id: 'qwen/qwen3.6-27b', contextWindow: 131072, maxTokens: 8192, reasoning: true },
      { provider: 'openrouter', id: 'claude-3-5-sonnet', contextWindow: 200000, maxTokens: 8192, reasoning: false },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ value: 'qwen/qwen3.6-27b', label: 'groq/qwen/qwen3.6-27b' });
    expect(items[0].description).toContain('ctx 131k');
    expect(items[0].description).toContain('reasoning');
    expect(items[1].description).not.toContain('reasoning');
  });

  it('handles an empty catalog', () => {
    expect(buildModelItems([])).toEqual([]);
  });
});

describe('selectListTheme', () => {
  it('returns a string for every theme function', () => {
    const theme = selectListTheme();
    for (const fn of Object.values(theme)) {
      expect(typeof fn('x')).toBe('string');
    }
  });
});

describe('renderStatusLine', () => {
  it('renders model, provider, verification, and ready state', () => {
    const line = renderStatusLine({ model: 'qwen3.6-27b', provider: 'groq', verificationLevel: 3, busy: false });
    expect(line).toContain('groq/qwen3.6-27b');
    expect(line).toContain('verify 3');
    expect(line).toContain('ready');
  });

  it('shows thinking and working state when set', () => {
    const line = renderStatusLine({ model: 'm', verificationLevel: 5, thinkingLevel: 'high', busy: true });
    expect(line).toContain('thinking high');
    expect(line).toContain('working');
  });
});

describe('Transcript', () => {
  it('appends and returns lines in order', () => {
    const t = new Transcript();
    t.append('a');
    t.appendLines(['b', 'c']);
    expect(t.lines).toEqual(['a', 'b', 'c']);
    expect(t.length).toBe(3);
  });

  it('drops the oldest lines beyond maxLines', () => {
    const t = new Transcript(3);
    t.appendLines(['1', '2', '3', '4', '5']);
    expect(t.lines).toEqual(['3', '4', '5']);
    expect(t.length).toBe(3);
  });

  it('clears', () => {
    const t = new Transcript();
    t.append('a');
    t.clear();
    expect(t.length).toBe(0);
  });
});
