/**
 * guppy chat turn — runChatTurn must report a success summary from the gated
 * loop and degrade to a failed-turn result when the runtime crashes.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import { createMemoryStore } from '@guppy/memory';
import { createSessionManager } from '../src/session-manager.js';
import { ContextSavingsTracker, diffLines, emitPlanRevised, runChat, runChatTurn } from '../src/chat.js';
import { runTui } from '../src/tui.js';
import { stripAnsi } from '../src/tui-logic.js';
import type { Terminal } from '@earendil-works/pi-tui';

// `runChat` builds its own runtime through `buildAgentRuntime`; stub the core
// factory so a scripted, gate-controlled runtime stands in for a real model.
// Also stub the ContextOps bridge so the savings tracker is hermetic.
const runtimeSlot = vi.hoisted(() => ({ runtime: undefined as unknown as AgentRuntime }));
const captureSlot = vi.hoisted(() => ({ analyzeCaptureFile: vi.fn() }));
vi.mock('@guppy/core', () => ({ createCoreRuntime: () => runtimeSlot.runtime }));
vi.mock('@guppy/bench-runner', () => ({ analyzeCaptureFile: captureSlot.analyzeCaptureFile }));

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

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON, 'utf8');
  writeFileSync(join(dir, 'test', 'truth.test.ts'), PASSING_TEST, 'utf8');
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

/** A runtime that succeeds immediately with scripted metrics (no model needed). */
class FakeRuntime implements AgentRuntime {
  async initialize(_workspace: Workspace): Promise<void> {}
  async shutdown(): Promise<void> {}
  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'success',
        metrics: { ...EMPTY_METRICS, tokensTotal: 500, toolCalls: 3 },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

/** A runtime that throws mid-run, like a provider hang or a crash. */
class CrashRuntime implements AgentRuntime {
  async initialize(_workspace: Workspace): Promise<void> {}
  async shutdown(): Promise<void> {}
  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }
  async run(_task: Task, _context: Context): Promise<Result<Trajectory, Error>> {
    throw new Error('simulated chat crash');
  }
}

/** A runtime that blocks in run() until released — lets a test hold a turn in flight. */
class SlowRuntime extends FakeRuntime {
  started = false;
  private gate = deferred<void>();
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    this.started = true;
    await this.gate.promise;
    return super.run(task, context);
  }
  release(): void {
    this.gate.resolve();
  }
}

/** A runtime that returns a real prose answer (markdown) like the core loop does. */
class ReplyRuntime extends FakeRuntime {
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'success',
        finalAnswer: 'Fixed the clamp — see `src/math.ts`.',
        metrics: { ...EMPTY_METRICS, tokensTotal: 250, toolCalls: 1, passes: 2, failures: 0 },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

/**
 * A runtime that answers differently for a plan vs a build turn, so the
 * plan→approve→build flow can assert both halves with one fake.
 */
class PlanAwareRuntime extends FakeRuntime {
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    const isPlan = task.metadata.mode === 'plan';
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'success',
        finalAnswer: isPlan ? 'Read the file, then patch the clamp.' : 'Plan executed: patched the clamp.',
        metrics: { ...EMPTY_METRICS, tokensTotal: 200, toolCalls: 0 },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

/**
 * A runtime that blocks until released, then lands 'cancelled' if the caller's
 * AbortSignal fired (like the real CoreAgentRuntime after Ctrl+C).
 */
class AbortableRuntime extends FakeRuntime {
  started = false;
  private gate = deferred<void>();
  private signal: AbortSignal | undefined;
  async run(task: Task, context: Context, signal?: AbortSignal): Promise<Result<Trajectory, Error>> {
    this.started = true;
    this.signal = signal;
    await this.gate.promise;
    if (signal?.aborted) {
      return {
        ok: true,
        value: {
          id: ulid(),
          taskId: task.id,
          sessionId: context.sessionId,
          events: [],
          outcome: 'cancelled',
          metrics: { ...EMPTY_METRICS, tokensTotal: 100, toolCalls: 0 },
          startedAt: now(),
          completedAt: now(),
        },
      };
    }
    return super.run(task, context);
  }
  release(): void {
    this.gate.resolve();
  }
}

/**
 * Minimal in-memory pi-tui `Terminal` for the headless render harness:
 * captures every byte written and lets tests feed keystrokes through the real
 * input pipeline. (A later upgrade can swap in @xterm/headless for
 * cell-accurate assertions; this satisfies "boot the real TUI against a
 * virtual terminal, feed keystrokes, assert the rendered screen" at the
 * content level.)
 */
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

  /** Feed raw keystrokes into the TUI's real input pipeline. */
  emit(data: string): void {
    this.onInput?.(data);
  }

  /** The rendered screen text, with ANSI stripped. */
  get text(): string {
    return stripAnsi(this.output);
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeTask(repoPath: string, description: string): Task {
  return {
    id: ulid(),
    description,
    repoPath,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: { chat: true },
  };
}

async function makeSession(
  dir: string,
  fixtureDir: string,
  runtime: AgentRuntime,
): Promise<{ eventStore: ReturnType<typeof createEventStore>; sessionManager: ReturnType<typeof createSessionManager> }> {
  const eventStore = createEventStore({ rootDir: join(dir, 'events') });
  const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
  const verifier = createVerificationEngine({
    eventStore,
    workspaceManager: wm,
    projectRoot: fixtureDir,
    timeout: 60_000,
  });
  const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
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
  return { eventStore, sessionManager };
}

describe('ContextSavingsTracker', () => {
  it('accumulates savings across new captures and stops once unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-savings-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'turn-1.json'), '{}');
    writeFileSync(join(dir, 'turn-2.json'), '{}');

    captureSlot.analyzeCaptureFile
      .mockResolvedValueOnce({ tokensSaved: 10, tool: 'contextops@0.3.4' })
      .mockResolvedValueOnce({ tokensSaved: 5, tool: 'contextops@0.3.4' });

    const tracker = new ContextSavingsTracker(dir);
    const first = await tracker.scoreNew();
    expect(first.saved).toBe(15);
    expect(first.total).toBe(15);
    expect(first.available).toBe(true);

    // No new files on the second pass: delta is 0, total persists.
    const second = await tracker.scoreNew();
    expect(second.saved).toBe(0);
    expect(second.total).toBe(15);
    expect(second.available).toBe(true);

    // A capture that fails to score marks the tracker unavailable...
    writeFileSync(join(dir, 'turn-3.json'), '{}');
    captureSlot.analyzeCaptureFile.mockRejectedValueOnce(new Error('no python'));
    const third = await tracker.scoreNew();
    expect(third.saved).toBe(0);
    expect(third.available).toBe(false);

    // ...and further calls never spawn another doomed subprocess.
    writeFileSync(join(dir, 'turn-4.json'), '{}');
    const fourth = await tracker.scoreNew();
    expect(fourth.available).toBe(false);
    expect(captureSlot.analyzeCaptureFile).toHaveBeenCalledTimes(3);
  });

  it('never throws when the capture directory does not exist', async () => {
    const tracker = new ContextSavingsTracker(join(tmpdir(), 'does-not-exist-guppy'));
    await expect(tracker.scoreNew()).resolves.toEqual({
      saved: 0,
      total: 0,
      available: false,
    });
  });
});

describe('plan revision trail', () => {
  it('diffLines renders a readable -/+ line diff', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toBe('  a\n- b\n+ B\n  c\n+ d');
    // Identical inputs produce an all-context diff (no phantom changes).
    expect(diffLines('same', 'same')).toBe('  same');
    // Pathological sizes degrade instead of blowing the DP table.
    const big = 'x\n'.repeat(2100);
    expect(diffLines(big, big)).toBe('2100 lines removed\n+ 2100 lines added');
  });

  it('emitPlanRevised records previous, revised, and diff durably', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-planrev-'));
    tmpDirs.push(dir);
    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const taskId = ulid();

    emitPlanRevised(eventStore, taskId, 'step one\nstep two', 'step one\nstep three');

    const sessions = await eventStore.listSessions(taskId);
    expect(sessions).toHaveLength(1);
    const events: unknown[] = [];
    for await (const e of eventStore.readEvents({ taskId, sessionId: sessions[0]!, index: 0 })) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as { type: string; payload: { previous: string; revised: string; diff: string } };
    expect(event.type).toBe('PlanRevised');
    expect(event.payload.previous).toBe('step one\nstep two');
    expect(event.payload.revised).toBe('step one\nstep three');
    expect(event.payload.diff).toBe('  step one\n- step two\n+ step three');

    await eventStore.close();
  });
});

describe('runChatTurn', () => {
  it('reports a success summary from the gated loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-chat-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const { eventStore, sessionManager } = await makeSession(dir, fixtureDir, new FakeRuntime());
    try {
      const result = await runChatTurn(sessionManager, makeTask(fixtureDir, 'Add a passing test'));
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.tokens).toBe(500);
      expect(result.toolCalls).toBe(3);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await eventStore.close();
    }
  });

  it('degrades to a failed turn when the runtime crashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-chat-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const { eventStore, sessionManager } = await makeSession(dir, fixtureDir, new CrashRuntime());
    try {
      const result = await runChatTurn(sessionManager, makeTask(fixtureDir, 'fix everything'));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('simulated chat crash');
    } finally {
      await eventStore.close();
    }
  });
});

/**
 * Drive the full `runChat` REPL through a scripted input stream, send a
 * mid-turn exit signal while the runtime is blocked in run(), then release the
 * turn. Returns everything chat.ts wrote to the console for assertion.
 */
async function runReplWithMidTurnExit(trigger: (input: PassThrough) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-chat-repl-'));
  tmpDirs.push(dir);
  const fixtureDir = join(dir, 'fixture');
  writeFixture(fixtureDir);

  const slow = new SlowRuntime();
  runtimeSlot.runtime = slow;

  // chat.ts writes its UI via console.log/console.error, not the `output`
  // stream, so capture those to assert on the shutdown output.
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  const input = new PassThrough();
  try {
    await runChat({
      repoPath: fixtureDir,
      runtime: 'core',
      model: 'fake/chat',
      maxTurns: 1,
      verificationLevel: 3,
      quiet: true,
      local: true,
      keepWorktree: true,
      worktreeBase: join(dir, 'worktrees'),
      input,
      output: new PassThrough(),
    });

    input.write('do a task\n');
    await waitFor(() => slow.started, 20_000);
    trigger(input);
    // Give readline a beat to process the exit line (or EOF) before the turn
    // resolves, so the shutdown genuinely happens while the turn is in flight.
    await new Promise((r) => setTimeout(r, 50));
    slow.release();

    await waitFor(() => lines.some((l) => l.includes('Bye.')), 20_000);
    return lines.join('\n');
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

describe('runTui — headless render harness', () => {
  it('boots the real TUI, renders a markdown reply, and reports saved tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-tui-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    // Pre-seed a capture so the ContextOps savings figure becomes available
    // once the turn lands (scored through the mocked bridge).
    const ctxDir = join(fixtureDir, '.guppy', 'context');
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, 'turn-1.json'), '{}');
    captureSlot.analyzeCaptureFile.mockReset();
    captureSlot.analyzeCaptureFile.mockResolvedValue({ tokensSaved: 10, tool: 'contextops@0.3.4' });

    runtimeSlot.runtime = new ReplyRuntime();
    const fake = new FakeTerminal();

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

    try {
      // Boot: the welcome + context bar render into the virtual screen.
      await waitFor(() => fake.text.includes('Chat mode'), 20_000);
      expect(fake.text).toContain('verify 3');

      // Type a message through the real editor input path and submit.
      for (const ch of 'fix the clamp') fake.emit(ch);
      fake.emit('\r');

      // The turn lands: the markdown reply + footer with saved tokens render.
      await waitFor(() => fake.text.includes('Fixed the clamp'), 30_000);
      expect(fake.text).toContain('completed (success)');
      expect(fake.text).toContain('saved ≈10');

      // Exit cleanly (Ctrl+C on the idle screen).
      fake.emit('\u0003');
      await tuiPromise;
    } finally {
      // Whatever happened, stop the TUI so console is restored and no timers
      // keep the process alive.
      fake.emit('\u0003');
      await Promise.race([
        tuiPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  });

  it('shows the plan/build mode indicator and swaps it with /plan and /build (S6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-tui-mode-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    runtimeSlot.runtime = new ReplyRuntime();
    const fake = new FakeTerminal();

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

    try {
      await waitFor(() => fake.text.includes('Chat mode'), 20_000);
      // Default mode: the context bar shows build, and the hint is the send hint.
      expect(fake.text).toContain('· build');
      expect(fake.text).toContain('Enter send');
      expect(fake.text).not.toContain('planning only');

      // /plan flips the indicator and swaps the hint to the plan-mode hint.
      // The harness captures the whole output buffer (every frame), so the
      // proof of a swap is ordering: the plan hint renders after the send hint.
      for (const ch of '/plan') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Plan mode —'), 10_000);
      expect(fake.text).toContain('· plan');
      expect(fake.text).toContain('planning only — no edits · /build to execute');
      expect(fake.text.lastIndexOf('planning only') > fake.text.lastIndexOf('Enter send')).toBe(true);

      // /build with nothing planned returns to build mode and restores the
      // send hint (it renders after the plan hint in the buffer).
      for (const ch of '/build') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Build mode — no plan pending'), 10_000);
      expect(fake.text).toContain('· build');
      expect(fake.text.lastIndexOf('Enter send') > fake.text.lastIndexOf('planning only')).toBe(true);

      fake.emit('\u0003');
      await tuiPromise;
    } finally {
      fake.emit('\u0003');
      await Promise.race([
        tuiPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  });

  it('plans read-only, renders the plan gate, and /build executes the plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-tui-plan-build-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    runtimeSlot.runtime = new PlanAwareRuntime();
    const fake = new FakeTerminal();

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

    try {
      await waitFor(() => fake.text.includes('Chat mode'), 20_000);

      // Enter plan mode, then submit a task: it becomes a read-only plan turn.
      for (const ch of '/plan') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Plan mode —'), 10_000);

      for (const ch of 'fix the clamp') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Plan ready — /build to execute'), 20_000);
      // The plan (not the build answer) rendered, and the indicator stayed plan.
      expect(fake.text).toContain('Read the file, then patch the clamp.');
      expect(fake.text).toContain('· plan');

      // /build approves the plan and runs it through the gated loop.
      for (const ch of '/build') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Plan executed: patched the clamp.'), 20_000);
      expect(fake.text).toContain('completed (success)');
      expect(fake.text).toContain('· build');

      fake.emit('\u0003');
      await tuiPromise;
    } finally {
      fake.emit('\u0003');
      await Promise.race([
        tuiPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  });

  it('revises a rendered plan with /edit and runs the revision on /build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-tui-edit-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    runtimeSlot.runtime = new PlanAwareRuntime();
    const fake = new FakeTerminal();

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

    try {
      await waitFor(() => fake.text.includes('Chat mode'), 20_000);

      // Produce a plan.
      for (const ch of '/plan') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Plan mode —'), 10_000);
      for (const ch of 'fix the clamp') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Plan ready — /build to execute'), 20_000);
      expect(fake.text).toContain('Read the file, then patch the clamp.');

      // Enter revise mode and hand-type a replacement plan.
      for (const ch of '/edit') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Revise the plan'), 10_000);
      expect(fake.text).toContain('revising plan — Enter to save');

      for (const ch of 'REVISED PLAN: patch math.ts only.') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('REVISED PLAN: patch math.ts only.'), 10_000);
      // The revision re-renders with the gate footer, ready to approve. The
      // buffer is cumulative, so prove the revision is the *latest* reply by
      // ordering rather than absence.
      expect(fake.text).toContain('Plan ready — /build to execute · /edit to revise');
      expect(
        fake.text.lastIndexOf('REVISED PLAN: patch math.ts only.') >
          fake.text.lastIndexOf('Read the file, then patch the clamp.'),
      ).toBe(true);

      // /build executes the revised plan through the gated loop.
      for (const ch of '/build') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => fake.text.includes('Plan executed: patched the clamp.'), 20_000);
      expect(fake.text).toContain('completed (success)');

      fake.emit('\u0003');
      await tuiPromise;

      // The revision is durable: a fresh store over the same dir sees the
      // PlanRevised event with the model-plan diff.
      const replayStore = createEventStore({ rootDir: join(fixtureDir, '.guppy', 'events') });
      let sawRevised = false;
      for (const summary of replayStore.listSessionSummaries()) {
        for await (const event of replayStore.readEvents({
          taskId: summary.taskId as never,
          sessionId: summary.sessionId as never,
          index: 0,
        })) {
          if (event.type === 'PlanRevised') {
            sawRevised = true;
            const p = event.payload as { previous: string; revised: string; diff: string };
            expect(p.previous).toBe('Read the file, then patch the clamp.');
            expect(p.revised).toBe('REVISED PLAN: patch math.ts only.');
            expect(p.diff).toContain('Read the file, then patch the clamp.');
          }
        }
      }
      expect(sawRevised).toBe(true);
      await replayStore.close();
    } finally {
      fake.emit('\u0003');
      await Promise.race([
        tuiPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  });

  it('interrupts an in-flight turn with Ctrl+C and lands a clean cancelled state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-tui-abort-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const abortable = new AbortableRuntime();
    runtimeSlot.runtime = abortable;
    const fake = new FakeTerminal();

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

    try {
      await waitFor(() => fake.text.includes('Chat mode'), 20_000);

      // Start a turn that blocks in the runtime.
      for (const ch of 'fix the clamp') fake.emit(ch);
      fake.emit('\r');
      await waitFor(() => abortable.started, 20_000);

      // Ctrl+C mid-turn: the TUI aborts the whole turn, not just defers.
      fake.emit('\u0003');
      await waitFor(() => fake.text.includes('Cancelling turn'), 5_000);

      // Release the runtime: the aborted turn lands as cancelled, and the
      // footer shows the cancelled mark (✕) rather than success.
      abortable.release();
      await waitFor(() => fake.text.includes('cancelled (interrupted)'), 20_000);
      expect(fake.text).toContain('✕');
      expect(fake.text).not.toContain('completed (success)');

      // Second Ctrl+C (idle) exits, dumping the session summary line.
      fake.emit('\u0003');
      await tuiPromise;
    } finally {
      abortable.release();
      fake.emit('\u0003');
      await Promise.race([
        tuiPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  });
});

describe('runChat REPL — mid-turn exit', () => {
  it('finishes the in-flight turn and shuts down cleanly on /exit', async () => {
    const out = await runReplWithMidTurnExit((input) => input.write('/exit\n'));
    expect(out).toContain('completed (success)');
    expect(out.match(/Bye\./g) ?? []).toHaveLength(1);
    expect(out).not.toContain('ERR_USE_AFTER_CLOSE');
    expect(out).not.toContain('ERR_STREAM_WRITE_AFTER_END');
  });

  it('finishes the in-flight turn and shuts down cleanly on stdin EOF', async () => {
    const out = await runReplWithMidTurnExit((input) => input.end());
    expect(out).toContain('completed (success)');
    expect(out.match(/Bye\./g) ?? []).toHaveLength(1);
    expect(out).not.toContain('ERR_USE_AFTER_CLOSE');
    expect(out).not.toContain('ERR_STREAM_WRITE_AFTER_END');
  });
});
