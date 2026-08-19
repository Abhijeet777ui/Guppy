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
import {
  createMemoryStore,
  defaultMemoryDir,
  extractFixes,
  type MemoryStore,
} from '../src/index.js';

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

  it('attributes a file change to all open failures but dilutes confidence', () => {
    const fixes = extractFixes([
      testEvent('TestFailed', 'a', 1),
      testEvent('TestFailed', 'b', 2),
      fileChanged('src/common.ts', 3),
      testEvent('TestPassed', 'a', 4),
      testEvent('TestPassed', 'b', 5),
    ]);
    expect(fixes).toHaveLength(2);
    // Both fixes keep the change (a shared helper can fix several failures),
    // but the attribution is ambiguous — two failures were open when the
    // change happened — so confidence is below the isolated case.
    expect(fixes.every((f) => f.changedFiles.includes('src/common.ts'))).toBe(true);
    expect(fixes.every((f) => f.confidence < 1)).toBe(true);
  });

  it('scores an isolated single-file fix at full confidence', () => {
    const fixes = extractFixes([
      testEvent('TestFailed', 'sum', 1),
      fileChanged('src/sum.ts', 2),
      testEvent('TestPassed', 'sum', 3),
    ]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.confidence).toBe(1);
  });

  it('dilutes confidence when many files change across concurrent failures', () => {
    const fixes = extractFixes([
      testEvent('TestFailed', 'a', 1),
      testEvent('TestFailed', 'b', 2),
      fileChanged('src/one.ts', 3),
      fileChanged('src/two.ts', 4),
      fileChanged('src/three.ts', 5),
      fileChanged('src/four.ts', 6),
      testEvent('TestPassed', 'a', 7),
      testEvent('TestPassed', 'b', 8),
    ]);
    expect(fixes).toHaveLength(2);
    // 4+ files (-0.15) + not isolated (-0.25): 0.5 - 0.15 = 0.35.
    expect(fixes[0]!.confidence).toBe(0.35);
    expect(fixes[1]!.confidence).toBe(0.35);
  });
});

// ---------------------------------------------------------------------------
// Layered cross-repo memory (secondary global store)
// ---------------------------------------------------------------------------

describe('layered cross-repo memory', () => {
  function layered(repoDir: string, globalDir: string): MemoryStore {
    return createMemoryStore({
      rootDir: repoDir,
      secondaryRootDir: globalDir,
      defaultLimit: 10,
      recencyHalfLifeDays: 30,
    });
  }

  it('mirrors fix memories into the global store with the same id', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'memory-repo-a-'));
    const global = mkdtempSync(join(tmpdir(), 'memory-global-'));
    try {
      const storeA = layered(repoA, global);
      storeA.record({ type: 'fix', summary: 'Fix clamp', detail: {}, tags: ['fix'], relevance: 1 });

      const globalStore = createMemoryStore({ rootDir: global, defaultLimit: 10, recencyHalfLifeDays: 30 });
      expect(globalStore.count()).toBe(1);
      const inLocal = storeA.retrieve({ tags: ['fix'] });
      const inGlobal = globalStore.retrieve({ tags: ['fix'] });
      expect(inLocal[0]!.memory.id).toBe(inGlobal[0]!.memory.id);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(global, { recursive: true, force: true });
    }
  });

  it('retrieves a fix distilled in repo A from repo B with an empty local store', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'memory-repo-a-'));
    const repoB = mkdtempSync(join(tmpdir(), 'memory-repo-b-'));
    const global = mkdtempSync(join(tmpdir(), 'memory-global-'));
    try {
      const storeA = layered(repoA, global);
      storeA.ingestTrajectory(
        makeTrajectory(ulid(), ulid(), [
          testEvent('TestFailed', 'clamp', 1_000),
          fileChanged('src/clamp.ts', 2_000),
          testEvent('TestPassed', 'clamp', 3_000),
          completed('success', 4_000),
        ]),
      );

      // Repo B shares the global store; its own local store is empty.
      const storeB = layered(repoB, global);
      expect(createMemoryStore({ rootDir: repoB }).count()).toBe(0);
      const results = storeB.retrieveForFailure('clamp', 3);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.memory.summary).toContain('clamp');
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
      rmSync(global, { recursive: true, force: true });
    }
  });

  it('does not mirror low-confidence fixes into the global store', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'memory-repo-a-'));
    const global = mkdtempSync(join(tmpdir(), 'memory-global-'));
    try {
      const storeA = layered(repoA, global);
      // Two concurrent failures and four changed files → confidence 0.35.
      storeA.ingestTrajectory(
        makeTrajectory(ulid(), ulid(), [
          testEvent('TestFailed', 'a', 1_000),
          testEvent('TestFailed', 'b', 2_000),
          fileChanged('src/one.ts', 3_000),
          fileChanged('src/two.ts', 4_000),
          fileChanged('src/three.ts', 5_000),
          fileChanged('src/four.ts', 6_000),
          testEvent('TestPassed', 'a', 7_000),
          testEvent('TestPassed', 'b', 8_000),
        ]),
      );
      const globalStore = createMemoryStore({ rootDir: global, defaultLimit: 10, recencyHalfLifeDays: 30 });
      // Both fixes stay repo-local: weak attributions must not follow the
      // user across repos.
      expect(globalStore.count()).toBe(0);
      expect(storeA.retrieve({ type: 'fix' })).toHaveLength(2);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(global, { recursive: true, force: true });
    }
  });

  it('keeps trajectory summaries local — only fixes reach the global store', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'memory-repo-a-'));
    const global = mkdtempSync(join(tmpdir(), 'memory-global-'));
    try {
      const storeA = layered(repoA, global);
      storeA.ingestTrajectory(
        makeTrajectory(ulid(), ulid(), [
          testEvent('TestFailed', 'sum', 1_000),
          fileChanged('src/sum.ts', 2_000),
          testEvent('TestPassed', 'sum', 3_000),
          completed('success', 4_000),
        ]),
      );
      const globalStore = createMemoryStore({ rootDir: global, defaultLimit: 10, recencyHalfLifeDays: 30 });
      // 1 fix, no trajectory summary.
      expect(globalStore.count()).toBe(1);
      expect(globalStore.retrieve({ type: 'trajectory' })).toHaveLength(0);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(global, { recursive: true, force: true });
    }
  });

  it('dedupes by id when both layers hold the same fix, and count spans both', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'memory-repo-a-'));
    const global = mkdtempSync(join(tmpdir(), 'memory-global-'));
    try {
      const storeA = layered(repoA, global);
      storeA.record({ type: 'fix', summary: 'Fix clamp', detail: {}, tags: ['fix'], relevance: 1 });
      // One fix lives in both layers: retrieval sees one, count sees one.
      expect(storeA.retrieve({ tags: ['fix'] })).toHaveLength(1);
      expect(storeA.count()).toBe(1);

      storeA.record({ type: 'trajectory', summary: 'run', detail: {}, tags: ['trajectory'], relevance: 1 });
      expect(storeA.count()).toBe(2);

      storeA.clear();
      expect(storeA.count()).toBe(0);
      expect(createMemoryStore({ rootDir: global }).count()).toBe(0);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(global, { recursive: true, force: true });
    }
  });

  it('defaultMemoryDir honors GUPPY_MEMORY_DIR and falls back to ~/.guppy/memory', () => {
    const prev = process.env['GUPPY_MEMORY_DIR'];
    try {
      process.env['GUPPY_MEMORY_DIR'] = '/tmp/custom-memory';
      expect(defaultMemoryDir()).toBe('/tmp/custom-memory');
    } finally {
      if (prev === undefined) delete process.env['GUPPY_MEMORY_DIR'];
      else process.env['GUPPY_MEMORY_DIR'] = prev;
    }
  });
});
