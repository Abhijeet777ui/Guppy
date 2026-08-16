/**
 * Hermetic E2E for PrimeDaemonRuntime — no LLM, no network.
 *
 * Drives the real spawn → stdout framing → PrimeTranscriptParser → event-store
 * pipeline against a scripted fake `prime-agent` binary that emits the
 * documented `--mode json` event stream (see
 * prime-agent/packages/coding-agent/docs/json.md). This is the only path the
 * live `guppy run --model nvidia/nemotron-…` exercises that previously had no
 * test coverage.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Event, type Task, type Workspace } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createPrimeDaemonRuntime } from '../src/index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir after the child exits; leaving a
      // scratch dir in the OS temp folder is harmless.
    }
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-prime-e2e-'));
  tmpDirs.push(dir);
  return dir;
}

/** A fake `prime-agent` emitting the documented JSONL stream, then exiting. */
function writeFakePrimeAgent(dir: string, stream: string, exitCode = 0): string {
  const binary = join(dir, 'fake-prime-agent.js'); // `.js` → launched via `node`
  // process.exitCode (not process.exit) lets Node drain piped stdout first,
  // matching how a real CLI exits without truncating its event stream.
  const script = `// Scripted prime-agent --mode json stand-in (hermetic test fixture).\n${stream}\nprocess.exitCode = ${exitCode};\n`;
  writeFileSync(binary, script, 'utf8');
  return binary;
}

function makeWorkspace(repoPath: string): Workspace {
  return { id: ulid(), repoPath, createdAt: now() };
}

function makeTask(repoPath: string): Task {
  return {
    id: ulid(),
    description: 'fix the failing test',
    repoPath,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

const HAPPY_STREAM = `
console.log(JSON.stringify({ type: 'session', version: 3, id: 'fake-session', timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: 'agent_start' }));
console.log(JSON.stringify({ type: 'turn_start' }));
console.log(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: { id: 'fake-model' }, usage: { input: 100, output: 50 } } }));
console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'write', args: { path: 'src/math-utils.ts' } }));
console.log(JSON.stringify({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'write', result: 'wrote src/math-utils.ts', isError: false }));
console.log(JSON.stringify({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] }));
console.log(JSON.stringify({ type: 'agent_end', messages: [] }));
`;

describe('PrimeDaemonRuntime (hermetic)', () => {
  it('parses the scripted json stream into events and metrics', async () => {
    const dir = tmpDir();
    const binary = writeFakePrimeAgent(dir, HAPPY_STREAM, 0);

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const runtime = createPrimeDaemonRuntime({ eventStore, binary });

    const workspace = makeWorkspace(dir);
    await runtime.initialize(workspace);

    const task = makeTask(dir);
    const context = {
      taskId: task.id,
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

    const result = await runtime.run(task, context);
    await runtime.shutdown();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const traj = result.value;
    expect(traj.outcome).toBe('success');
    expect(traj.metrics.toolCalls).toBe(1);
    expect(traj.metrics.tokensTotal).toBe(150);
    expect(traj.metrics.tokensByModel['fake-model']).toBe(150);

    const types = traj.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['TaskStarted', 'ModelCalled', 'ToolCalled', 'ToolReturned', 'FileChanged', 'TrajectoryCompleted']));

    const fileChanged = traj.events.find((e) => e.type === 'FileChanged')!;
    expect(fileChanged.payload.path).toBe('src/math-utils.ts');

    // The store received every event too (flush before reading back).
    await eventStore.close();
    const reader = createEventStore({ rootDir: join(dir, 'events') });
    const persisted = await reader.getTrajectory(task.id, context.sessionId);
    expect(persisted?.events.length).toBe(traj.events.length);
    await reader.close();
  });

  it('surfaces a non-zero exit as a partial trajectory, not a crash', async () => {
    const dir = tmpDir();
    const binary = writeFakePrimeAgent(dir, HAPPY_STREAM, 1);

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const runtime = createPrimeDaemonRuntime({ eventStore, binary });
    const workspace = makeWorkspace(dir);
    await runtime.initialize(workspace);

    const result = await runtime.run(makeTask(dir), {
      taskId: ulid(),
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
    });
    await runtime.shutdown();
    await eventStore.close();

    // exit 1 is still an ok() result so callers can inspect captured events.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe('partial');
  });

  it('returns an error when the binary cannot be launched', async () => {
    const dir = tmpDir();
    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    // A non-.js binary is spawned directly (not via `node`), so a missing
    // path fails at spawn time rather than node exiting 1.
    const runtime = createPrimeDaemonRuntime({
      eventStore,
      binary: join(dir, 'no-such-prime-agent'),
    });
    const workspace = makeWorkspace(dir);
    await runtime.initialize(workspace);

    const task = makeTask(dir);
    const result = await runtime.run(task, {
      taskId: task.id,
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
    });
    await runtime.shutdown();
    await eventStore.close();

    expect(result.ok).toBe(false);
  });
});
