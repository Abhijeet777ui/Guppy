/**
 * Hermetic E2E for the optional LLM history summarizer (hybrid recap).
 *
 * A branching mock serves two request kinds: requests WITHOUT a `tools` field
 * are the summarizer call (returns a semantic summary), requests WITH tools are
 * the agent loop (scripted read_file → … → final answer). This proves the
 * summarizer's summary reaches the model, its tokens are counted, and that a
 * failing summarizer falls back to the deterministic recap.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Context, type Task } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { COMPRESSED_HISTORY_HEADER, createCoreRuntime } from '../src/index.js';

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

function toolChoice(id: string, name: string, args: unknown) {
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
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function finalAnswer(text: string) {
  return {
    model: 'fake/nemotron',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 8 },
  };
}

function summaryReply(text: string, usage = { prompt_tokens: 900, completion_tokens: 40 }) {
  return {
    model: 'fake/summarizer',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  };
}

interface BranchingMock {
  server: Server;
  requests: Array<{ body: Record<string, unknown> }>;
  summarizerRequests: Array<Record<string, unknown>>;
}

/** Branch on `tools` presence: no tools = summarizer, tools = the agent loop. */
function startBranchingMock(opts: {
  summarizer: (n: number) => Record<string, unknown>;
  loop: Array<Record<string, unknown>>;
}): BranchingMock {
  const requests: Array<{ body: Record<string, unknown> }> = [];
  const summarizerRequests: Array<Record<string, unknown>> = [];
  let loopIdx = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push({ body });
      const isSummarizer = body['tools'] === undefined;
      let reply: Record<string, unknown>;
      if (isSummarizer) {
        summarizerRequests.push(body);
        reply = opts.summarizer(summarizerRequests.length - 1);
      } else {
        reply = opts.loop[loopIdx] ?? { choices: [] };
        loopIdx++;
      }
      const status = reply['__status'] as number | undefined;
      if (status) {
        res.statusCode = status;
        res.end((reply['__body'] as string) ?? 'boom');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  return { server, requests, summarizerRequests };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    });
  });
}

function makeTask(): Task {
  return {
    id: ulid(),
    description: 'Fix the big file so the checks pass.',
    repoPath: '',
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

function makeContext(taskId: string): Context {
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

describe('CoreAgentRuntime LLM history summarizer (hermetic)', () => {
  it('replaces the deterministic recap with the LLM summary and counts its tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-summarizer-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'big.txt'), 'z'.repeat(60_000), 'utf8');

    const SUMMARY = 'SUMMARY: read big.txt — it is 60k z characters; no edits needed yet.';
    const mock = startBranchingMock({
      summarizer: () => summaryReply(SUMMARY),
      loop: [
        toolChoice('call-1', 'read_file', { path: 'big.txt' }),
        toolChoice('call-2', 'read_file', { path: 'big.txt' }),
        finalAnswer('Done.'),
      ],
    });
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events'), sqliteIndex: false });
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        maxHistoryTokens: 2_000,
        historyKeepRecentTurns: 1,
        historySummarizer: { model: { provider: 'fake', model: 'fake/summarizer', baseUrl: url } },
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const traj = result.value;

      const compressed = traj.events.filter((e) => e.type === 'ContextCompressed');
      expect(compressed.length).toBeGreaterThan(0);
      for (const e of compressed) {
        const payload = (e as unknown as { payload: { summarySource?: string } }).payload;
        expect(payload.summarySource).toBe('llm');
      }

      // The summarizer was called (requests without tools), and its summary
      // reached the model in a later loop request.
      expect(mock.summarizerRequests.length).toBeGreaterThan(0);
      const sawSummary = mock.requests.some(
        (r) => r.body['tools'] !== undefined && JSON.stringify(r.body['messages']).includes(SUMMARY),
      );
      expect(sawSummary).toBe(true);

      // Summary tokens are real spend and land in the trajectory.
      expect(traj.metrics.tokensByModel['fake/summarizer']).toBeGreaterThan(0);

      await eventStore.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      mock.server.close();
    }
  });

  it('falls back to the deterministic recap when the summarizer fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-summarizer-fb-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'big.txt'), 'z'.repeat(60_000), 'utf8');

    const mock = startBranchingMock({
      summarizer: () => ({ __status: 500, __body: 'summarizer down' }),
      loop: [
        toolChoice('call-1', 'read_file', { path: 'big.txt' }),
        toolChoice('call-2', 'read_file', { path: 'big.txt' }),
        finalAnswer('Done.'),
      ],
    });
    const url = await listen(mock.server);

    try {
      const eventStore = createEventStore({ rootDir: join(dir, 'events'), sqliteIndex: false });
      const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const workspace = (await wm.createWorkspace(fixtureDir)).value;

      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
        maxHistoryTokens: 2_000,
        historyKeepRecentTurns: 1,
        // No retries so the failing summarizer fails fast and the recap stays deterministic.
        historySummarizer: { model: { provider: 'fake', model: 'fake/summarizer', baseUrl: url, maxRetries: 0 } },
      });
      await runtime.initialize(workspace);

      const task = makeTask();
      const result = await runtime.run(task, makeContext(task.id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const traj = result.value;

      const compressed = traj.events.filter((e) => e.type === 'ContextCompressed');
      expect(compressed.length).toBeGreaterThan(0);
      expect(mock.summarizerRequests.length).toBeGreaterThan(0);
      for (const e of compressed) {
        const payload = (e as unknown as { payload: { summarySource?: string } }).payload;
        expect(payload.summarySource).toBe('deterministic');
      }
      // No LLM summary ever reached the loop; the deterministic header survives.
      const recapHitModel = mock.requests.some(
        (r) =>
          r.body['tools'] !== undefined &&
          JSON.stringify(r.body['messages']).includes(COMPRESSED_HISTORY_HEADER),
      );
      expect(recapHitModel).toBe(true);
      expect(traj.metrics.tokensByModel['fake/summarizer']).toBeUndefined();

      await eventStore.close();
      await wm.destroyWorkspace(workspace.id);
    } finally {
      mock.server.close();
    }
  });
});
