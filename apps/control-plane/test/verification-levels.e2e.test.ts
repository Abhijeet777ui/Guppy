/**
 * Verification-breadth E2E — levels 2 (lint), 4 (property), 5 (integration)
 * driven through the real SessionManager + gate, each on a fixture that is
 * red at that level until the agent applies the correct fix.
 *
 * These levels were implemented but never executed: no repo had eslint, a
 * property script, or an integration script, so the ladder always skipped
 * them. Each test below proves the level actually runs and gates:
 *
 * - Level 2: a fixture whose node_modules ships an eslint-compatible shim
 *   that emits real eslint stylish output (verified against eslint 9). The
 *   broken source has a console statement; the gate must fail on it and the
 *   fix must pass it — and a `LintFailed` event must land in the store.
 * - Level 4: a fixture whose unit tests are green but whose property test
 *   (random in-range inputs) fails until the correct clamp lands.
 * - Level 5: a fixture whose unit tests are green but whose integration test
 *   fails until the fix lands (level 4 passes through via `--if-present`).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Event, type Task, type VerificationLevel } from '@guppy/contracts';
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PACKAGE_JSON = {
  name: 'verification-e2e',
  private: true,
  type: 'module',
};

/** Level 2 fixture: broken source with a console statement, plus an eslint-compatible shim. */
function writeLintFixture(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'eslint', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(BASE_PACKAGE_JSON), 'utf8');

  const BROKEN = `export function clamp(v: number, min: number, max: number): number {
  console.log('clamping');
  return Math.max(Math.min(v, min), max);
}
`;
  writeFileSync(join(dir, 'src', 'math.ts'), BROKEN, 'utf8');

  // The shim linter: walks .ts/.tsx files and emits real eslint-9 stylish
  // output (file header line, then indented `line:col severity message rule`
  // rows). Two rules: no-console and no-var.
  const LINTER = `#!/usr/bin/env node
// Minimal eslint-9-compatible shim for the verification e2e (hermetic:
// no network, no real eslint install). Emits the same stylish format.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
const rules = [
  { re: /\\bconsole\\.(log|error|warn)\\(/g, rule: 'no-console', msg: 'Unexpected console statement' },
  { re: /\\bvar\\s+[A-Za-z_$]/g, rule: 'no-var', msg: 'Unexpected var, use let or const instead' },
];
const errors = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.guppy') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\\.tsx?$/.test(entry.name)) lint(full);
  }
}

function lint(file) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\\\/g, '/');
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\\n').length;
      const col = m.index - src.lastIndexOf('\\n', m.index);
      errors.push([rel, line, col, rule.msg, rule.rule]);
    }
  }
}

walk(root);
if (errors.length === 0) process.exit(0);
let lastFile = '';
for (const [file, line, col, msg, rule] of errors) {
  if (file !== lastFile) {
    console.error(file);
    lastFile = file;
  }
  console.error('  ' + line + ':' + col + '  error  ' + msg + '  ' + rule);
}
console.error('');
console.error('\\u2716 ' + errors.length + ' problem' + (errors.length > 1 ? 's' : '') + ' (' + errors.length + ' errors, 0 warnings)');
process.exit(1);
`;
  writeFileSync(join(dir, 'node_modules', 'eslint', 'bin', 'eslint.cjs'), LINTER, 'utf8');
  // A real npm package manifest makes `npm exec --prefix <repo>` treat this
  // as an installed tool instead of fetching eslint from the registry.
  writeFileSync(
    join(dir, 'node_modules', 'eslint', 'package.json'),
    JSON.stringify({ name: 'eslint', version: '9.0.0', bin: { eslint: 'bin/eslint.cjs' } }),
    'utf8',
  );
  // Windows shim (the machine tests run on); POSIX fallback for other hosts.
  writeFileSync(
    join(dir, 'node_modules', '.bin', 'eslint.cmd'),
    '@ECHO off\r\nnode "%~dp0\\..\\eslint\\bin\\eslint.cjs" %*\r\n',
    'utf8',
  );
  // POSIX needs the executable bit on the shim (npm exec spawns it directly);
  // on Windows the .cmd shim above is used and the mode is irrelevant.
  writeFileSync(
    join(dir, 'node_modules', '.bin', 'eslint'),
    '#!/usr/bin/env node\nrequire(\'../eslint/bin/eslint.cjs\');\n',
    { encoding: 'utf8', mode: 0o755 },
  );
}

/** Level 4/5 fixture: broken clamp; unit tests green with the broken code, property/integration red. */
function writeTestFixture(dir: string, extraScripts: Record<string, string>): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      ...BASE_PACKAGE_JSON,
      scripts: { test: 'node --test test/*.test.ts', ...extraScripts },
    }),
    'utf8',
  );
  const BROKEN = `export function clamp(v: number, min: number, max: number): number {
  return Math.max(Math.min(v, min), max);
}
`;
  writeFileSync(join(dir, 'src', 'math.ts'), BROKEN, 'utf8');
  // Green with the broken code: only tests values >= max, where the broken
  // implementation happens to return max correctly.
  const UNIT = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/math.ts';

test('clamp caps at max', () => {
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(clamp(20, 5, 10), 10);
});
`;
  writeFileSync(join(dir, 'test', 'unit.test.ts'), UNIT, 'utf8');
}

/** Level 4: property test over random in-range inputs (red with broken code). */
function writePropertyFixture(dir: string): void {
  writeTestFixture(dir, { 'test:property': 'node --test test/property.test.ts' });
  const PROPERTY = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/math.ts';

test('clamp stays within bounds for random inputs', () => {
  for (let i = 0; i < 100; i++) {
    const min = Math.floor(Math.random() * 20) - 10;
    const max = min + 1 + Math.floor(Math.random() * 20);
    const v = Math.floor(Math.random() * 40) - 20;
    const result = clamp(v, min, max);
    assert.ok(result >= min && result <= max, \`clamp(\${v}, \${min}, \${max}) = \${result} out of range\`);
    if (v >= min && v <= max) assert.equal(result, v, \`in-range value \${v} changed\`);
  }
});
`;
  writeFileSync(join(dir, 'test', 'property.test.ts'), PROPERTY, 'utf8');
}

/** Level 5: integration test across a module boundary (red with broken code). */
function writeIntegrationFixture(dir: string): void {
  writeTestFixture(dir, { 'test:integration': 'node --test test/integration.test.ts' });
  const INTEGRATION = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/math.ts';

test('normalizes a series end-to-end', () => {
  const samples = [5, -3, 15, 7, 12, 0];
  const normalized = samples.map((v) => clamp(v, 0, 10));
  assert.deepEqual(normalized, [5, 0, 10, 7, 10, 0]);
});
`;
  writeFileSync(join(dir, 'test', 'integration.test.ts'), INTEGRATION, 'utf8');
}

// ---------------------------------------------------------------------------
// Mock model: attempt 1 applies a wrong fix, attempt 2 (guided by the gate's
// failure feedback in the context) applies the correct one.
// ---------------------------------------------------------------------------

const CORRECT_FIX = `export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
`;

/** Wrong fix that keeps lint red / tests red, so attempt 1 must fail the gate. */
const WRONG_FIX = `export function clamp(v: number, min: number, max: number): number {
  console.warn('clamping');
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function runLevel(dir: string, fixtureDir: string, level: VerificationLevel) {
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
    verificationLevel: level,
    createdAt: now(),
    metadata: {},
  };

  try {
    const result = await sessionManager.run(task);
    return { result, task, eventStore };
  } finally {
    await close(mock.server);
  }
}

/** Collect every event the session store captured for the run. */
async function collectEvents(taskId: string, eventStore: ReturnType<typeof createEventStore>): Promise<Event[]> {
  const events: Event[] = [];
  const sessions = await eventStore.listSessions(taskId as any);
  for (const sessionId of sessions) {
    const trajectory = await eventStore.getTrajectory(taskId as any, sessionId);
    if (trajectory) events.push(...trajectory.events);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verification levels 2/4/5 through the real gate', () => {
  // These gates spawn real npm exec/npm run processes per attempt; under
  // parallel suite load on Windows that can exceed vitest's 30s default, so
  // give each a generous explicit timeout.
  it('level 2 (lint): gates on an eslint violation and records LintFailed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-lint-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeLintFixture(fixtureDir);

    const { result, task, eventStore } = await runLevel(dir, fixtureDir, 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('success');

    const events = await collectEvents(task.id, eventStore);
    // The lint gate actually ran: a failed attempt emitted LintFailed, and
    // the final gate emitted LintPassed.
    expect(events.some((e) => e.type === 'LintFailed')).toBe(true);
    expect(events.some((e) => e.type === 'LintPassed')).toBe(true);

    await eventStore.close();
  }, 90_000);

  it('level 4 (property): gates on the property test before the fix lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-property-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writePropertyFixture(fixtureDir);

    const { result, task, eventStore } = await runLevel(dir, fixtureDir, 4);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('success');

    const events = await collectEvents(task.id, eventStore);
    // Level 4 ran: a failed attempt produced a TestFailed naming the property
    // test (its name only exists in test/property.test.ts).
    const propertyFailure = events.find(
      (e) => e.type === 'TestFailed' && String((e.payload as { name?: string }).name).includes('stays within bounds'),
    );
    expect(propertyFailure).toBeDefined();

    await eventStore.close();
  }, 90_000);

  it('level 5 (integration): gates on the integration test before the fix lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-integration-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeIntegrationFixture(fixtureDir);

    const { result, task, eventStore } = await runLevel(dir, fixtureDir, 5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('success');

    const events = await collectEvents(task.id, eventStore);
    // Level 5 ran: a failed attempt produced a TestFailed naming the
    // integration test (only present in test/integration.test.ts).
    const integrationFailure = events.find(
      (e) => e.type === 'TestFailed' && String((e.payload as { name?: string }).name).includes('normalizes a series'),
    );
    expect(integrationFailure).toBeDefined();

    await eventStore.close();
  }, 90_000);
});
