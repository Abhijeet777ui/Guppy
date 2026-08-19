/**
 * Live streaming — render the event store to the terminal as it happens.
 *
 * `guppy run` used to be write-only: tool calls, model turns, and gate
 * results landed in the event log but never surfaced until the final summary.
 * This module subscribes to the store (the single funnel every runtime and
 * the verification engine write to) and prints one compact line per event,
 * turning a run into a watchable, demoable process.
 *
 * Rendering is best-effort: a malformed payload or a throwing listener never
 * breaks the run — the event log is the source of truth, this is just a view.
 */

import type { Event } from '@guppy/contracts';
import type { EventStore } from '@guppy/event-store';
import chalk from 'chalk';

const MAX_CHARS = 120;

function truncate(text: string, max = MAX_CHARS): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function argsPreview(args: unknown): string {
  if (typeof args === 'string') return truncate(args);
  try {
    return truncate(JSON.stringify(args));
  } catch {
    return '';
  }
}

function resultPreview(result: unknown): string {
  if (typeof result === 'string') return truncate(result);
  try {
    return truncate(JSON.stringify(result));
  } catch {
    return '';
  }
}

/** Render one event as a single terminal line. Returns null to skip. */
export function renderLiveEvent(event: Event): string | null {
  switch (event.type) {
    case 'TaskStarted': {
      const p = event.payload as { task?: { description?: string } };
      return chalk.cyan.bold(`[task] ${truncate(p.task?.description ?? '', 140)}`);
    }
    case 'ContextSelected': {
      const p = event.payload as { tokens?: number; included?: string[] };
      return chalk.gray(`[ctx] ${p.tokens ?? 0} tokens, ${p.included?.length ?? 0} files`);
    }
    case 'ModelCalled': {
      const p = event.payload as { model?: string; promptTokens?: number; completionTokens?: number };
      return chalk.blue(`[model] ${p.model ?? 'unknown'} (+${p.promptTokens ?? 0}/${p.completionTokens ?? 0} tok)`);
    }
    case 'ModelStreamed': {
      const p = event.payload as { text?: string };
      return chalk.blue(`[model] ${truncate(p.text ?? '', 140)}`);
    }
    case 'FinalAnswer': {
      const p = event.payload as { text?: string };
      return chalk.cyan(`[answer] ${truncate(p.text ?? '', 140)}`);
    }
    case 'ToolCalled': {
      const p = event.payload as { tool?: string; args?: unknown };
      const args = argsPreview(p.args);
      return chalk.yellow(`[tool] ${p.tool ?? '?'}${args ? ` ${args}` : ''}`);
    }
    case 'ToolReturned': {
      const p = event.payload as { tool?: string; result?: unknown; error?: string; duration?: number };
      if (p.error) return chalk.red(`[err] ${p.tool ?? '?'}: ${truncate(p.error)}`);
      const dur = p.duration !== undefined ? ` (${p.duration}ms)` : '';
      return chalk.gray(`[ok] ${p.tool ?? '?'}${dur} ${resultPreview(p.result)}`);
    }
    case 'FileChanged': {
      const p = event.payload as { path?: string; operation?: string };
      return chalk.magenta(`[file] ${p.operation ?? 'modify'} ${p.path ?? ''}`);
    }
    case 'TestStarted': {
      const p = event.payload as { name?: string };
      return chalk.gray(`[test] ${p.name ?? ''}`);
    }
    case 'TestPassed': {
      const p = event.payload as { name?: string };
      return chalk.green(`[pass] ${p.name ?? ''}`);
    }
    case 'TestFailed': {
      const p = event.payload as { name?: string };
      return chalk.red(`[fail] ${p.name ?? ''}`);
    }
    case 'TypecheckPassed':
      return chalk.green('[pass] typecheck');
    case 'TypecheckFailed': {
      const p = event.payload as { errors?: unknown[] };
      return chalk.red(`[fail] typecheck (${p.errors?.length ?? 0} errors)`);
    }
    case 'LintPassed':
      return chalk.green('[pass] lint');
    case 'LintFailed': {
      const p = event.payload as { errors?: unknown[] };
      return chalk.red(`[fail] lint (${p.errors?.length ?? 0} errors)`);
    }
    case 'VerificationEscalated': {
      const p = event.payload as { fromLevel?: number; toLevel?: number; reason?: string };
      return chalk.yellow(`[gate] escalated level ${p.fromLevel ?? '?'} -> ${p.toLevel ?? '?'}: ${truncate(p.reason ?? '')}`);
    }
    case 'CheckpointCreated': {
      const p = event.payload as { reason?: string };
      return chalk.gray(`[ckpt] ${p.reason ?? ''}`);
    }
    case 'AgentForked':
    case 'AgentMerged':
      return chalk.gray(`[agent] ${event.type.replace('Agent', '').toLowerCase()}`);
    case 'TrajectoryCompleted': {
      const p = event.payload as { outcome?: string };
      return chalk.bold(`[done] ${p.outcome ?? ''}`);
    }
    default: {
      // Defensive fallback for event types added after this renderer.
      const t = (event as { type: string }).type;
      return chalk.gray(`[evt] ${t}`);
    }
  }
}

/**
 * Subscribe to the store and print each event as it is appended. Returns an
 * unsubscribe function (call it once the run finishes so the final summary
 * prints cleanly).
 */
export function attachLiveStream(eventStore: EventStore): () => void {
  return eventStore.subscribe((event) => {
    try {
      const line = renderLiveEvent(event);
      if (line) console.log(line);
    } catch {
      // Never let a rendering error break the run.
    }
  });
}
