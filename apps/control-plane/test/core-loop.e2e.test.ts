/**
 * Hermetic full-loop E2E for the standalone core — no network, no pi, no prime.
 *
 * A scripted mock LLM drives CoreAgentRuntime through the real SessionManager:
 * attempt 1 makes a wrong edit and fails the real `npm test` gate; the failure
 * is fed back into attempt 2's context; attempt 2 writes the correct fix and
 * passes. Asserts the loop distills a `fix` memory (failure → change → pass).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Task } from '@guppy/contracts';
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

const PACKAGE_JSON = JSON.stringify({
  name: 'core-e2e',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/*.test.ts' },
});

const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/math.ts';

test('clamp keeps values inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});
`;

const BROKEN_SRC = `export function clamp(v: number, min: number, max: number): number {
  return Math.max(Math.min(v, min), max);
}
`;

const WRONG_FIX = `export function clamp(v: number, min: number, max: number): number {
  return v;
}
`;

const CORRECT_FIX = `export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
`;

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON, 'utf8');
  writeFileSync(join(dir, 'src', 'math.ts'), BROKEN_SRC, 'utf8');
  writeFileSync(join(dir, 'test', 'math.test.ts'), TEST_FILE, 'utf8');
}

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

/** Scripted model: wrong edit when unguided, correct edit once the failure is fed back. */
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
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('CURRENT TEST RESULTS'),
      );

      const response = hasToolResult
        ? finalAnswer()
        : writeCall(guided ? CORRECT_FIX : WRONG_FIX);

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
  });
  return { server, url: '' };
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

describe('standalone core loop (SessionManager + gate + memory)', () => {
  it('fails attempt 1, recovers on attempt 2, and distills a fix memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-core-loop-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const mock = startMock();
    const url = await listen(mock.server);

    try {
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

      const task: Task = {
        id: ulid(),
        description: 'Fix the failing clamp test by correcting src/math.ts.',
        repoPath: fixtureDir,
        tags: [],
        verificationLevel: 3,
        createdAt: now(),
        metadata: {},
      };

      const sessionManager = createSessionManager({
        repoPath: fixtureDir,
        agentRuntime: runtime,
        contextEngine: new ContextEngine(),
        verificationEngine: verifier,
        eventStore,
        workspaceManager: wm,
        memoryStore,
        maxTurns: 3,
      });

      const result = await sessionManager.run(task);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      // The whole loop distilled a fix: TestFailed → FileChanged → TestPassed.
      const fixes = memoryStore.retrieve({ type: 'fix' });
      expect(fixes.length).toBeGreaterThan(0);
      expect(fixes[0]!.memory.summary).toContain('clamp keeps values inside the range');

      await eventStore.close();
    } finally {
      await close(mock.server);
    }
  });
});
