/**
 * Sleep-cycle v1 unit tests — deterministic clustering + report rendering.
 * No event store required: SessionRecords are synthesized directly.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, now, type Event, type Trajectory, type ULID } from '@guppy/contracts';
import { createMemoryStore } from '@guppy/memory';
import { clusterSessions } from '../src/cluster.js';
import { renderReport, matchCandidateFixes } from '../src/report.js';
import type { SessionRecord } from '../src/replay.js';

function ev(partial: Pick<Event, 'type' | 'payload'> & { id?: ULID }): Event {
  return {
    id: partial.id ?? ulid(),
    timestamp: now(),
    taskId: ulid(),
    sessionId: ulid(),
    ...partial,
  } as Event;
}

function makeRecord(taskId: ULID, sessionId: ULID, events: Event[]): SessionRecord {
  const trajectory: Trajectory = {
    id: ulid(),
    taskId,
    sessionId,
    events,
    outcome: 'success',
    metrics: {
      passes: 0,
      failures: 0,
      tokensTotal: 0,
      tokensByModel: {},
      wallTimeMs: 0,
      toolCalls: 0,
      checkpoints: 0,
      contextSelections: 0,
      verificationEscalations: 0,
    },
    startedAt: now(),
    completedAt: now(),
  };
  return { taskId, sessionId, trajectory };
}

const failure = (name: string, output = 'assertion failed') =>
  ev({ type: 'TestFailed', payload: { id: ulid(), name, status: 'failed', duration: 1, output } });
const pass = (name: string) =>
  ev({ type: 'TestPassed', payload: { id: ulid(), name, status: 'passed', duration: 1 } });
const fileChanged = (path: string) =>
  ev({ type: 'FileChanged', payload: { path, operation: 'modify' } });

describe('clusterSessions', () => {
  it('groups the same failure across sessions and ranks by recurrence', () => {
    const taskId = ulid();
    const records = [
      makeRecord(taskId, ulid(), [failure('clamp bounds'), fileChanged('src/math-utils.ts'), pass('clamp bounds')]),
      makeRecord(taskId, ulid(), [failure('clamp bounds'), fileChanged('src/math-utils.ts'), pass('clamp bounds')]),
      makeRecord(taskId, ulid(), [failure('slugify spaces')]),
    ];

    const clusters = clusterSessions(records);
    expect(clusters).toHaveLength(2);

    const top = clusters[0]!;
    expect(top.name).toBe('clamp bounds');
    expect(top.occurrences).toBe(2);
    expect(top.sessionIds).toHaveLength(2);
    expect(top.everResolved).toBe(true);
    expect(top.filesChanged['src/math-utils.ts']).toBe(2);

    const second = clusters[1]!;
    expect(second.name).toBe('slugify spaces');
    expect(second.everResolved).toBe(false);
  });

  it('normalizes varying durations so identical logical failures merge', () => {
    const taskId = ulid();
    const records = [
      makeRecord(taskId, ulid(), [failure('sum totals (12.5ms)')]),
      makeRecord(taskId, ulid(), [failure('sum totals (3ms)')]),
    ];
    const clusters = clusterSessions(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.occurrences).toBe(2);
  });

  it('attributes files across sessions when the fix lands in a later session', () => {
    const taskId = ulid();
    // Failure + change happen in one session, the passing re-run in the next.
    const records = [
      makeRecord(taskId, ulid(), [failure('clamp bounds'), fileChanged('src/math-utils.ts')]),
      makeRecord(taskId, ulid(), [fileChanged('src/math-utils.ts'), pass('clamp bounds')]),
    ];
    const clusters = clusterSessions(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.everResolved).toBe(true);
    expect(clusters[0]!.filesChanged['src/math-utils.ts']).toBe(1);
  });

  it('clusters typecheck failures by file', () => {
    const taskId = ulid();
    const records = [
      makeRecord(taskId, ulid(), [
        ev({
          type: 'TypecheckFailed',
          payload: { errors: [{ file: 'src/x.ts', message: 'TS2322', line: 3 }], duration: 5 },
        }),
      ]),
    ];
    const clusters = clusterSessions(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.kind).toBe('typecheck');
    expect(clusters[0]!.name).toBe('src/x.ts');
  });
});

describe('renderReport + matchCandidateFixes', () => {
  it('renders clusters, memory fixes, and the session table section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'guppy-sleepcycle-'));
    try {
      const memory = createMemoryStore({ rootDir: tmp });
      memory.record({
        type: 'fix',
        summary: 'Fix for "clamp bounds": changed src/math-utils.ts',
        detail: {},
        tags: ['fix', 'test', 'math-utils.ts'],
        relevance: 1,
      });

      const taskId = ulid();
      const records = [
        makeRecord(taskId, ulid(), [failure('clamp bounds'), fileChanged('src/math-utils.ts'), pass('clamp bounds')]),
      ];
      const clusters = clusterSessions(records);
      const candidateFixes = matchCandidateFixes(clusters, memory);

      const md = renderReport({
        generatedAt: now(),
        sessionCount: records.length,
        clusters,
        candidateFixes,
        sessions: [],
      });

      expect(md).toContain('# Guppy Sleep Cycle Report');
      expect(md).toContain('clamp bounds');
      expect(md).toContain('Fix for "clamp bounds"');
      expect(md).toContain('## Session outcomes');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports no-fix state gracefully on an empty memory store', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'guppy-sleepcycle-'));
    try {
      const memory = createMemoryStore({ rootDir: tmp });
      const taskId = ulid();
      const clusters = clusterSessions([makeRecord(taskId, ulid(), [failure('orphan')])]);
      const candidateFixes = matchCandidateFixes(clusters, memory);
      const md = renderReport({
        generatedAt: now(),
        sessionCount: 1,
        clusters,
        candidateFixes,
        sessions: [],
      });
      expect(md).toContain('No matching fix memories yet');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
