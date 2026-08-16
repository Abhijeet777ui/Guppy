/**
 * Live streaming — the renderer must produce one compact line per event type
 * and the store subscription must fire on append and stop after unsubscribe.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Event, type EventType } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { attachLiveStream, renderLiveEvent } from '../src/live-stream.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

function ev(type: EventType, payload: unknown): Event {
  return {
    id: ulid(),
    timestamp: now(),
    type: type as Event['type'],
    taskId: ulid(),
    sessionId: ulid(),
    payload,
  };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('renderLiveEvent', () => {
  it('renders the headline event types as tagged lines', () => {
    expect(stripAnsi(renderLiveEvent(ev('TaskStarted', { task: { description: 'Fix clamp' } }))!)).toContain(
      '[task] Fix clamp',
    );
    expect(
      stripAnsi(renderLiveEvent(ev('ContextSelected', { tokens: 1234, included: ['a.ts'], excluded: [], reasoning: '' }))!),
    ).toContain('[ctx] 1234 tokens');
    expect(
      stripAnsi(
        renderLiveEvent(ev('ModelCalled', { model: 'gpt-4o', promptTokens: 10, completionTokens: 3, callId: ulid() }))!,
      ),
    ).toContain('[model] gpt-4o (+10/3 tok)');
    expect(
      stripAnsi(
        renderLiveEvent(ev('ToolCalled', { tool: 'write_file', args: { path: 'src/math.ts' }, modelCallId: ulid() }))!,
      ),
    ).toContain('[tool] write_file {"path":"src/math.ts"}');
  });

  it('renders tool returns with errors in the error form', () => {
    const okLine = stripAnsi(renderLiveEvent(ev('ToolReturned', { tool: 'run_command', result: 'PASS', duration: 12 }))!);
    expect(okLine).toContain('[ok] run_command (12ms)');
    const errLine = stripAnsi(
      renderLiveEvent(ev('ToolReturned', { tool: 'run_command', result: '', error: 'boom', duration: 1 }))!,
    );
    expect(errLine).toContain('[err] run_command: boom');
  });

  it('renders streaming model text', () => {
    expect(stripAnsi(renderLiveEvent(ev('ModelStreamed', { text: 'Applying the fix now' }))!)).toContain(
      '[model] Applying the fix now',
    );
  });

  it('renders gates, files, and completion', () => {
    expect(stripAnsi(renderLiveEvent(ev('TestPassed', { name: 'clamp works' }))!)).toContain('[pass] clamp works');
    expect(stripAnsi(renderLiveEvent(ev('TestFailed', { name: 'clamp works' }))!)).toContain('[fail] clamp works');
    expect(
      stripAnsi(renderLiveEvent(ev('TypecheckFailed', { errors: [{ file: 'a.ts', message: 'x', line: 1 }], duration: 5 }))!),
    ).toContain('[fail] typecheck (1 errors)');
    expect(stripAnsi(renderLiveEvent(ev('FileChanged', { path: 'src/math.ts', operation: 'modify' }))!)).toContain(
      '[file] modify src/math.ts',
    );
    expect(stripAnsi(renderLiveEvent(ev('TrajectoryCompleted', { outcome: 'success', metrics: {} }))!)).toContain(
      '[done] success',
    );
    expect(
      stripAnsi(renderLiveEvent(ev('VerificationEscalated', { fromLevel: 1, toLevel: 3, reason: 'unit failed' }))!),
    ).toContain('[gate] escalated level 1 -> 3');
  });
});

describe('attachLiveStream', () => {
  it('prints appended events and stops after unsubscribe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-live-stream-'));
    tmpDirs.push(dir);
    const store = createEventStore({ rootDir: join(dir, 'events'), sqliteIndex: false });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const detach = attachLiveStream(store);
      store.append(ev('ModelCalled', { model: 'gpt-4o', promptTokens: 5, completionTokens: 2, callId: ulid() }));
      store.append(ev('ToolCalled', { tool: 'read_file', args: {}, modelCallId: ulid() }));
      expect(spy).toHaveBeenCalledTimes(2);
      expect(stripAnsi(String(spy.mock.calls[0]![0]))).toContain('[model] gpt-4o');

      detach();
      store.append(ev('TestPassed', { name: 'x' }));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      await store.close();
    }
  });
});
