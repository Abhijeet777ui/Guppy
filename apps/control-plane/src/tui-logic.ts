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
import type { Event } from '@guppy/contracts';
import type { MarkdownTheme, SelectItem, SelectListTheme } from '@earendil-works/pi-tui';

/** UI color scheme: auto-detected from the terminal, or forced via /theme. */
export type ThemeMode = 'dark' | 'light';

/**
 * The §3 semantic color roles for a scheme. `chalk` styles are chosen for
 * contrast on the background they run on (cyan pops on dark, blue on light).
 */
export function palette(mode: ThemeMode) {
  const accent = (t: string): string => (mode === 'light' ? chalk.blue(t) : chalk.cyan(t));
  return {
    accent,
    ok: (t: string): string => chalk.green(t),
    warn: (t: string): string => chalk.yellow(t),
    err: (t: string): string => chalk.red(t),
    dim: (t: string): string => chalk.gray(t),
    bold: (t: string): string => chalk.bold(t),
  };
}

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

/** Strip ANSI escape sequences (colors, cursor moves) for test assertions. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b[()][0-9A-B]/g, '');
}

/** One-line truncation for activity labels. */
export function truncate(text: string, max = 80): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** Map a live event to a humanized activity label, or null to skip (UX-SPEC §6). */
export function humanizeAction(event: Event): string | null {
  switch (event.type) {
    case 'ModelCalled':
    case 'ModelStreamed':
      return 'Thinking…';
    case 'ToolCalled': {
      const p = event.payload as { tool?: string; args?: unknown };
      return toolActionLabel(p.tool, p.args);
    }
    case 'TestStarted':
    case 'TestPassed':
    case 'TestFailed':
      return 'Running tests…';
    case 'TypecheckPassed':
    case 'TypecheckFailed':
      return 'Typechecking…';
    case 'LintPassed':
    case 'LintFailed':
      return 'Linting…';
    case 'VerificationEscalated':
      return 'Escalating verification…';
    default:
      return null;
  }
}

function toolActionLabel(tool: string | undefined, args: unknown): string {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  switch (tool) {
    case 'search':
      return `Searching "${truncate(String(a['query'] ?? ''), 60)}"`;
    case 'read_file':
      return `Reading ${a['path'] ?? ''}`;
    case 'write_file':
      return `Writing ${a['path'] ?? ''}`;
    case 'apply_patch':
      return 'Applying patch';
    case 'list_files':
      return 'Listing files';
    case 'run_command': {
      const cmd = a['command'];
      const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
      return `Running ${truncate(cmdStr, 60)}`;
    }
    case 'git_status':
      return 'Checking git status';
    case 'git_diff':
      return 'Reviewing changes';
    default:
      return tool ? `Using ${tool}…` : 'Working…';
  }
}

/** State for the persistent top context bar. */
export interface ContextBarState {
  repo: string;
  model: string;
  provider?: string;
  verificationLevel: number;
  thinkingLevel?: string;
  /** The plan/build mode indicator (UX-SPEC S6). Build is the default. */
  mode?: 'plan' | 'build';
  /** Cumulative ContextOps tokens saved (omit when unavailable). */
  savedTotal?: number;
}

/** One-line persistent identity: repo · model · verify · saved (UX-SPEC §4). */
export function renderContextBar(state: ContextBarState, mode: ThemeMode = 'dark'): string {
  const { accent } = palette(mode);
  const model = state.provider ? `${state.provider}/${state.model}` : state.model;
  const parts = [state.repo, accent(model), `verify ${state.verificationLevel}`];
  if (state.mode) parts.push(state.mode);
  if (state.thinkingLevel) parts.push(`think ${state.thinkingLevel}`);
  if (state.savedTotal !== undefined) parts.push(`saved ≈${compactTokens(state.savedTotal)}`);
  return chalk.dim(`[Guppy] ${parts.join(' · ')}`);
}

/** State for the per-turn telemetry footer. */
export interface TurnFooterState {
  outcome?: string;
  durationMs: number;
  tokens?: number;
  toolCalls?: number;
  passes?: number;
  failures?: number;
  /** ContextOps tokens saved this turn (omit when unavailable). */
  tokensSaved?: number;
}

/** Dim one-line footer: ✓/✗/✕/~ · duration · tokens · tests · saved (UX-SPEC §8). */
export function renderTurnFooter(state: TurnFooterState): string {
  const mark =
    state.outcome === 'success'
      ? chalk.green('✓')
      : state.outcome === 'failure'
        ? chalk.red('✗')
        : state.outcome === 'cancelled'
          ? chalk.yellow('✕')
          : chalk.yellow('~');
  let line =
    `${mark} ${state.durationMs}ms · ${compactTokens(state.tokens ?? 0)} tokens · ` +
    `${state.toolCalls ?? 0} tool calls · ${state.passes ?? 0}/${state.failures ?? 0} tests`;
  if (state.tokensSaved !== undefined) {
    line += ` · saved ≈${compactTokens(state.tokensSaved)}`;
  }
  return chalk.dim(line);
}

/** Build the pi-tui MarkdownTheme from the §3 palette (money never shown). */
export function markdownTheme(mode: ThemeMode = 'dark'): MarkdownTheme {
  const { accent } = palette(mode);
  return {
    heading: (t) => chalk.bold(t),
    link: (t) => chalk.underline(accent(t)),
    linkUrl: (t) => chalk.gray(t),
    code: (t) => chalk.inverse(t),
    codeBlock: (t) => t,
    codeBlockBorder: (t) => chalk.dim(t),
    quote: (t) => t,
    quoteBorder: (t) => chalk.dim(t),
    hr: (t) => chalk.dim(t),
    listBullet: (t) => t,
    bold: (t) => chalk.bold(t),
    italic: (t) => chalk.italic(t),
    strikethrough: (t) => chalk.strikethrough(t),
    underline: (t) => chalk.underline(t),
  };
}

/** Chalk-backed theme for the model picker overlay. */
export function selectListTheme(mode: ThemeMode = 'dark'): SelectListTheme {
  const { accent } = palette(mode);
  return {
    selectedPrefix: (t) => chalk.bold(accent(t)),
    selectedText: (t) => accent(t),
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
