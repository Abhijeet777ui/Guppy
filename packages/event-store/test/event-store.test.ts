import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ulid,
  now,
  type Event,
  type Timestamp,
  type ULID,
  type Context,
  type Task,
} from '@guppy/contracts';
import { createEventStore, type EventStore } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): { store: EventStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'event-store-test-'));
  const store = createEventStore({
    rootDir: dir,
    snapshotInterval: 100,
    maxEventsPerFile: 10_000,
    sqliteIndex: true,
  });
  return { store, dir };
}

function makeTask(taskId: ULID): Task {
  return {
    id: taskId,
    description: 'test task',
    repoPath: '/tmp',
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

function ev(type: Event['type'], payload: unknown, taskId: ULID, sessionId: ULID, timestamp?: number): Event {
  return {
    id: ulid(),
    timestamp: (timestamp ?? Date.now()) as Timestamp,
    type,
    taskId,
    sessionId,
    payload,
  } as Event;
}

function minimalContext(taskId: ULID, sessionId: ULID): Context {
  return {
    taskId,
    sessionId,
    files: [],
    testResults: [],
    errors: [],
    memories: [],
    skills: [],
    tokensUsed: 0,
    maxTokens: 0,
    selectedAt: now(),
    selectionReasoning: 'test',
  };
}

async function collect(
  store: EventStore,
  taskId: ULID,
  sessionId: ULID,
  options?: { fromIndex?: number; filter?: (e: Event) => boolean },
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of store.readEvents({ taskId, sessionId, index: 0 }, options)) {
    events.push(e);
  }
  return events;
}

/** Whether the SQLite query index is available in this runtime (Node >= 22.5). */
const hasSqlite = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Append + replay
// ---------------------------------------------------------------------------

describe('EventStore append + replay', () => {
  it('appends events, enriches them, and replays them in order', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      const events: Event[] = [
        ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId, 1_000),
        ev('ModelCalled', { model: 'm', promptTokens: 10, completionTokens: 5, callId: ulid() }, taskId, sessionId, 2_000),
        ev('ToolCalled', { tool: 'read_file', args: {}, modelCallId: ulid() }, taskId, sessionId, 3_000),
      ];

      for (const e of events) {
        const r = store.append(e);
        expect(r.ok).toBe(true);
      }

      const replayed = await collect(store, taskId, sessionId);
      expect(replayed).toHaveLength(3);
      expect(replayed.map((e) => e.type)).toEqual(['TaskStarted', 'ModelCalled', 'ToolCalled']);
      // id/timestamp are enriched on append
      expect(replayed[0]!.id).toBeTruthy();
      expect(replayed[0]!.timestamp).toBe(1_000);
      expect(replayed[2]!.timestamp).toBe(3_000);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports fromIndex and a filter during replay', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId));
      store.append(ev('ModelCalled', { model: 'm', promptTokens: 1, completionTokens: 1, callId: ulid() }, taskId, sessionId));
      store.append(ev('ToolCalled', { tool: 'ls', args: {}, modelCallId: ulid() }, taskId, sessionId));

      const fromOne = await collect(store, taskId, sessionId, { fromIndex: 1 });
      expect(fromOne.map((e) => e.type)).toEqual(['ModelCalled', 'ToolCalled']);

      const onlyTools = await collect(store, taskId, sessionId, { filter: (e) => e.type === 'ToolCalled' });
      expect(onlyTools.map((e) => e.type)).toEqual(['ToolCalled']);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists events across close/reopen (durable before append returns)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-store-test-'));
    const taskId = ulid();
    const sessionId = ulid();

    const first = createEventStore({ rootDir: dir, sqliteIndex: true });
    first.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId));
    first.append(ev('ToolCalled', { tool: 'apply_patch', args: {}, modelCallId: ulid() }, taskId, sessionId));
    await first.close();

    const second = createEventStore({ rootDir: dir, sqliteIndex: true });
    try {
      const replayed = await collect(second, taskId, sessionId);
      expect(replayed).toHaveLength(2);
      expect(replayed[0]!.type).toBe('TaskStarted');
      expect(replayed[1]!.type).toBe('ToolCalled');
    } finally {
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('EventStore session lifecycle', () => {
  it('auto-begins a session from the event identity and finalizes the prior one', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const s1 = ulid();
      const s2 = ulid();
      store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, s1));
      store.append(ev('ToolCalled', { tool: 'read_file', args: {}, modelCallId: ulid() }, taskId, s1));
      // Switching sessions without a TrajectoryCompleted finalizes s1 as 'unknown'
      store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, s2));

      // Both sessions replay independently
      expect(await collect(store, taskId, s1)).toHaveLength(2);
      expect(await collect(store, taskId, s2)).toHaveLength(1);

      if (hasSqlite) {
        const summaries = store.listSessionSummaries(taskId);
        expect(summaries).toHaveLength(2);
        const first = summaries.find((s) => s.sessionId === s1);
        expect(first!.outcome).toBe('unknown');
        expect(first!.endedAt).not.toBeNull();
        expect(first!.eventCount).toBe(2);
        const second = summaries.find((s) => s.sessionId === s2);
        expect(second!.outcome).toBeNull();
        expect(second!.endedAt).toBeNull();
      }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalizes a session with its real outcome on TrajectoryCompleted', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId));
      store.append(
        ev(
          'TrajectoryCompleted',
          {
            outcome: 'success',
            metrics: {
              passes: 1,
              failures: 0,
              tokensTotal: 10,
              tokensByModel: {},
              wallTimeMs: 1,
              toolCalls: 0,
              checkpoints: 0,
              contextSelections: 0,
              verificationEscalations: 0,
            },
          },
          taskId,
          sessionId,
        ),
      );

      if (hasSqlite) {
        const summaries = store.listSessionSummaries(taskId);
        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.outcome).toBe('success');
        expect(summaries[0]!.endedAt).not.toBeNull();
      }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes trajectory metrics from the event stream', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      const base = 1_000_000;
      store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId, base));
      store.append(ev('ModelCalled', { model: 'a', promptTokens: 100, completionTokens: 50, callId: ulid() }, taskId, sessionId, base + 10));
      store.append(ev('ToolCalled', { tool: 'apply_patch', args: {}, modelCallId: ulid() }, taskId, sessionId, base + 20));
      store.append(ev('TestPassed', { id: ulid(), name: 'sum', status: 'passed', duration: 1 }, taskId, sessionId, base + 30));
      store.append(ev('TestFailed', { id: ulid(), name: 'avg', status: 'failed', duration: 1 }, taskId, sessionId, base + 40));
      store.append(ev('CheckpointCreated', { checkpointId: ulid(), snapshotId: 's', reason: 'manual' }, taskId, sessionId, base + 50));

      const trajectory = await store.getTrajectory(taskId, sessionId);
      expect(trajectory).not.toBeNull();
      expect(trajectory!.outcome).toBe('running');
      expect(trajectory!.metrics.tokensTotal).toBe(150);
      expect(trajectory!.metrics.tokensByModel['a']).toBe(150);
      expect(trajectory!.metrics.toolCalls).toBe(1);
      expect(trajectory!.metrics.passes).toBe(1);
      expect(trajectory!.metrics.failures).toBe(1);
      expect(trajectory!.metrics.checkpoints).toBe(1);
      expect(trajectory!.metrics.wallTimeMs).toBe(50);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live subscription
// ---------------------------------------------------------------------------

describe('EventStore subscribe', () => {
  it('notifies subscribers synchronously after persist and unsubscribes', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      const seen: string[] = [];
      const unsubscribe = store.subscribe((e) => seen.push(e.type));

      const r = store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId));
      expect(r.ok).toBe(true);
      expect(seen).toEqual(['TaskStarted']);

      unsubscribe();
      store.append(ev('ToolCalled', { tool: 'ls', args: {}, modelCallId: ulid() }, taskId, sessionId));
      expect(seen).toEqual(['TaskStarted']);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isolates a throwing listener so it can never break a run', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      const seen: string[] = [];
      store.subscribe(() => {
        throw new Error('listener boom');
      });
      store.subscribe((e) => seen.push(e.type));

      const r = store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId));
      expect(r.ok).toBe(true);
      expect(seen).toEqual(['TaskStarted']);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe('EventStore checkpoints', () => {
  it('creates a snapshot, appends a CheckpointCreated event, and lists checkpoints', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId));

      const result = await store.createSnapshot(ulid(), 1, minimalContext(taskId, sessionId), 'manual');
      expect(result.ok).toBe(true);

      const checkpoints = store.listCheckpoints(taskId, sessionId);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]!.reason).toBe('manual');
      expect(store.getLatestCheckpoint(taskId, sessionId)!.id).toBe(checkpoints[0]!.id);

      const types = (await collect(store, taskId, sessionId)).map((e) => e.type);
      expect(types).toContain('CheckpointCreated');
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Index-backed queries + deletion
// ---------------------------------------------------------------------------

describe.skipIf(!hasSqlite)('EventStore SQLite index', () => {
  it('lists tasks and tallies event-type counts', async () => {
    const { store, dir } = makeStore();
    try {
      const taskId = ulid();
      const sessionId = ulid();
      store.append(ev('TaskStarted', { task: makeTask(taskId) }, taskId, sessionId));
      store.append(ev('ToolCalled', { tool: 'a', args: {}, modelCallId: ulid() }, taskId, sessionId));
      store.append(ev('ToolCalled', { tool: 'b', args: {}, modelCallId: ulid() }, taskId, sessionId));

      expect(store.listTasks()).toEqual([taskId]);
      const counts = store.eventTypeCounts(taskId, sessionId);
      expect(counts['ToolCalled']).toBe(2);
      expect(counts['TaskStarted']).toBe(1);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes a task from both the log and the index', async () => {
    const { store, dir } = makeStore();
    try {
      const t1 = ulid();
      const t2 = ulid();
      const s1 = ulid();
      store.append(ev('TaskStarted', { task: makeTask(t1) }, t1, s1));
      store.append(ev('TaskStarted', { task: makeTask(t2) }, t2, ulid()));

      expect(store.listTasks().sort()).toEqual([t1, t2].sort());

      await store.deleteTask(t1);

      expect(store.listTasks()).toEqual([t2]);
      expect(await collect(store, t1, s1)).toHaveLength(0);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
