import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ulid,
  now,
  type Event,
  type Trajectory,
  type Timestamp,
  type ULID,
  type TrajectoryMetrics,
} from '@guppy/contracts';
import { createMemoryStore, extractFixes, type MemoryStore } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
  const store = createMemoryStore({ rootDir: dir, defaultLimit: 10, recencyHalfLifeDays: 30 });
  return { store, dir };
}

function testEvent(type: 'TestFailed' | 'TestPassed', name: string, timestamp: number): Event {
  return {
    id: ulid(),
    timestamp: timestamp as Timestamp,
    type,
    taskId: ulid(),
    sessionId: ulid(),
    payload: {
      id: ulid(),
      name,
      status: type === 'TestPassed' ? 'passed' : 'failed',
      duration: 1,
      output: type === 'TestFailed' ? 'boom' : undefined,
    },
  } as Event;
}

function fileChanged(path: string, timestamp: number): Event {
  return {
    id: ulid(),
    timestamp: timestamp as Timestamp,
    type: 'FileChanged',
    taskId: ulid(),
    sessionId: ulid(),
    payload: { path, operation: 'modify' },
  } as Event;
}

function typecheckFailed(file: string, timestamp: number): Event {
  return {
    id: ulid(),
    timestamp: timestamp as Timestamp,
    type: 'TypecheckFailed',
    taskId: ulid(),
    sessionId: ulid(),
    payload: { errors: [{ file, message: 'type error', line: 1 }], duration: 1 },
  } as Event;
}

function typecheckPassed(timestamp: number): Event {
  return {
    id: ulid(),
    timestamp: timestamp as Timestamp,
    type: 'TypecheckPassed',
    taskId: ulid(),
    sessionId: ulid(),
    payload: { errors: [], duration: 1 },
  } as Event;
}

function completed(outcome: Trajectory['outcome'], timestamp: number): Event {
  return {
    id: ulid(),
    timestamp: timestamp as Timestamp,
    type: 'TrajectoryCompleted',
    taskId: ulid(),
    sessionId: ulid(),
    payload: { outcome, metrics: emptyMetrics() },
  } as Event;
}

function emptyMetrics(): TrajectoryMetrics {
  return {
    passes: 0,
    failures: 0,
    tokensTotal: 0,
    tokensByModel: {},
    wallTimeMs: 0,
    toolCalls: 0,
    checkpoints: 0,
    contextSelections: 0,
    verificationEscalations: 0,
  };
}

function makeTrajectory(taskId: ULID, sessionId: ULID, events: Event[], outcome: Trajectory['outcome'] = 'success'): Trajectory {
  return {
    id: ulid(),
    taskId,
    sessionId,
    events,
    outcome,
    metrics: emptyMetrics(),
    startedAt: now(),
    completedAt: now(),
  };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

describe('MemoryStore write path', () => {
  it('records memories, counts them, and clears', () => {
    const { store, dir } = makeStore();
    try {
      const r = store.record({ type: 'fix', summary: 'Fix for sum', detail: {}, tags: ['fix'], relevance: 1 });
      expect(r.ok).toBe(true);
      expect(r.value.id).toBeTruthy();
      expect(r.value.createdAt).toBeTruthy();

      store.record({ type: 'trajectory', summary: 'Task done', detail: {}, tags: ['trajectory'], relevance: 1 });
      expect(store.count()).toBe(2);

      store.clear();
      expect(store.count()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists across store instances on the same rootDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    const first = createMemoryStore({ rootDir: dir, defaultLimit: 10, recencyHalfLifeDays: 30 });
    first.record({ type: 'fix', summary: 'Fix clamp', detail: {}, tags: ['fix'], relevance: 1 });

    const second = createMemoryStore({ rootDir: dir, defaultLimit: 10, recencyHalfLifeDays: 30 });
    try {
      expect(second.count()).toBe(1);
      const results = second.retrieve({ tags: ['fix'] });
      expect(results).toHaveLength(1);
      expect(results[0]!.memory.summary).toBe('Fix clamp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips corrupt lines when loading instead of failing the whole store', () => {
    const { store, dir } = makeStore();
    try {
      store.record({ type: 'fix', summary: 'good', detail: {}, tags: ['fix'], relevance: 1 });
      appendFileSync(join(dir, 'memories.jsonl'), '{not-json}\n');

      const reopened = createMemoryStore({ rootDir: dir, defaultLimit: 10, recencyHalfLifeDays: 30 });
      expect(reopened.count()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

describe('MemoryStore retrieve', () => {
  it('returns only memories matching the tag query, ordered by relevance', () => {
    const { store, dir } = makeStore();
    try {
      store.record({ type: 'fix', summary: 'Fix clamp', detail: {}, tags: ['fix', 'clamp'], relevance: 1 });
      store.record({ type: 'fix', summary: 'Fix sum', detail: {}, tags: ['fix', 'sum'], relevance: 0.5 });

      const byClamp = store.retrieve({ tags: ['clamp'] });
      expect(byClamp).toHaveLength(1);
      expect(byClamp[0]!.memory.summary).toBe('Fix clamp');

      const byFix = store.retrieve({ tags: ['fix'] });
      expect(byFix).toHaveLength(2);
      expect(byFix[0]!.memory.summary).toBe('Fix clamp');
      expect(byFix[0]!.score).toBeGreaterThan(byFix[1]!.score);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters by type, taskId, and limit', () => {
    const { store, dir } = makeStore();
    try {
      const t1 = ulid();
      store.record({ type: 'fix', summary: 'fix a', detail: {}, tags: ['fix'], relevance: 1, taskId: t1 });
      store.record({ type: 'trajectory', summary: 'traj a', detail: {}, tags: ['trajectory'], relevance: 1, taskId: t1 });
      store.record({ type: 'fix', summary: 'fix b', detail: {}, tags: ['fix'], relevance: 1 });

      expect(store.retrieve({ type: 'fix' })).toHaveLength(2);
      expect(store.retrieve({ type: 'trajectory' })).toHaveLength(1);
      expect(store.retrieve({ type: 'fix', taskId: t1 })).toHaveLength(1);
      expect(store.retrieve({ limit: 1 })).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decays scores by recency (older memories rank lower)', () => {
    const { store, dir } = makeStore();
    try {
      const day = 24 * 60 * 60 * 1000;
      const old = (Date.now() - 60 * day) as Timestamp; // ~2 half-lives at 30d
      const fresh = now();
      store.record({ type: 'fix', summary: 'old fix', detail: {}, tags: ['fix'], relevance: 1, createdAt: old });
      store.record({ type: 'fix', summary: 'fresh fix', detail: {}, tags: ['fix'], relevance: 1, createdAt: fresh });

      const results = store.retrieve({ tags: ['fix'] });
      expect(results).toHaveLength(2);
      expect(results[0]!.memory.summary).toBe('fresh fix');
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retrieves fix memories for a failure name', () => {
    const { store, dir } = makeStore();
    try {
      store.record({
        type: 'fix',
        summary: 'Fix for "clamp": changed src/clamp.ts',
        detail: {},
        tags: ['fix', 'clamp.ts'],
        relevance: 1,
      });
      store.record({ type: 'fix', summary: 'Fix for "sum": changed src/sum.ts', detail: {}, tags: ['fix', 'sum.ts'], relevance: 1 });

      const results = store.retrieveForFailure('bugfix-clamp', 3);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.memory.summary).toContain('clamp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Trajectory ingestion
// ---------------------------------------------------------------------------

describe('MemoryStore ingestTrajectory', () => {
  it('distills a trajectory into a summary memory plus one fix memory per resolved failure', () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      const trajectory = makeTrajectory(taskId, sessionId, [
        testEvent('TestFailed', 'sum', 1_000),
        fileChanged('src/sum.ts', 2_000),
        testEvent('TestPassed', 'sum', 3_000),
        completed('success', 4_000),
      ]);

      const r = store.ingestTrajectory(trajectory);
      expect(r.ok).toBe(true);
      expect(r.value).toHaveLength(2);

      const types = r.value.map((m) => m.type).sort();
      expect(types).toEqual(['fix', 'trajectory']);

      const fix = r.value.find((m) => m.type === 'fix')!;
      expect(fix.summary).toContain('sum');
      expect((fix.detail as { changedFiles: string[] }).changedFiles).toEqual(['src/sum.ts']);

      const summary = r.value.find((m) => m.type === 'trajectory')!;
      expect(summary.tags).toContain('success');

      expect(store.count()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractFixes (pure distillation logic)
// ---------------------------------------------------------------------------

describe('extractFixes', () => {
  it('extracts a fix from failure → file change → pass', () => {
    const fixes = extractFixes([
      testEvent('TestFailed', 'sum', 1),
      fileChanged('src/sum.ts', 2),
      testEvent('TestPassed', 'sum', 3),
    ]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.failureKind).toBe('test');
    expect(fixes[0]!.failureName).toBe('sum');
    expect(fixes[0]!.changedFiles).toEqual(['src/sum.ts']);
  });

  it('does not distill a fix when no file changed between failure and pass', () => {
    const fixes = extractFixes([testEvent('TestFailed', 'sum', 1), testEvent('TestPassed', 'sum', 2)]);
    expect(fixes).toHaveLength(0);
  });

  it('does not distill a failure that never resolved', () => {
    const fixes = extractFixes([testEvent('TestFailed', 'sum', 1), fileChanged('src/sum.ts', 2)]);
    expect(fixes).toHaveLength(0);
  });

  it('extracts typecheck fixes keyed by error file', () => {
    const fixes = extractFixes([
      typecheckFailed('src/a.ts', 1),
      fileChanged('src/a.ts', 2),
      typecheckPassed(3),
    ]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.failureKind).toBe('typecheck');
    expect(fixes[0]!.failureName).toBe('src/a.ts');
    expect(fixes[0]!.changedFiles).toEqual(['src/a.ts']);
  });

  it('attributes a file change to all open failures (documented imprecision)', () => {
    const fixes = extractFixes([
      testEvent('TestFailed', 'a', 1),
      testEvent('TestFailed', 'b', 2),
      fileChanged('src/common.ts', 3),
      testEvent('TestPassed', 'a', 4),
      testEvent('TestPassed', 'b', 5),
    ]);
    expect(fixes).toHaveLength(2);
    expect(fixes.every((f) => f.changedFiles.includes('src/common.ts'))).toBe(true);
  });
});
