/**
 * Prime Daemon Runtime Adapter (primary)
 *
 * Implements AgentRuntime by driving prime-agent headlessly via its
 * `--mode json` event stream (see prime-agent/packages/coding-agent/
 * docs/json.md). prime-agent owns the LLM loop, REPL, skills and
 * subagents; Guppy supplies the task prompt, captures every event into
 * the event store, and verifies the result afterwards.
 *
 * On a Windows host the binary lives in WSL2 — set `commandPrefix` to
 * e.g. ['wsl', '-d', 'Ubuntu', '--'] and provide a WSL-visible cwd.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentRuntime,
  Checkpoint,
  Context,
  Event,
  Result,
  Task,
  Trajectory,
  ULID,
  Workspace,
} from '@guppy/contracts';
import { err, now, ok, ulid } from '@guppy/contracts';
import type { EventStore } from '@guppy/event-store';
import { PrimeTranscriptParser } from './transcript-parser.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STDERR_TAIL_BYTES = 4096;

export interface PrimeDaemonRuntimeConfig {
  eventStore: EventStore;
  /** Executable name or path. Defaults to `prime-agent`. */
  binary?: string;
  /** Prefix used to reach the binary, e.g. ['wsl', '-d', 'Ubuntu', '--']. */
  commandPrefix?: string[];
  /** `--model` pattern passed through to prime-agent. */
  model?: string;
  /** `--thinking` level passed through to prime-agent. */
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Pass `--offline` to skip startup network operations. */
  offline?: boolean;
  /** Additional CLI args inserted before the prompt. */
  extraArgs?: string[];
  /** Hard wall-clock limit for one run. */
  timeoutMs?: number;
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
}

export class PrimeDaemonRuntime implements AgentRuntime {
  private config: PrimeDaemonRuntimeConfig;
  private workspace: Workspace | null = null;
  private child: ChildProcess | null = null;

  constructor(config: PrimeDaemonRuntimeConfig) {
    this.config = config;
  }

  async initialize(workspace: Workspace): Promise<void> {
    this.workspace = workspace;
    console.log(`[PrimeDaemon] Initialized workspace: ${workspace.id}`);
  }

  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    if (!this.workspace) {
      return err(new Error('PrimeDaemonRuntime.initialize() must be called before run()'));
    }

    const sessionId = context.sessionId || ulid();
    const trajectoryId = ulid();
    const startedAt = now();
    const parser = new PrimeTranscriptParser(task.id, sessionId);
    const events: Event[] = [];
    const cwd = this.workspace.worktreePath ?? this.workspace.repoPath;

    const emit = (event: Event): void => {
      events.push(event);
      this.config.eventStore.append(event);
    };

    emit({
      id: ulid(),
      timestamp: now(),
      type: 'TaskStarted',
      taskId: task.id,
      sessionId,
      payload: { task },
    });

    const args = this.buildArgs(this.buildPrompt(task, context));
    const binary = this.config.binary ?? 'prime-agent';
    // A `.js` binary is a Node bundle (e.g. prime-agent's dist/bundle/cli.js):
    // launch it via the current Node executable. This also sidesteps Windows
    // restrictions on spawning .cmd/.bat shims directly (Node >= 22).
    const command =
      binary.endsWith('.js')
        ? [...(this.config.commandPrefix ?? []), process.execPath, binary]
        : [...(this.config.commandPrefix ?? []), binary];

    console.log(`[PrimeDaemon] Starting task in ${cwd}: ${task.description}`);

    const completion = await this.spawnAndCollect(command, args, cwd, parser, emit);

    const outcome = parser.determineOutcome(completion.exitCode);
    const metrics = parser.calculateMetrics();
    metrics.wallTimeMs = Date.now() - startedAt;

    emit({
      id: ulid(),
      timestamp: now(),
      type: 'TrajectoryCompleted',
      taskId: task.id,
      sessionId,
      payload: { outcome, metrics },
    });

    if (!completion.spawned) {
      return err(
        new Error(
          `Failed to launch prime-agent (${command.join(' ')}): ${completion.stderrTail || 'spawn error'}`
        )
      );
    }

    const trajectory: Trajectory = {
      id: trajectoryId,
      taskId: task.id,
      sessionId,
      // `events` already holds every parsed event: spawnAndCollect forwards
      // each new parser event through emit(), which pushes into this array.
      // Concatenating parser.getEvents() here would duplicate them all.
      events: [...events].sort((a, b) => a.timestamp - b.timestamp),
      outcome,
      metrics,
      startedAt,
      completedAt: now(),
    };

    if (completion.exitCode !== 0 && outcome === 'failure') {
      // Surface launch/runtime failures loudly but still hand back the
      // partial trajectory so callers can inspect captured events.
      console.error(`[PrimeDaemon] exited ${completion.exitCode}: ${completion.stderrTail}`);
    }

    return ok(trajectory);
  }

  async resume(checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    // Checkpoint/resume lands in Stage 1 (git tags + Prime session resume).
    return err(
      new Error(`PrimeDaemonRuntime.resume() is a Stage 1 deliverable (checkpoint ${checkpoint.id})`)
    );
  }

  async shutdown(): Promise<void> {
    console.log('[PrimeDaemon] Shutting down');
    this.killChild();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildArgs(prompt: string): string[] {
    const args: string[] = ['--mode', 'json'];
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.thinking) args.push('--thinking', this.config.thinking);
    if (this.config.offline) args.push('--offline');
    if (this.config.extraArgs) args.push(...this.config.extraArgs);
    args.push(prompt);
    return args;
  }

  /**
   * Build the task prompt from Guppy-selected context. File *contents* are
   * deliberately omitted — prime-agent reads the repo itself; we only pass
   * what the Context Engine decided it should know up front.
   */
  private buildPrompt(task: Task, context: Context): string {
    const parts: string[] = [`TASK: ${task.description}`];

    if (context.files.length > 0) {
      parts.push('', '=== RELEVANT FILES (selected by context engine) ===');
      for (const f of context.files) parts.push(`- ${f.path}`);
    }

    if (context.testResults.length > 0) {
      parts.push('', '=== CURRENT TEST RESULTS ===');
      for (const t of context.testResults) parts.push(`- ${t.name}: ${t.status}`);
    }

    if (context.errors.length > 0) {
      parts.push('', '=== CURRENT ERRORS ===');
      for (const e of context.errors) {
        parts.push(`- ${e.file ? `${e.file}:${e.line ?? '?'} ` : ''}${e.message}`);
      }
    }

    if (context.memories.length > 0) {
      parts.push('', '=== RELEVANT PAST EXPERIENCE ===');
      for (const m of context.memories) parts.push(`- ${m.summary}`);
    }

    parts.push(
      '',
      'Work in the current directory. Make minimal, focused changes.',
      'Run the project tests to verify your changes before finishing.'
    );

    return parts.join('\n');
  }

  private spawnAndCollect(
    command: string[],
    args: string[],
    cwd: string,
    parser: PrimeTranscriptParser,
    emit: (event: Event) => void
  ): Promise<{ exitCode: number | null; stderrTail: string; spawned: boolean }> {
    return new Promise((resolve) => {
      let stderr = '';
      let stdoutBuffer = '';
      let spawned = true;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const [cmd, ...rest] = command;
      const child = spawn(cmd!, [...rest, ...args], {
        cwd,
        env: { ...process.env, ...this.config.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const finish = (exitCode: number | null) => {
        if (timer) clearTimeout(timer);
        this.child = null;
        resolve({
          exitCode,
          stderrTail: stderr.slice(-STDERR_TAIL_BYTES),
          spawned,
        });
      };

      child.on('error', (error) => {
        spawned = false;
        stderr += `\n${error.message}`;
        finish(null);
      });

      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const before = parser.getEvents().length;
          if (parser.feedLine(line)) {
            // Forward newly produced parser events to the event store.
            const all = parser.getEvents();
            for (let i = before; i < all.length; i++) emit(all[i]!);
          }
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('close', (code) => {
        // Flush any trailing partial line.
        if (stdoutBuffer.trim()) {
          const before = parser.getEvents().length;
          if (parser.feedLine(stdoutBuffer)) {
            const all = parser.getEvents();
            for (let i = before; i < all.length; i++) emit(all[i]!);
          }
        }
        finish(code);
      });

      timer = setTimeout(() => {
        console.error(`[PrimeDaemon] Timeout after ${this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms — killing`);
        this.killChild();
      }, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
  }

  private killChild(): void {
    const child = this.child;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // Escalate if the process ignores SIGTERM (busy LLM calls, child trees).
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 5_000);
      escalate.unref();
      this.child = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPrimeDaemonRuntime(config: PrimeDaemonRuntimeConfig): PrimeDaemonRuntime {
  return new PrimeDaemonRuntime(config);
}
