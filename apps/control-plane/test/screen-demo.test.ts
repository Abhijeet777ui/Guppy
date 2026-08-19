/**
 * Headless screen dump: boots the real TUI against a virtual terminal, drives
 * the plan/build mode flow, and renders each checkpoint as an actual screen
 * grid so the layout can be reviewed without a real terminal. This is the
 * "headless-verified screenshot" step of the M1-M3 workflow: run it, read the
 * dumped screens, sign off.
 *
 * The assertions here are the same as the behavior tests in chat.test.ts; the
 * point of this file is the printed screens, not new coverage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  now,
  ulid,
  type AgentRuntime,
  type Checkpoint,
  type Context,
  type Result,
  type Task,
  type Trajectory,
  type Workspace,
} from '@guppy/contracts';
import { runTui } from '../src/tui.js';
import { formatScreen, renderAnsiScreen } from '../src/ansi-screen.js';
import { stripAnsi } from '../src/tui-logic.js';
import type { Terminal } from '@earendil-works/pi-tui';

const runtimeSlot = vi.hoisted(() => ({ runtime: undefined as unknown as AgentRuntime }));
const captureSlot = vi.hoisted(() => ({ analyzeCaptureFile: vi.fn() }));
vi.mock('@guppy/core', () => ({ createCoreRuntime: () => runtimeSlot.runtime }));
vi.mock('@guppy/bench-runner', () => ({ analyzeCaptureFile: captureSlot.analyzeCaptureFile }));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

const PACKAGE_JSON = JSON.stringify({
  name: 'chat-e2e',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/*.test.ts' },
});

const PASSING_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('truth', () => {
  assert.equal(1, 1);
});
`;

class FakeTerminal implements Terminal {
  output = '';
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  private onInput: ((data: string) => void) | null = null;
  private onResize: (() => void) | null = null;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  emit(data: string): void {
    this.onInput?.(data);
  }

  get text(): string {
    return stripAnsi(this.output);
  }
}

const EMPTY_METRICS = {
  passes: 0,
  failures: 0,
  tokensTotal: 0,
  tokensByModel: {},
  wallTimeMs: 0,
  toolCalls: 0,
  checkpoints: 0,
  contextSelections: 0,
  verificationEscalations: 0,
};

class ReplyRuntime implements AgentRuntime {
  private nonPlanCalls = 0;
  async initialize(_workspace: Workspace): Promise<void> {}
  async shutdown(): Promise<void> {}
  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    const isPlan = task.metadata.mode === 'plan';
    let finalAnswer: string;
    if (isPlan) {
      finalAnswer = 'Read the file, then patch the clamp.';
    } else {
      // First non-plan call is the plain chat turn; the second is the
      // approved-plan build. Distinct answers so the demo's waitFor targets
      // the right turn (a stale match would fire Ctrl+C mid-turn).
      this.nonPlanCalls++;
      finalAnswer =
        this.nonPlanCalls === 1
          ? 'Fixed the clamp. See `src/math.ts`.'
          : 'Plan executed: patched the clamp.';
    }
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'success',
        finalAnswer,
        metrics: { ...EMPTY_METRICS, tokensTotal: 250, toolCalls: 1, passes: 2, failures: 0 },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('screen dump — plan/build mode flow', () => {
  it('drives plan → approve → build, dumping each screen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-screen-' + Date.now()));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    mkdirSync(join(fixtureDir, 'test'), { recursive: true });
    writeFileSync(join(fixtureDir, 'package.json'), PACKAGE_JSON, 'utf8');
    writeFileSync(join(fixtureDir, 'test', 'truth.test.ts'), PASSING_TEST, 'utf8');

    const ctxDir = join(fixtureDir, '.guppy', 'context');
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, 'turn-1.json'), '{}');
    captureSlot.analyzeCaptureFile.mockReset();
    captureSlot.analyzeCaptureFile.mockResolvedValue({ tokensSaved: 10, tool: 'contextops@0.3.4' });

    runtimeSlot.runtime = new ReplyRuntime();
    const fake = new FakeTerminal();

    // runTui swaps console.log while the alt screen is live; capture the real
    // one first so the screen dumps below actually print.
    const realLog = console.log.bind(console);
    const tuiPromise = runTui(
      {
        repoPath: fixtureDir,
        runtime: 'core',
        model: 'fake/chat',
        maxTurns: 1,
        verificationLevel: 3,
        quiet: true,
        local: true,
        keepWorktree: true,
        worktreeBase: join(dir, 'worktrees'),
      },
      fake,
    );

    const dump = (label: string): void => {
      // eslint-disable-next-line no-console
      realLog(String.fromCharCode(10) + formatScreen(renderAnsiScreen(fake.output, fake.rows, fake.columns), label));
    };

    try {
      await waitFor(() => fake.text.includes('Chat mode'), 20_000);
      await new Promise((r) => setTimeout(r, 200)); // let the render settle
      dump('1. boot — build mode');

      for (const ch of 'fix the clamp') fake.emit(ch);
      fake.emit(String.fromCharCode(13));
      await waitFor(() => fake.text.includes('completed (success)'), 30_000);
      await new Promise((r) => setTimeout(r, 200));
      dump('2. after a chat turn (reply + footer + saved)');

      for (const ch of '/plan') fake.emit(ch);
      fake.emit(String.fromCharCode(13));
      await waitFor(() => fake.text.includes('Plan mode —'), 10_000);
      await new Promise((r) => setTimeout(r, 200));
      dump('3. after /plan — indicator + hint swapped');
      expect(fake.text).toContain('· plan');
      expect(fake.text).toContain('planning only — no edits · /build to execute');
      expect(fake.text.lastIndexOf('planning only') > fake.text.lastIndexOf('Enter send')).toBe(true);

      for (const ch of 'fix the clamp') fake.emit(ch);
      fake.emit(String.fromCharCode(13));
      await waitFor(() => fake.text.includes('Plan ready — /build to execute'), 20_000);
      await new Promise((r) => setTimeout(r, 200));
      dump('4. plan produced (read-only) — plan gate footer');
      expect(fake.text).toContain('Read the file, then patch the clamp.');

      for (const ch of '/build') fake.emit(ch);
      fake.emit(String.fromCharCode(13));
      await waitFor(() => fake.text.includes('Plan executed: patched the clamp.'), 20_000);
      await new Promise((r) => setTimeout(r, 200));
      dump('5. after /build — plan approved + executed');

      // Behavior assertions (same guarantees as chat.test.ts): after /build the
      // send hint renders again (after the plan hint), and the indicator is build.
      expect(fake.text.lastIndexOf('Enter send') > fake.text.lastIndexOf('planning only')).toBe(true);
      expect(fake.text).toContain('· build');

      fake.emit(String.fromCharCode(3));
      await tuiPromise;
    } finally {
      fake.emit(String.fromCharCode(3));
      await Promise.race([
        tuiPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  });
});
