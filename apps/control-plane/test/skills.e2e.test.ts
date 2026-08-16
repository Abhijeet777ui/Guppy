/**
 * Skills E2E — a skill in `<repo>/.guppy/skills` reaches the model's context
 * and is the only way to pass the gate.
 *
 * The scripted mock model refuses to guess: it only applies the correct fix
 * when the system prompt contains the `=== SKILLS ===` section (which the
 * session manager loads from the fixture's `.guppy/skills`). Without the
 * skill, the agent writes a wrong edit, fails the real `npm test` gate, and
 * the run fails.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  name: 'skills-e2e',
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

/** The skill's body is the only hint that the argument order matters. */
const SKILL_FILE = `---
name: clamp-fix
description: The correct clamp implementation is Math.min(Math.max(v, min), max)
tags: clamp, math
---
The clamp function is broken because Math.max(Math.min(v, min), max) returns min
for every input. Write Math.min(Math.max(v, min), max) instead.
`;

function writeFixture(dir: string, withSkill: boolean): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON, 'utf8');
  writeFileSync(join(dir, 'src', 'math.ts'), BROKEN_SRC, 'utf8');
  writeFileSync(join(dir, 'test', 'math.test.ts'), TEST_FILE, 'utf8');
  if (withSkill) {
    mkdirSync(join(dir, '.guppy', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.guppy', 'skills', 'clamp-fix.md'), SKILL_FILE, 'utf8');
  }
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

/**
 * Scripted model that only applies the correct fix when the SKILLS section is
 * in context — mirroring a real model that follows the repo's documented
 * ritual (here, the clamp argument order).
 */
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
      const hasSkills = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('=== SKILLS ==='),
      );

      const response = hasToolResult ? finalAnswer() : writeCall(hasSkills ? CORRECT_FIX : WRONG_FIX);

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

function makeSessionManager(
  dir: string,
  fixtureDir: string,
  url: string,
): ReturnType<typeof createSessionManager> {
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

  return createSessionManager({
    repoPath: fixtureDir,
    agentRuntime: runtime,
    contextEngine: new ContextEngine(),
    verificationEngine: verifier,
    eventStore,
    workspaceManager: wm,
    memoryStore,
    maxTurns: 2,
  });
}

function makeTask(fixtureDir: string): Task {
  return {
    id: ulid(),
    description: 'Fix the failing clamp test by correcting src/math.ts.',
    repoPath: fixtureDir,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

describe('repo skills (SessionManager → context → gate)', () => {
  it('passes the gate when the skill is loaded into the context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-skills-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir, true);

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

    try {
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

      const result = await sessionManager.run(makeTask(fixtureDir));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      // The fix landed in the source repo via merge-back.
      const merged = readFileSync(join(fixtureDir, 'src', 'math.ts'), 'utf8');
      expect(merged).toContain('Math.min(Math.max(v, min), max)');

      await eventStore.close();
    } finally {
      await close(mock.server);
    }
  });

  it('fails the gate without the skill (the mock only fixes when the skill is in context)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-no-skill-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir, false);

    const mock = startMock();
    const url = await listen(mock.server);

    try {
      const sessionManager = makeSessionManager(dir, fixtureDir, url);
      const result = await sessionManager.run(makeTask(fixtureDir));
      // A failed gate returns ok with outcome 'failure' (the harness never
      // declares victory); assert the outcome, not the Result wrapper.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('failure');
    } finally {
      await close(mock.server);
    }
  });
});
