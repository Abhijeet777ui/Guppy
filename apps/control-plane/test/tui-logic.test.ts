/**
 * Unit tests for the pure, terminal-agnostic TUI logic (no TTY required).
 */

import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { now, ulid, type Event } from '@guppy/contracts';
import {
  Transcript,
  buildModelItems,
  compactTokens,
  humanizeAction,
  markdownTheme,
  palette,
  renderContextBar,
  renderStatusLine,
  renderTurnFooter,
  selectListTheme,
  stripAnsi,
} from '../src/tui-logic.js';

function ev(type: Event['type'], payload: unknown): Event {
  return {
    id: ulid(),
    timestamp: now(),
    type: type as Event['type'],
    taskId: ulid(),
    sessionId: ulid(),
    payload,
  };
}

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

describe('humanizeAction', () => {
  it('humanizes tool calls into one calm action', () => {
    expect(humanizeAction(ev('ToolCalled', { tool: 'search', args: { query: 'clamp', modelCallId: ulid() } }))).toBe('Searching "clamp"');
    expect(humanizeAction(ev('ToolCalled', { tool: 'run_command', args: { command: ['npm', 'test'], modelCallId: ulid() } }))).toBe('Running npm test');
    expect(humanizeAction(ev('ToolCalled', { tool: 'read_file', args: { path: 'src/a.ts', modelCallId: ulid() } }))).toBe('Reading src/a.ts');
    expect(humanizeAction(ev('ToolCalled', { tool: 'apply_patch', args: {} }))).toBe('Applying patch');
  });

  it('labels thinking and gate states', () => {
    expect(humanizeAction(ev('ModelCalled', { model: 'm', promptTokens: 1, completionTokens: 1, callId: ulid() }))).toBe('Thinking…');
    expect(humanizeAction(ev('TestStarted', { name: 'x', status: 'passed', duration: 0 }))).toBe('Running tests…');
    expect(humanizeAction(ev('TypecheckFailed', { errors: [], duration: 1 }))).toBe('Typechecking…');
    expect(humanizeAction(ev('VerificationEscalated', { fromLevel: 1, toLevel: 3, reason: 'x' }))).toBe('Escalating verification…');
  });

  it('skips events that need no activity', () => {
    expect(humanizeAction(ev('TaskStarted', { task: {} }))).toBeNull();
    expect(humanizeAction(ev('FileChanged', { path: 'a', operation: 'modify' }))).toBeNull();
  });
});

describe('renderContextBar', () => {
  it('renders repo · model · verify, and saved tokens when provided', () => {
    const line = renderContextBar({
      repo: 'my-project',
      model: 'qwen3.6-27b',
      provider: 'groq',
      verificationLevel: 3,
      savedTotal: 12_400,
    });
    expect(line).toContain('my-project');
    expect(line).toContain('groq/qwen3.6-27b');
    expect(line).toContain('verify 3');
    expect(line).toContain('saved ≈12k');
    // Money never appears.
    expect(line).not.toMatch(/\$/);
  });

  it('omits saved tokens when unavailable', () => {
    const line = renderContextBar({ repo: 'r', model: 'm', verificationLevel: 5 });
    expect(line).not.toContain('saved');
  });

  it('shows the plan/build mode indicator when set (UX-SPEC S6)', () => {
    const build = renderContextBar({ repo: 'r', model: 'm', verificationLevel: 3, mode: 'build' });
    expect(stripAnsi(build)).toContain('· build');
    const plan = renderContextBar({ repo: 'r', model: 'm', verificationLevel: 3, mode: 'plan' });
    expect(stripAnsi(plan)).toContain('· plan');
    // The default (no mode) stays mode-free so existing callers are unchanged.
    expect(stripAnsi(renderContextBar({ repo: 'r', model: 'm', verificationLevel: 3 }))).not.toContain('· build');
  });
});

describe('palette (theme modes)', () => {
  it('dark and light accents differ (cyan vs blue)', () => {
    const prevLevel = chalk.level;
    chalk.level = 1; // vitest runs without a TTY; force ANSI so styles render
    try {
      const dark = palette('dark');
      const light = palette('light');
      expect(dark.accent('x')).not.toBe(light.accent('x'));
      expect(dark.accent('x')).toContain('\u001b[36m'); // cyan
      expect(light.accent('x')).toContain('\u001b[34m'); // blue
    } finally {
      chalk.level = prevLevel;
    }
  });

  it('semantic roles wrap in color and strip back to plain text', () => {
    const p = palette('dark');
    expect(stripAnsi(p.ok('ok'))).toBe('ok');
    expect(stripAnsi(p.warn('w'))).toBe('w');
    expect(stripAnsi(p.err('e'))).toBe('e');
    expect(stripAnsi(p.dim('d'))).toBe('d');
  });

  it('renderContextBar honors a light mode without changing content', () => {
    const line = renderContextBar({ repo: 'r', model: 'm', verificationLevel: 3, savedTotal: 500 }, 'light');
    expect(stripAnsi(line)).toContain('r · m · verify 3 · saved ≈500');
    expect(stripAnsi(line)).not.toMatch(/\$/);
  });
});

describe('renderTurnFooter', () => {
  it('marks success/failure and reports tests', () => {
    const ok = renderTurnFooter({ outcome: 'success', durationMs: 1200, tokens: 5200, toolCalls: 3, passes: 2, failures: 0 });
    expect(ok).toContain('✓');
    expect(ok).toContain('5k tokens');
    expect(ok).toContain('2/0 tests');
    expect(renderTurnFooter({ outcome: 'failure', durationMs: 1 })).toContain('✗');
  });

  it('reports the ContextOps savings estimate and never money', () => {
    const line = renderTurnFooter({ outcome: 'success', durationMs: 100, tokensSaved: 1200 });
    expect(line).toContain('saved ≈1k');
    expect(line).not.toMatch(/\$/);
  });
});

describe('markdownTheme + stripAnsi', () => {
  it('returns a string for every theme function', () => {
    const theme = markdownTheme();
    for (const fn of Object.values(theme)) {
      expect(typeof fn('x')).toBe('string');
    }
  });

  it('supports a light mode and is deterministic per mode', () => {
    const light = markdownTheme('light');
    for (const fn of Object.values(light)) {
      expect(typeof fn('x')).toBe('string');
    }
    expect(markdownTheme('light').bold('x')).toBe(markdownTheme('light').bold('x'));
  });

  it('selectListTheme also accepts a mode', () => {
    for (const fn of Object.values(selectListTheme('light'))) {
      expect(typeof fn('x')).toBe('string');
    }
  });

  it('strips colors and cursor sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
    expect(stripAnsi('a\u001b[1;5Ha')).toBe('aa');
    expect(stripAnsi('plain')).toBe('plain');
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
