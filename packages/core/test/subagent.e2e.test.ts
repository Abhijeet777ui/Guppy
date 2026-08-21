/**
 * Hermetic E2E for the recursive subagent tool — no network, no pi, no prime.
 *
 * A scripted mock LLM drives BOTH the parent loop and the spawned child loop
 * (children hit the same model endpoint, so the mock's request counter
 * sequences parent → child → grandchild naturally). Proves the four promises:
 *
 * - the child gets its OWN event-store trace (child taskId + sessionId, fully
 *   queryable, never polluting the parent's session),
 * - the child gets its OWN budget (turn-capped, independent of the parent),
 * - the child's work passes its OWN verification gate before fold-back, and a
 *   red gate is returned to the parent as an error it must handle,
 * - recursion is bounded: a runtime at depth 0 carries no subagent tool.
 * - TIMEOUT CONTRACT: spawning child processes makes these slow under
 *   `pnpm -r run test` parallel load; the package's test script sets
 *   `--testTimeout=15000`. If they regress, raise the script timeout; don't
 *   weaken the tests.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Context, type Event, type Task, type ULID } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { createCoreRuntime } from '../src/index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir after a child exits; harmless.
    }
  }
});

function toolChoice(id: string, name: string, args: unknown, usage: { input: number; output: number }) {
  return {
    model: 'fake/nemotron',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
  };
}

function text(content: string, usage: { input: number; output: number }) {
  return {
    model: 'fake/nemotron',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
  };
}

function startMock(responses: unknown[]): {
  server: Server;
  url: string;
  requests: Array<{ body: Record<string, unknown> }>;
} {
  const requests: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw || '{}') });
      const body = responses[Math.min(i, responses.length - 1)] ?? { choices: [] };
      i++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  return { server, url: '', requests };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeTask(): Task {
  return {
    id: ulid(),
    description: 'Fix the clamp bug in src/math.ts so the suite passes.',
    repoPath: '',
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

function makeContext(taskId: ULID): Context {
  return {
    taskId,
    sessionId: ulid(),
    files: [],
    testResults: [],
    errors: [],
    memories: [],
    skills: [],
    tokensUsed: 0,
    maxTokens: 0,
    selectedAt: now(),
    selectionReasoning: '',
  };
}

/** Dep-free fixture: npm test runs node --test, no install, no network. */
function writeFixture(dir: string, opts: { testPasses: boolean }): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'subagent-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }),
    'utf8',
  );
  writeFileSync(join(dir, 'src', 'math.js'), 'export function clamp(v) { return v; }\n', 'utf8');
  writeFileSync(
    join(dir, 'test', 'unit.test.js'),
    opts.testPasses
      ? "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/math.js';\ntest('clamp keeps values in range', () => {\n  assert.equal(clamp(5, 0, 10), 5);\n  assert.equal(clamp(99, 0, 10), 10);\n});\n"
      : "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture is deliberately broken', () => {\n  assert.equal(1, 2);\n});\n",
    'utf8',
  );
}

const FIXED_MATH = 'export function clamp(v, min, max) {\n  return Math.min(Math.max(v, min), max);\n}\n';

function findEvent(events: Event[], type: string): Event | undefined {
  return events.find((e) => e.type === type);
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body['tools'];
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      const fn = (t as { function?: { name?: string } }).function;
      return fn?.name ?? '';
    })
    .filter(Boolean);
}

describe('recursive subagent tool (hermetic)', () => {
  it('spawns a child with its own trace, gates its work, and folds the fix back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-subagent-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir, { testPasses: true });

    // Request order: parent(turn1) → child(turn1) → child(turn2) → parent(turn2).
    const responses = [
      toolChoice('p1', 'subagent', { task: 'Fix src/math.ts so clamp keeps values in range.' }, { input: 15, output: 5 }),
      toolChoice('c1', 'write_file', { path: 'src/math.js', content: FIXED_MATH }, { input: 10, output: 5 }),
      text('Done — fixed clamp and verified the suite.', { input: 8, output: 4 }),
      text('The subagent fixed it. Everything is green.', { input: 5, output: 3 }),
    ];
    const mock = startMock(responses);
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        subagent: {},
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const traj = result.value;
      expect(traj.outcome).toBe('success');

      // The parent trace carries the fork + merge (via the runtime's emit).
      const forked = findEvent(traj.events, 'AgentForked');
      const merged = findEvent(traj.events, 'AgentMerged');
      expect(forked).toBeDefined();
      expect(merged).toBeDefined();
      const forkPayload = forked!.payload as { childSessionId: ULID; childTaskId: ULID };
      const mergePayload = merged!.payload as {
        childSessionId: ULID;
        mergeResult: string;
        gate: { passed: boolean; level: number };
        filesChanged: Array<{ path: string }>;
      };
      expect(mergePayload.mergeResult).toBe('clean');
      expect(mergePayload.gate.passed).toBe(true);
      expect(mergePayload.gate.level).toBe(3);
      expect(mergePayload.filesChanged.map((f) => f.path)).toContain('src/math.js');

      // The child's OWN trace: a fully queryable trajectory under its own
      // task+session, containing its edits and its gate's test events.
      const childTraj = await eventStore.getTrajectory(forkPayload.childTaskId, forkPayload.childSessionId);
      expect(childTraj).not.toBeNull();
      const childChanged = childTraj!.events.find((e) => e.type === 'FileChanged');
      expect((childChanged!.payload as { path: string }).path).toBe('src/math.js');
      expect(childTraj!.events.some((e) => e.type === 'TestPassed')).toBe(true);
      expect(childTraj!.events.some((e) => e.type === 'TrajectoryCompleted')).toBe(true);
      // The child was single-level: its trace has no fork of its own.
      expect(childTraj!.events.some((e) => e.type === 'AgentForked')).toBe(false);

      // Session isolation: the child's edits do NOT leak into the parent trace.
      expect(traj.events.some((e) => e.type === 'FileChanged' && (e.payload as { path: string }).path === 'src/math.js')).toBe(false);

      // Fold-back is physical AND in the tool result: the workspace holds the
      // fix, and the parent saw the gate verdict.
      expect(readFileSync(join(workspace.worktreePath!, 'src', 'math.js'), 'utf8')).toBe(FIXED_MATH);
      const toolReturned = traj.events.find(
        (e) => e.type === 'ToolReturned' && (e.payload as { tool: string }).tool === 'subagent',
      );
      expect(String((toolReturned!.payload as { result: unknown }).result)).toContain('Gate: PASSED');
      expect(toolReturned!.payload).not.toHaveProperty('error');
    } finally {
      await close(mock.server);
    }
  });

  it('returns an error when the child gate stays red — the parent must handle it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-subagent-red-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    // The fixture test FAILS regardless of the child's (unrelated) edit.
    writeFixture(fixtureDir, { testPasses: false });

    const responses = [
      toolChoice('p1', 'subagent', { task: 'Improve src/math.ts.' }, { input: 15, output: 5 }),
      toolChoice('c1', 'write_file', { path: 'src/math.js', content: FIXED_MATH }, { input: 10, output: 5 }),
      text('Done.', { input: 8, output: 4 }),
      text('The subagent finished but its gate failed; I will fix the test failure.', { input: 5, output: 3 }),
    ];
    const mock = startMock(responses);
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        subagent: {},
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const traj = result.value;
      expect(traj.outcome).toBe('success');

      const merged = findEvent(traj.events, 'AgentMerged');
      const mergePayload = merged!.payload as { mergeResult: string; gate: { passed: boolean; errors: string[] } };
      expect(mergePayload.mergeResult).toBe('failed');
      expect(mergePayload.gate.passed).toBe(false);
      expect(mergePayload.gate.errors.length).toBeGreaterThan(0);

      // The red gate is surfaced to the parent as a tool ERROR — the parent's
      // loop feeds it back as "ERROR: ..." so it must react, not ignore.
      const toolReturned = traj.events.find(
        (e) => e.type === 'ToolReturned' && (e.payload as { tool: string }).tool === 'subagent',
      );
      expect(String((toolReturned!.payload as { error?: string }).error ?? '')).toContain('subagent gate FAILED');
    } finally {
      await close(mock.server);
    }
  });

  it('recurses: a child can spawn a grandchild, bounded by maxDepth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-subagent-rec-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir, { testPasses: true });

    // Request order: parent → child → grandchild → grandchild → child → parent.
    const responses = [
      toolChoice('p1', 'subagent', { task: 'Delegate the fix.' }, { input: 15, output: 5 }),
      toolChoice('c1', 'subagent', { task: 'Do the actual edit.' }, { input: 12, output: 5 }),
      toolChoice('g1', 'write_file', { path: 'src/math.js', content: FIXED_MATH }, { input: 10, output: 5 }),
      text('Fixed the file.', { input: 8, output: 4 }),
      text('Grandchild completed; folding back.', { input: 8, output: 4 }),
      text('Done.', { input: 5, output: 3 }),
    ];
    const mock = startMock(responses);
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      // maxDepth 2: parent may spawn children, children may spawn one more
      // level; the grandchild is at the floor and carries NO subagent tool.
      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        subagent: { maxDepth: 2 },
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const traj = result.value;
      expect(traj.outcome).toBe('success');

      // Depth cap proven by the actual tool lists sent to the model: the
      // child (request 1) offers subagent, the grandchild (request 2) does not.
      expect(toolNames(mock.requests[1]!.body)).toContain('subagent');
      expect(toolNames(mock.requests[2]!.body)).not.toContain('subagent');

      // The tree: parent → child → grandchild, each with its own trace.
      const fork = findEvent(traj.events, 'AgentForked')!;
      const childIds = fork.payload as { childTaskId: ULID; childSessionId: ULID };
      const childTraj = await eventStore.getTrajectory(childIds.childTaskId, childIds.childSessionId);
      expect(childTraj).not.toBeNull();
      const childFork = findEvent(childTraj!.events, 'AgentForked')!;
      const grandchildIds = childFork.payload as { childTaskId: ULID; childSessionId: ULID };
      const grandchildTraj = await eventStore.getTrajectory(grandchildIds.childTaskId, grandchildIds.childSessionId);
      expect(grandchildTraj).not.toBeNull();
      // The grandchild is at the recursion floor: no fork, but its edit and
      // gate live in its own trace, and the edit physically landed.
      expect(grandchildTraj!.events.some((e) => e.type === 'AgentForked')).toBe(false);
      expect(grandchildTraj!.events.some((e) => e.type === 'FileChanged')).toBe(true);
      expect(grandchildTraj!.events.some((e) => e.type === 'TestPassed')).toBe(true);
      expect(readFileSync(join(workspace.worktreePath!, 'src', 'math.js'), 'utf8')).toBe(FIXED_MATH);

      // Each level merged cleanly back up the chain.
      expect((findEvent(childTraj!.events, 'AgentMerged')!.payload as { mergeResult: string }).mergeResult).toBe('clean');
      expect((findEvent(traj.events, 'AgentMerged')!.payload as { mergeResult: string }).mergeResult).toBe('clean');
    } finally {
      await close(mock.server);
    }
  });

  it('does not expose the subagent tool when subagents are disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-subagent-off-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir, { testPasses: true });

    const responses = [text('No subagents needed here.', { input: 5, output: 3 })];
    const mock = startMock(responses);
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      // No `subagent` config — exactly what the bench runner builds.
      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));
      expect(result.ok).toBe(true);
      expect(toolNames(mock.requests[0]!.body)).not.toContain('subagent');
    } finally {
      await close(mock.server);
    }
  });
});
