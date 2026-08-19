/**
 * Hermetic E2E for CoreAgentRuntime — no network, no pi, no prime.
 *
 * A scripted mock LLM drives the real tool loop: write_file → run_command →
 * final answer. Asserts the Guppy event stream and that the write actually
 * landed in the workspace via WorkspaceManager.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Context, type Task } from '@guppy/contracts';
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
          tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
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

/** Split a tool call across two SSE deltas so the runtime must stitch it. */
function streamToolChoice(
  id: string,
  name: string,
  args: unknown,
  usage: { input: number; output: number },
): Array<Record<string, unknown>> {
  const argsJson = JSON.stringify(args);
  const nameMid = Math.max(1, Math.floor(name.length / 2));
  const argsMid = Math.max(1, Math.floor(argsJson.length / 2));
  return [
    {
      model: 'fake/nemotron',
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, function: { name: name.slice(0, nameMid), arguments: argsJson.slice(0, argsMid) } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: name.slice(nameMid), arguments: argsJson.slice(argsMid) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { usage: { prompt_tokens: usage.input, completion_tokens: usage.output } },
  ];
}

/** A single text delta plus a trailing usage chunk. */
function streamText(text: string, usage: { input: number; output: number }): Array<Record<string, unknown>> {
  return [
    { model: 'fake/nemotron', choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: usage.input, completion_tokens: usage.output } },
  ];
}

/** Serve one SSE stream per request (the last stream repeats once exhausted). */
function startStreamMock(
  streams: Array<Array<Record<string, unknown>>>,
): { server: Server; url: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  let i = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw || '{}') });
      const chunks = streams[Math.min(i, streams.length - 1)] ?? [];
      i++;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
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

/**
 * A mock that accepts the request but never answers (a hung endpoint). Used
 * to prove Ctrl+C aborts an in-flight model call instead of waiting forever.
 */
function startHangingMock(): { server: Server; url: string } {
  const server = createServer((_req, res) => {
    // Intentionally send nothing at all: the connection stays open with no
    // headers, so the client's fetch remains pending until the runtime's
    // AbortController tears it down.
    void res;
  });
  return { server, url: '' };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeTask(): Task {
  return {
    id: ulid(),
    description: 'Add a hello module and verify the workspace.',
    repoPath: '',
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

function makeContext(taskId: ReturnType<typeof ulid>): Context {
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

describe('CoreAgentRuntime (hermetic)', () => {
  it('runs the model↔tool loop and emits the full event stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-e2e-'));
    tmpDirs.push(dir);

    const responses = [
      toolChoice('call-1', 'write_file', { path: 'src/hello.ts', content: 'export const answer = 42;\n' }, { input: 10, output: 5 }),
      toolChoice('call-2', 'run_command', { command: ['node', '--version'] }, { input: 20, output: 5 }),
      {
        model: 'fake/nemotron',
        choices: [{ message: { role: 'assistant', content: 'The task is complete.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      },
    ];
    const mock = startMock(responses);
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      // Fixture dir and worktree base must be siblings: the local-mode
      // workspace copy refuses to copy a directory into its own subtree.
      const fixtureDir = join(dir, 'fixture');
      mkdirSync(fixtureDir);
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        contextCaptureDir: join(dir, 'capture'),
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const traj = result.value;
      expect(traj.outcome).toBe('success');
      expect(traj.metrics.toolCalls).toBe(2);
      expect(traj.metrics.tokensTotal).toBe(78);
      expect(traj.metrics.tokensByModel['fake/nemotron']).toBe(78);

      const types = traj.events.map((e) => e.type);
      expect(types.filter((t) => t === 'ModelCalled')).toHaveLength(3);
      expect(types.filter((t) => t === 'ToolCalled')).toHaveLength(2);
      expect(types.filter((t) => t === 'ToolReturned')).toHaveLength(2);
      expect(types.filter((t) => t === 'FileChanged')).toHaveLength(1);
      expect(types).toEqual(
        expect.arrayContaining(['TaskStarted', 'TrajectoryCompleted']),
      );
      // The final no-tool-call completion is surfaced as both an event and
      // the trajectory's `finalAnswer` (the assistant reply for chat).
      expect(types.filter((t) => t === 'FinalAnswer')).toHaveLength(1);
      expect(traj.finalAnswer).toBe('The task is complete.');

      const fileChanged = traj.events.find((e) => e.type === 'FileChanged')!;
      expect(fileChanged.payload.path).toBe('src/hello.ts');

      // The write went through WorkspaceManager into the worktree.
      const written = readFileSync(join(workspace.worktreePath!, 'src', 'hello.ts'), 'utf8');
      expect(written).toBe('export const answer = 42;\n');

      // The second model call carried the first tool's result back to the model.
      const second = mock.requests[1]!;
      const toolMessages = (second.body.messages as Array<{ role: string; name?: string }>).filter(
        (m) => m.role === 'tool',
      );
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]!.name).toBe('write_file');

      // Three model calls total: initial, after write_file, after run_command.
      expect(mock.requests).toHaveLength(3);

      // Context capture: one `{ model, messages, tools }` dump per model call.
      const captures = readdirSync(join(dir, 'capture')).filter((f) => f.endsWith('.json')).sort();
      expect(captures).toHaveLength(3);
      const firstCapture = JSON.parse(readFileSync(join(dir, 'capture', captures[0]!), 'utf8'));
      expect(firstCapture.model).toBe('fake/nemotron');
      expect(
        firstCapture.tools.map((t: { function: { name: string } }) => t.function.name).sort(),
      ).toEqual(['apply_patch', 'git_diff', 'git_status', 'list_files', 'read_file', 'run_command', 'search', 'write_file']);
      expect(Array.isArray(firstCapture.messages)).toBe(true);
      expect(firstCapture.messages[0]?.role).toBe('system');

      await eventStore.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      await close(mock.server);
    }
  });

  it('streams model output as ModelStreamed events and still runs the tool loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-stream-'));
    tmpDirs.push(dir);

    const streams = [
      streamToolChoice(
        'call-1',
        'write_file',
        { path: 'src/hello.ts', content: 'export const answer = 42;\n' },
        { input: 10, output: 5 },
      ),
      streamText('The task is complete.', { input: 30, output: 8 }),
    ];
    const mock = startStreamMock(streams);
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const fixtureDir = join(dir, 'fixture');
      mkdirSync(fixtureDir);
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        stream: true,
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const traj = result.value;
      expect(traj.outcome).toBe('success');
      expect(traj.metrics.toolCalls).toBe(1);
      expect(traj.metrics.tokensTotal).toBe(53);

      // Streaming emitted at least one ModelStreamed carrying the final text.
      const streamed = traj.events.filter((e) => e.type === 'ModelStreamed');
      expect(streamed.length).toBeGreaterThan(0);
      expect(streamed[streamed.length - 1]!.payload.text).toBe('The task is complete.');

      // The stitched tool call still landed the write in the worktree.
      expect(readFileSync(join(workspace.worktreePath!, 'src', 'hello.ts'), 'utf8')).toBe(
        'export const answer = 42;\n',
      );
      expect(traj.events.filter((e) => e.type === 'ModelCalled')).toHaveLength(2);
      // Streaming path surfaces the final text answer too.
      expect(traj.finalAnswer).toBe('The task is complete.');
      expect(traj.events.filter((e) => e.type === 'FinalAnswer')).toHaveLength(1);

      await eventStore.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      await close(mock.server);
    }
  });

  it('readOnly mode exposes only non-mutating tools and refuses edits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-readonly-'));
    tmpDirs.push(dir);

    // Script: read an existing file (allowed), then try to write (must be
    // refused because the tool is not exposed), then answer.
    const responses = [
      toolChoice('call-1', 'read_file', { path: 'existing.txt' }, { input: 10, output: 5 }),
      toolChoice('call-2', 'write_file', { path: 'nope.ts', content: 'export const nope = 1;\n' }, { input: 20, output: 5 }),
      {
        model: 'fake/nemotron',
        choices: [{ message: { role: 'assistant', content: 'Plan complete.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      },
    ];
    const mock = startMock(responses);
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const fixtureDir = join(dir, 'fixture');
      mkdirSync(fixtureDir);
      writeFileSync(join(fixtureDir, 'existing.txt'), 'hello', 'utf8');
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        readOnly: true,
        contextCaptureDir: join(dir, 'capture'),
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const traj = result.value;
      // The write tool was never exposed, so the call resolved to "unknown tool".
      const writeReturned = traj.events.find(
        (e) => e.type === 'ToolReturned' && e.payload.tool === 'write_file',
      );
      expect(writeReturned).toBeTruthy();
      expect(writeReturned!.payload.error).toContain('unknown tool');
      // No file materialized, and no FileChanged event was emitted.
      expect(existsSync(join(workspace.worktreePath!, 'nope.ts'))).toBe(false);
      expect(traj.events.some((e) => e.type === 'FileChanged')).toBe(false);

      // The read-only capture dumps exactly the non-mutating tool set.
      const captures = readdirSync(join(dir, 'capture')).filter((f) => f.endsWith('.json')).sort();
      const firstCapture = JSON.parse(readFileSync(join(dir, 'capture', captures[0]!), 'utf8'));
      expect(
        firstCapture.tools.map((t: { function: { name: string } }) => t.function.name).sort(),
      ).toEqual(['git_diff', 'git_status', 'list_files', 'read_file', 'search']);

      await eventStore.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      await close(mock.server);
    }
  });

  it('aborts an in-flight model call and lands outcome cancelled (Ctrl+C)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-abort-'));
    tmpDirs.push(dir);

    const mock = startHangingMock();
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const fixtureDir = join(dir, 'fixture');
      mkdirSync(fixtureDir);
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        // A tight timeout keeps the test fast if the abort path ever breaks;
        // the signal should win well before it fires.
        modelTimeoutMs: 5_000,
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const controller = new AbortController();
      const runPromise = runtime.run(task, makeContext(task.id), controller.signal);

      // Give the request a beat to go in-flight, then Ctrl+C.
      await new Promise((r) => setTimeout(r, 150));
      controller.abort();

      const result = await runPromise;
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const traj = result.value;
      expect(traj.outcome).toBe('cancelled');
      expect(traj.error).toBeUndefined();

      const completed = traj.events.find((e) => e.type === 'TrajectoryCompleted')!;
      expect(completed.payload.outcome).toBe('cancelled');
      expect(completed.payload.lastGatePassed).toBe(false);

      await eventStore.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      await close(mock.server);
    }
  });
});
