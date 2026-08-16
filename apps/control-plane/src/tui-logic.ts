/**
 * Pure, terminal-agnostic logic for the guppy TUI.
 *
 * Everything here is side-effect free and has no dependency on a live
 * terminal, so it is unit-testable without a TTY. The pi-tui rendering layer
 * (`tui.ts`) consumes these helpers; the line-based REPL stays independent.
 * Only pi-tui *types* are imported here, so nothing in this module touches
 * raw-mode stdin/stdout.
 */

import chalk from 'chalk';
import type { SelectItem, SelectListTheme } from '@earendil-works/pi-tui';

/** Compact token counts: 131072 -> "131k", 1048576 -> "1.0M". */
export function compactTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

/** Minimal catalog shape the picker needs; structurally compatible with `@guppy/models`. */
export interface ModelLite {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

/** Map catalog models into the `SelectList` items the `/models` picker renders. */
export function buildModelItems(models: readonly ModelLite[]): SelectItem[] {
  return models.map((m) => ({
    value: m.id,
    label: `${m.provider}/${m.id}`,
    description: `ctx ${compactTokens(m.contextWindow)} · max ${compactTokens(m.maxTokens)}${m.reasoning ? ' · reasoning' : ''}`,
  }));
}

/** Chalk-backed theme for the model picker overlay. */
export function selectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (t) => chalk.cyan.bold(t),
    selectedText: (t) => chalk.cyan(t),
    description: (t) => chalk.gray(t),
    scrollInfo: (t) => chalk.dim(t),
    noMatch: (t) => chalk.yellow(t),
  };
}

/** The state rendered into the TUI's status line. */
export interface StatusState {
  model: string;
  provider?: string;
  thinkingLevel?: string;
  verificationLevel: number;
  busy: boolean;
}

/** One-line status summary shown above the input prompt. */
export function renderStatusLine(state: StatusState): string {
  const model = state.provider ? `${state.provider}/${state.model}` : state.model;
  const parts: string[] = [`model ${model}`, `verify ${state.verificationLevel}`];
  if (state.thinkingLevel) parts.push(`thinking ${state.thinkingLevel}`);
  parts.push(state.busy ? '… working' : 'ready');
  return chalk.dim(`[Guppy] ${parts.join(' · ')}`);
}

/**
 * A bounded transcript of already-rendered lines. Appends drop the oldest
 * lines once `maxLines` is exceeded, so a long session can't exhaust memory.
 */
export class Transcript {
  private buffer: string[] = [];

  constructor(private readonly maxLines = 10_000) {}

  append(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.maxLines) {
      this.buffer.splice(0, this.buffer.length - this.maxLines);
    }
  }

  appendLines(lines: readonly string[]): void {
    for (const line of lines) this.append(line);
  }

  clear(): void {
    this.buffer = [];
  }

  get lines(): readonly string[] {
    return this.buffer;
  }

  get length(): number {
    return this.buffer.length;
  }
}
