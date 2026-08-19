/**
 * Per-project verification config E2E — a repo with NO package.json and NO
 * node_modules gates on a guppy.json command (`node --test`) instead of the
 * Node-only default ladder. If the config were ignored, level 3 would run
 * `npm test` and fail instantly (no package.json), and the run would never
 * pass. The config also replaces levels 1/2 with missing sentinel tools so
 * the ladder provably skips unavailable tools and reaches the configured
 * test command.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Event, type Task } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import { createMemoryStore } from '@guppy/memory';
import { createCoreRuntime } from '@guppy/core';
import { createSessionManager } from '../src/session-manager.js';

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

/** A non-Node repo: no package.json, no node_modules — only guppy.json. */
function writeConfigFixture(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(
    join(dir, 'guppy.json'),
    JSON.stringify({
      verification: {
        levels: {
          // Sentinel tools: guaranteed missing → levels skip cleanly.
          '1': { command: ['guppy-config-e2e-no-tsc'] },
          '2': { command: ['guppy-config-e2e-no-eslint'] },
          // The real gate: node's built-in runner, resolved from PATH.
          '3': ['node', '--test', 'test/unit.test.ts'],
        },
      },
    }),
    'utf8',
  );
  const BROKEN = `export function clamp(v: number, min: number, max: number): number {
  return Math.max(Math.min(v, min), max);
}
`;
  writeFileSync(join(dir, 'src', 'math.ts'), BROKEN, 'utf8');
  // Red with the broken code: an in-range value must come back unchanged.
  const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/math.ts';

test('clamp keeps in-range values unchanged', () => {
  assert.equal(clamp(5, 0, 10), 5);
});
`;
  writeFileSync(join(dir, 'test', 'unit.test.ts'), TEST, 'utf8');
}

const CORRECT_FIX = `export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
`;

/** Wrong fix that keeps the test red, so attempt 1 must fail the gate. */
const WRONG_FIX = `export function clamp(v: number, min: number, max: number): number {
  return Math.max(Math.min(v, max), max);
}
`;

function finalAnswer() {
  return {
    model: 'fake/nemotron',
    choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  };
}

function writeCall(content: string) {
  return {
    model: 'fake/nemotron',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/math.ts', content }) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function startMock(): { server: Server; url: string } {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as {
        messages?: Array<{ role?: string; content?: string | null }>;
      };
      const messages = body.messages ?? [];
      const hasToolResult = messages.some((m) => m.role === 'tool');
      const guided = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('CURRENT ERRORS'),
      );
      const response = hasToolResult ? finalAnswer() : writeCall(guided ? CORRECT_FIX : WRONG_FIX);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
  });
  return { server, url: '' };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('guppy.json verification config through the real gate', () => {
  it('gates a package-less repo on the configured command instead of npm test', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-config-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeConfigFixture(fixtureDir);

    const mock = startMock();
    const url = await listen(mock.server);

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const verifier = createVerificationEngine({
      eventStore,
      workspaceManager: wm,
      projectRoot: fixtureDir,
      timeout: 60_000,
    });
    const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
    const runtime = createCoreRuntime({
      eventStore,
      workspaceManager: wm,
      model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
      maxTurns: 10,
    });
    const sessionManager = createSessionManager({
      repoPath: fixtureDir,
      agentRuntime: runtime,
      contextEngine: new ContextEngine(),
      verificationEngine: verifier,
      eventStore,
      workspaceManager: wm,
      memoryStore,
      maxTurns: 2,
    });

    const task: Task = {
      id: ulid(),
      description: 'Fix the failing clamp function in src/math.ts.',
      repoPath: fixtureDir,
      tags: [],
      verificationLevel: 3,
      createdAt: now(),
      metadata: {},
    };

    try {
      const result = await sessionManager.run(task);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      // The configured `node --test` gate actually ran: a failed attempt
      // produced a TestFailed naming the fixture's test (which only exists
      // in test/unit.test.ts), and the final gate produced TestPassed.
      const events: Event[] = [];
      const sessions = await eventStore.listSessions(task.id as never);
      for (const sessionId of sessions) {
        const trajectory = await eventStore.getTrajectory(task.id as never, sessionId);
        if (trajectory) events.push(...trajectory.events);
      }
      const failure = events.find(
        (e) => e.type === 'TestFailed' && String((e.payload as { name?: string }).name).includes('keeps in-range'),
      );
      expect(failure).toBeDefined();
      expect(events.some((e) => e.type === 'TestPassed')).toBe(true);

      await eventStore.close();
    } finally {
      await close(mock.server);
    }
  }, 90_000);
});
