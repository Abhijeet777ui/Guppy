/**
 * Hermetic E2E for CoreAgentRuntime.resume() — no network, no pi, no prime.
 *
 * resume() reconstructs the exact model-visible conversation from a crashed
 * session's event log (the "model-visible ⟺ logged" invariant) and continues
 * the loop from the last complete turn. A scripted mock LLM drives the
 * resumed continuation; the crashed attempt is constructed by hand so the
 * session has no terminal TrajectoryCompleted event.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Checkpoint, type Context, type Event, type EventType, type Task, type ULID } from '@guppy/contracts';
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

interface CapturedRequest {
  body: Record<string, unknown>;
}

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

function finalAnswer(text: string) {
  return {
    model: 'fake/nemotron',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 8 },
  };
}

function startMock(responses: unknown[]): { server: Server; url: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
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
    description: 'Make src/hello.ts export the answer.',
    repoPath: '',
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

function makeContext(taskId: ULID, sessionId: ULID): Context {
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
    selectionReasoning: '',
  };
}

function ev(taskId: ULID, sessionId: ULID, type: EventType, payload: unknown): Event {
  return { id: ulid(), timestamp: now(), type, taskId, sessionId, payload } as Event;
}

const WRONG = 'export const answer = 0;\n';
const RIGHT = 'export const answer = 42;\n';

/**
 * Build a crashed session: one complete turn (write_file → result) but no
 * terminal TrajectoryCompleted, plus a full-context snapshot cursor. This is
 * exactly the residue a hard process kill mid-attempt leaves behind.
 */
async function buildCrashedSession(
  dir: string,
  task: Task,
  sessionId: ULID,
): Promise<{ checkpoint: Checkpoint; fixtureDir: string }> {
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(join(fixtureDir, 'src'), { recursive: true });

  const eventStore = createEventStore({ rootDir: join(dir, 'events') });
  eventStore.beginSession(task.id, sessionId);

  const callId = ulid();
  const writeArgs = JSON.stringify({ path: 'src/hello.ts', content: WRONG });
  eventStore.append(ev(task.id, sessionId, 'TaskStarted', { task }));
  eventStore.append(
    ev(task.id, sessionId, 'ModelCalled', { model: 'fake/nemotron', promptTokens: 10, completionTokens: 5, callId }),
  );
  eventStore.append(
    ev(task.id, sessionId, 'AssistantMessage', {
      content: null,
      toolCalls: [{ id: 'call-1', name: 'write_file', arguments: writeArgs }],
      callId,
    }),
  );
  eventStore.append(ev(task.id, sessionId, 'ToolCalled', { tool: 'write_file', args: JSON.parse(writeArgs), modelCallId: callId }));
  eventStore.append(
    ev(task.id, sessionId, 'ToolReturned', { tool: 'write_file', result: 'wrote src/hello.ts', toolCallId: 'call-1', duration: 1 }),
  );

  const context = makeContext(task.id, sessionId);
  const snapshot = await eventStore.createSnapshot(ulid(), 0, context, 'pre_tool');
  expect(snapshot.ok).toBe(true);
  await eventStore.close();

  return { checkpoint: snapshot.value as unknown as Checkpoint, fixtureDir };
}

describe('CoreAgentRuntime.resume (hermetic)', () => {
  it('reconstructs the conversation from the log and continues to a green answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-resume-'));
    tmpDirs.push(dir);

    const task = makeTask();
    const sessionId = ulid();
    const { checkpoint, fixtureDir } = await buildCrashedSession(dir, task, sessionId);

    // The resumed continuation: first the model sees the reconstructed history
    // and corrects the file, then it finishes.
    const responses = [
      toolChoice('call-2', 'write_file', { path: 'src/hello.ts', content: RIGHT }, { input: 40, output: 5 }),
      finalAnswer('Fixed.'),
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
      });
      await runtime.initialize(workspace);

      const result = await runtime.resume(checkpoint);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const traj = result.value;
      expect(traj.outcome).toBe('success');
      expect(traj.sessionId).toBe(sessionId);

      // The first resumed request carried the reconstructed history: system,
      // user, the prior assistant write_file, and its tool result.
      const messages = mock.requests[0]!.body.messages as Array<Record<string, unknown>>;
      expect(messages.length).toBeGreaterThanOrEqual(4);
      expect(messages[0]?.role).toBe('system');
      expect(messages[1]?.role).toBe('user');
      expect(messages[2]?.role).toBe('assistant');
      const toolCalls = messages[2]?.tool_calls as Array<{ id: string }>;
      expect(toolCalls?.[0]?.id).toBe('call-1');
      expect(messages[3]?.role).toBe('tool');
      expect(messages[3]?.tool_call_id).toBe('call-1');

      // The resumed continuation landed the corrected write in the worktree.
      expect(readFileSync(join(workspace.worktreePath!, 'src', 'hello.ts'), 'utf8')).toBe(RIGHT);

      // Tokens are cumulative: the crashed turn's 15 + the two resumed calls
      // (45 + 38).
      expect(traj.metrics.tokensTotal).toBe(15 + 45 + 38);
      expect(traj.metrics.toolCalls).toBe(2); // the crashed turn's write + the resume's write

      await eventStore.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      await close(mock.server);
    }
  });

  it('drops a trailing partial turn and re-asks the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-resume-partial-'));
    tmpDirs.push(dir);

    const task = makeTask();
    const sessionId = ulid();
    const fixtureDir = join(dir, 'fixture');
    mkdirSync(join(fixtureDir, 'src'), { recursive: true });

    // First turn completes fully; second turn's assistant issued two tool
    // calls but only one returned before the crash — that turn is incomplete.
    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    eventStore.beginSession(task.id, sessionId);
    const call1 = ulid();
    const call2 = ulid();
    const writeArgs = JSON.stringify({ path: 'src/hello.ts', content: WRONG });
    eventStore.append(ev(task.id, sessionId, 'TaskStarted', { task }));
    eventStore.append(ev(task.id, sessionId, 'ModelCalled', { model: 'fake/nemotron', promptTokens: 10, completionTokens: 5, callId: call1 }));
    eventStore.append(ev(task.id, sessionId, 'AssistantMessage', { content: null, toolCalls: [{ id: 'a-1', name: 'write_file', arguments: writeArgs }], callId: call1 }));
    eventStore.append(ev(task.id, sessionId, 'ToolCalled', { tool: 'write_file', args: JSON.parse(writeArgs), modelCallId: call1 }));
    eventStore.append(ev(task.id, sessionId, 'ToolReturned', { tool: 'write_file', result: 'wrote src/hello.ts', toolCallId: 'a-1', duration: 1 }));
    // Second (incomplete) turn: two tool calls, only one result.
    eventStore.append(ev(task.id, sessionId, 'ModelCalled', { model: 'fake/nemotron', promptTokens: 10, completionTokens: 5, callId: call2 }));
    eventStore.append(
      ev(task.id, sessionId, 'AssistantMessage', {
        content: null,
        toolCalls: [
          { id: 'b-1', name: 'write_file', arguments: writeArgs },
          { id: 'b-2', name: 'run_command', arguments: JSON.stringify({ command: ['node', '--version'] }) },
        ],
        callId: call2,
      }),
    );
    eventStore.append(ev(task.id, sessionId, 'ToolCalled', { tool: 'write_file', args: JSON.parse(writeArgs), modelCallId: call2 }));
    eventStore.append(ev(task.id, sessionId, 'ToolReturned', { tool: 'write_file', result: 'wrote src/hello.ts', toolCallId: 'b-1', duration: 1 }));

    const context = makeContext(task.id, sessionId);
    const snapshot = await eventStore.createSnapshot(ulid(), 0, context, 'pre_tool');
    expect(snapshot.ok).toBe(true);
    await eventStore.close();

    const responses = [
      toolChoice('call-3', 'write_file', { path: 'src/hello.ts', content: RIGHT }, { input: 40, output: 5 }),
      finalAnswer('Fixed.'),
    ];
    const mock = startMock(responses);
    const url = await listen(mock.server);

    try {
      const eventStore2 = createEventStore({ rootDir: join(dir, 'events') });
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore: eventStore2,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
      });
      await runtime.initialize(workspace);

      const result = await runtime.resume(snapshot.value as unknown as Checkpoint);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only ONE complete turn survives reconstruction: the second (partial)
      // turn is dropped, so the resumed conversation ends at the first turn.
      const messages = mock.requests[0]!.body.messages as Array<Record<string, unknown>>;
      const assistantTurns = messages.filter((m) => m.role === 'assistant');
      expect(assistantTurns).toHaveLength(1);
      const toolCalls = assistantTurns[0]?.tool_calls as Array<{ id: string }>;
      expect(toolCalls?.[0]?.id).toBe('a-1');

      expect(result.value.outcome).toBe('success');
      expect(readFileSync(join(workspace.worktreePath!, 'src', 'hello.ts'), 'utf8')).toBe(RIGHT);

      await eventStore2.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      await close(mock.server);
    }
  });
});
