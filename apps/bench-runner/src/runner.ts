/**
 * Guppy Bench — runner.
 *
 * Four configurations, same 20 tasks:
 *  - prime-raw:  PrimeDaemonRuntime with the task description only; single
 *                attempt; ground truth is the only verdict.
 *  - guppy-prime: PrimeDaemonRuntime wrapped in the closed loop — ContextEngine
 *                selects files, verification gate (unit tests) decides,
 *                failures feed back as errors/testResults on the next attempt.
 *  - guppy-pi:   same loop, but the in-process PiAgentRuntime drives the work.
 *  - guppy-core: same loop, driven by Guppy's own in-process agent core
 *                (no pi, no prime) via an OpenAI-compatible endpoint.
 *  - guppy-core-skill: identical to guppy-core, but the context engine
 *                receives skills from `--skills <dir>` (default: the
 *                installed per-user skills). The A/B pair is
 *                `guppy-core` (no skills) vs `guppy-core-skill` (skills).
 *
 * Ground truth for all configs: `node --test test/` exit code in the
 * workspace the agent edited, plus the task's optional finalCheck.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  ulid,
  now,
  type Task,
  type Context,
  type Event,
  type Memory,
  type TestResult,
  type ErrorInfo,
  type FileContent,
  type Workspace,
  type AgentRuntime,
  type Trajectory,
  type TrajectoryMetrics,
  type ULID,
} from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createMemoryStore, type MemoryStore } from '@guppy/memory';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine, loadSkills } from '@guppy/context-engine';
import { defaultSkillsDir } from '@guppy/skills';
import { createVerificationEngine } from '@guppy/verification-engine';
import {
  createPrimeDaemonRuntime,
  createPiAdapter,
} from '@guppy/agent-runtime';
import {
  createCoreRuntime,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  type ModelConfig,
} from '@guppy/core';
import type { ContextHealthSummary } from './context-health.js';
import type { Model } from '@earendil-works/pi-ai';
import { createHash } from 'node:crypto';
import {
  materializeFixture,
  runTestSuite,
  createFileReader,
  selectTasks,
  type BenchTaskSpec,
  type GateResult,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Prime binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the in-repo prime-agent bundle. The bench harness lives inside the
 * guppy workspace, so the bundle is a sibling repo (`<root>/prime-agent/…`).
 * Walk up from this module's compiled location until the bundle is found, then
 * fall back to a bare `prime-agent` (PATH lookup) — which fails loudly at
 * spawn if it is absent (see runGuppyWrapped).
 */
export function resolvePrimeBinary(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'prime-agent', 'packages', 'coding-agent', 'dist', 'bundle', 'cli.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'prime-agent';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BenchConfigKind =
  | 'prime-raw'
  | 'guppy-prime'
  | 'guppy-pi'
  | 'guppy-core'
  | 'guppy-core-skill';

export const ALL_CONFIGS: BenchConfigKind[] = [
  'prime-raw',
  'guppy-prime',
  'guppy-pi',
  'guppy-core',
  'guppy-core-skill',
];

export interface BenchOptions {
  outDir: string;
  configs: BenchConfigKind[];
  /** Filter by exact task id, kind, or id prefix. */
  taskFilter?: string[];
  model: string;
  /** Model provider for the guppy-core runtime (openai, openrouter, nvidia, …). */
  provider?: string;
  /** OpenAI-compatible API base URL for the guppy-core runtime. */
  baseUrl?: string;
  /** API key for the guppy-core runtime (provider env var used when omitted). */
  apiKey?: string;
  /** Max retries per model request for the guppy-core runtime (429/5xx/network). */
  maxRetries?: number;
  /** Initial backoff delay in ms for the guppy-core runtime. */
  retryBaseDelayMs?: number;
  /** Upper bound for a single backoff delay in ms for the guppy-core runtime. */
  retryMaxDelayMs?: number;
  /** Per-request timeout in ms for the guppy-core runtime. */
  modelTimeoutMs?: number;
  /** Client-side rate limit (requests/minute) for the guppy-core runtime. */
  requestsPerMinute?: number;
  /** Run prime-agent inside this WSL2 distro. */
  wslDistro?: string;
  /** Override the prime-agent binary name/path. */
  primeBinary?: string;
  maxAttempts: number;
  attemptTimeoutMs: number;
  /** Materialize + gate only; never invoke an LLM. */
  dryRun: boolean;
  /** Shared memory store (one per bench run) for the learning loop. */
  memory?: MemoryStore;
  /**
   * Skills dir injected into every task for the `guppy-core-skill` config
   * (default: the installed per-user skills dir). The A/B baseline is
   * `guppy-core` (no injected skills) vs `guppy-core-skill`.
   */
  skillsDir?: string;
  /** Explicit task list (dataset imports). Overrides taskFilter. */
  tasks?: BenchTaskSpec[];
  /** Python interpreter used to run ContextOps context-health scoring. */
  contextOpsPython?: string;
}

export interface AttemptRecord {
  attempt: number;
  wallTimeMs: number;
  tokens: number;
  toolCalls: number;
  verified: boolean;
  errorSummary?: string;
}

export interface TaskRunResult {
  config: BenchConfigKind;
  taskId: string;
  kind: BenchTaskSpec['kind'];
  passed: boolean;
  attempts: AttemptRecord[];
  wallTimeMs: number;
  tokensTotal: number;
  toolCalls: number;
  fixtureDir: string;
  error?: string;
  /** Context health (ContextOps CHS) across the captured payloads, when scored. */
  contextHealth?: ContextHealthSummary;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDefaultModel(modelId: string): Model<any> {
  return {
    id: modelId,
    name: modelId,
    api: 'anthropic',
    provider: 'anthropic',
    baseUrl: '',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

/**
 * Build the guppy-core ModelConfig from bench options. The retry/backoff knobs
 * are omitted when unset so the client's defaults apply.
 */
export function coreModelConfig(options: BenchOptions): ModelConfig {
  return {
    provider: options.provider ?? 'openai',
    model: options.model,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: options.retryBaseDelayMs } : {}),
    ...(options.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: options.retryMaxDelayMs } : {}),
    ...(options.modelTimeoutMs !== undefined ? { timeoutMs: options.modelTimeoutMs } : {}),
    ...(options.requestsPerMinute !== undefined
      ? { requestsPerMinute: options.requestsPerMinute }
      : {}),
  };
}

export interface RetrySettings {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Resolve the guppy-core retry/backoff settings that will actually be used —
 * explicit options win, otherwise the client's built-in defaults. This mirrors
 * the `??` resolution inside @guppy/core so reports never drift from behavior.
 */
export function effectiveRetrySettings(options: BenchOptions): RetrySettings {
  return {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
  };
}

function makeTask(spec: BenchTaskSpec, repoPath: string): Task {
  return {
    id: ulid(),
    description: spec.description,
    repoPath,
    tags: [spec.kind, 'bench'],
    verificationLevel: 3,
    createdAt: now(),
    metadata: { benchTaskId: spec.id },
  };
}

function emptyContext(task: Task): Context {
  return {
    taskId: task.id,
    sessionId: ulid(),
    files: [],
    testResults: [],
    errors: [],
    memories: [],
    skills: [],
    tokensUsed: 0,
    maxTokens: 0,
    selectedAt: now(),
    selectionReasoning: 'prime-raw baseline: no guppy context selection',
  };
}

const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.json', '.md']);

/** Read every source/test file of a fixture into FileContent entries. */
export function readWorktreeFiles(dir: string): FileContent[] {
  const files: FileContent[] = [];

  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs)) {
      if (entry === 'node_modules' || entry === '.guppy') continue;
      const childAbs = join(abs, entry);
      const childRel = rel ? posix.join(rel, entry) : entry;
      const stat = statSync(childAbs);
      if (stat.isDirectory()) {
        walk(childAbs, childRel);
      } else if (TEXT_EXTENSIONS.has(childRel.slice(childRel.lastIndexOf('.')))) {
        const content = readFileSync(childAbs, 'utf8');
        files.push({
          path: childRel,
          content,
          language: childRel.endsWith('.ts') ? 'typescript' : 'text',
          size: content.length,
          hash: createHash('sha1').update(content).digest('hex'),
        });
      }
    }
  };

  walk(dir, '');
  return files;
}

/**
 * Skills the `guppy-core-skill` config injects into every task's context.
 * Falls back to the installed per-user skills dir (the Slice 5 default).
 */
export function resolveBenchSkillsDir(options: BenchOptions): string {
  return options.skillsDir ?? defaultSkillsDir();
}

/** Build the feedback fed into the next attempt after a failed gate. */
function buildFailureFeedback(gate: GateResult): { testResults: TestResult[]; errors: ErrorInfo[] } {
  const summary = gate.output.slice(0, 4000);
  const firstLines = gate.output.split('\n').slice(0, 40).join('\n');
  return {
    testResults: [
      {
        id: ulid(),
        name: 'npm test',
        status: 'failed',
        duration: gate.durationMs,
        output: summary,
        file: 'test/',
      },
    ],
    errors: [
      {
        id: ulid(),
        message: `The verification gate failed with exit code ${gate.exitCode}. Failing test output:\n${firstLines}`,
        type: 'test',
        file: 'test/',
      },
    ],
  };
}

/**
 * Extract failing test names from node --test output so memory retrieval can
 * match "last time this test failed, the fix was X" memories.
 */
export function extractFailingTestNames(output: string): string[] {
  const names = new Set<string>();
  const failureLine = /✖\s+(.*?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = failureLine.exec(output)) !== null) {
    const name = (match[1] ?? '').trim();
    if (name) names.add(name);
  }
  // Also capture the node:test structured summary lines ("# fail N") is not
  // per-test; the ✖ lines are the reliable per-test signal.
  return [...names];
}

// ---------------------------------------------------------------------------
// Config runners
// ---------------------------------------------------------------------------

interface RuntimeHandle {
  runtime: AgentRuntime;
  workspace: Workspace;
  cleanup: () => Promise<void>;
}

async function createPrimeHandle(
  spec: BenchTaskSpec,
  cwdDir: string,
  options: BenchOptions,
  eventStore: ReturnType<typeof createEventStore>,
): Promise<RuntimeHandle> {
  const runtime = createPrimeDaemonRuntime({
    eventStore,
    model: options.model,
    timeoutMs: options.attemptTimeoutMs,
    // Run prime-agent in-process: the shared daemon's worker lifecycle is flaky
    // on Windows (worker_auth timeouts), and per-task processes are cleaner.
    env: { PRIME_AGENT_NO_DAEMON: '1' },
    binary: options.primeBinary ?? resolvePrimeBinary(),
    ...(options.wslDistro ? { commandPrefix: ['wsl', '-d', options.wslDistro, '--'] } : {}),
  });
  const workspace: Workspace = {
    id: ulid(),
    repoPath: cwdDir,
    worktreePath: cwdDir,
    createdAt: now(),
  };
  await runtime.initialize(workspace);
  return {
    runtime,
    workspace,
    cleanup: async () => {
      await runtime.shutdown();
      await eventStore.close();
    },
  };
}

/** prime-raw: one shot, no context selection, no retry, gate decides. */
async function runPrimeRaw(
  spec: BenchTaskSpec,
  fixtureDir: string,
  options: BenchOptions,
): Promise<TaskRunResult> {
  const startedAt = Date.now();
  const base: Omit<TaskRunResult, 'passed' | 'attempts'> = {
    config: 'prime-raw',
    taskId: spec.id,
    kind: spec.kind,
    wallTimeMs: 0,
    tokensTotal: 0,
    toolCalls: 0,
    fixtureDir,
  };

  if (options.dryRun) {
    const gate = await runTestSuite(fixtureDir);
    return {
      ...base,
      passed: false,
      attempts: [],
      error: gate.passed ? 'dry-run: fixture unexpectedly green' : 'dry-run: fixture red as expected',
    };
  }

  const eventStore = createEventStore({
    rootDir: join(options.outDir, 'events', 'prime-raw', spec.id),
  });
  const handle = await createPrimeHandle(spec, fixtureDir, options, eventStore);

  try {
    const task = makeTask(spec, fixtureDir);
    const attemptStart = Date.now();
    const result = await handle.runtime.run(task, emptyContext(task));
    const metrics: TrajectoryMetrics | null = result.ok ? result.value.metrics : null;

    const gate = await runTestSuite(fixtureDir);
    const reader = createFileReader(fixtureDir);
    const passed = gate.passed && (!spec.finalCheck || spec.finalCheck(reader));

    return {
      ...base,
      passed,
      attempts: [
        {
          attempt: 1,
          wallTimeMs: Date.now() - attemptStart,
          tokens: metrics?.tokensTotal ?? 0,
          toolCalls: metrics?.toolCalls ?? 0,
          verified: passed,
          ...(result.ok ? {} : { errorSummary: result.error.message }),
        },
      ],
      wallTimeMs: Date.now() - startedAt,
      tokensTotal: metrics?.tokensTotal ?? 0,
      toolCalls: metrics?.toolCalls ?? 0,
      ...(passed ? {} : { error: result.ok ? gate.output.slice(0, 1000) : result.error.message }),
    };
  } finally {
    await handle.cleanup();
  }
}

/** guppy-prime / guppy-pi / guppy-core: closed loop with context selection + verification gate. */
async function runGuppyWrapped(
  config: BenchConfigKind,
  spec: BenchTaskSpec,
  fixtureDir: string,
  options: BenchOptions,
): Promise<TaskRunResult> {
  const startedAt = Date.now();
  const memory = options.memory ?? createMemoryStore({ rootDir: join(options.outDir, 'memory') });
  const base = {
    config,
    taskId: spec.id,
    kind: spec.kind,
    wallTimeMs: 0,
    tokensTotal: 0,
    toolCalls: 0,
    fixtureDir,
  };

  const eventStore = createEventStore({
    rootDir: join(options.outDir, 'events', config, spec.id),
  });
  const workspaceManager = createWorkspaceManager({
    dockerImage: 'guppy/executor:latest',
    useContainers: false,
    worktreeBase: join(options.outDir, 'worktrees', config),
  });

  const wsResult = await workspaceManager.createWorkspace(fixtureDir);
  if (!wsResult.ok) {
    return {
      ...base,
      passed: false,
      attempts: [],
      error: `workspace creation failed: ${wsResult.error.message}`,
    };
  }
  const workspace = wsResult.value;
  const worktreeDir = workspace.worktreePath ?? fixtureDir;

  const runtime: AgentRuntime =
    config === 'guppy-pi'
      ? createPiAdapter({
          eventStore,
          workspaceManager,
          defaultModel: createDefaultModel(options.model),
          maxTurns: 30,
        })
      : config === 'guppy-core' || config === 'guppy-core-skill'
        ? createCoreRuntime({
            eventStore,
            workspaceManager,
            model: coreModelConfig(options),
            maxTurns: 30,
            contextCaptureDir: join(options.outDir, 'context', config, spec.id),
          })
        : createPrimeDaemonRuntime({
            eventStore,
            model: options.model,
            timeoutMs: options.attemptTimeoutMs,
            env: { PRIME_AGENT_NO_DAEMON: '1' },
            binary: options.primeBinary ?? resolvePrimeBinary(),
            ...(options.wslDistro ? { commandPrefix: ['wsl', '-d', options.wslDistro, '--'] } : {}),
          });

  const verifier = createVerificationEngine({
    eventStore,
    workspaceManager,
    projectRoot: worktreeDir,
    timeout: 120_000,
  });
  verifier.setWorkspace(workspace.id);

  const contextEngine = new ContextEngine();
  const task = makeTask(spec, worktreeDir);

  if (options.dryRun) {
    const gate = await runTestSuite(worktreeDir);
    // Don't leak the workspace or the open store on the early-return path.
    await workspaceManager.destroyWorkspace(workspace.id);
    await eventStore.close();
    return {
      ...base,
      passed: false,
      attempts: [],
      error: gate.passed ? 'dry-run: fixture unexpectedly green' : 'dry-run: fixture red as expected',
    };
  }

  let testResults: TestResult[] = [];
  let errors: ErrorInfo[] = [];
  let memories: Memory[] = [];
  let previousContext: Context | undefined;
  const attempts: AttemptRecord[] = [];
  const trajectories: Trajectory[] = [];
  const sessionIds: ULID[] = [];
  let passed = false;
  let tokensTotal = 0;
  let toolCalls = 0;
  let lastError = '';

  try {
    await runtime.initialize(workspace);

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      const attemptStart = Date.now();
      const availableFiles = readWorktreeFiles(worktreeDir);

      const ctxResult = contextEngine.selectContext({
        task,
        availableFiles,
        testResults,
        errors,
        memories,
        // The skill A/B: `guppy-core-skill` swaps the (empty) fixture skills
        // for the injected skills dir — literally "skills vs none".
        skills:
          config === 'guppy-core-skill'
            ? loadSkills(resolveBenchSkillsDir(options))
            : loadSkills(join(fixtureDir, '.guppy', 'skills')),
        ...(previousContext ? { previousContext } : {}),
      });
      if (!ctxResult.ok) {
        throw new Error(`context selection failed: ${ctxResult.error.message}`);
      }
      const context = ctxResult.value;
      sessionIds.push(context.sessionId);

      const runResult = await runtime.run(task, context);
      if (!runResult.ok) {
        // A runtime failure (e.g. prime-agent binary not found) is a hard
        // infrastructure error: retrying can't help, and recording the gate's
        // red output as the failure hides the real cause. Fail loudly.
        lastError = runResult.error.message;
        console.error(chalk.red(`    ${config} runtime failed on attempt ${attempt}: ${lastError}`));
        attempts.push({
          attempt,
          wallTimeMs: Date.now() - attemptStart,
          tokens: 0,
          toolCalls: 0,
          verified: false,
          errorSummary: lastError.slice(0, 300),
        });
        break;
      }
      const trajectory = runResult.value;
      const metrics = trajectory.metrics;

      // A failure trajectory with zero successful model calls (no ModelCalled
      // event, 0 tokens) means the model client threw after exhausting its
      // retries — an infrastructure error (e.g. 429 rate limit), not an agent
      // outcome. Surface it loudly; running the gate here would mask the real
      // cause with the gate's red output (the silent 0-token-failure bug).
      if (trajectory.outcome === 'failure' && trajectory.error && metrics.tokensTotal === 0 && metrics.toolCalls === 0) {
        lastError = trajectory.error;
        console.error(chalk.red(`    ${config} model error on attempt ${attempt}: ${lastError}`));
        attempts.push({
          attempt,
          wallTimeMs: Date.now() - attemptStart,
          tokens: 0,
          toolCalls: 0,
          verified: false,
          errorSummary: lastError.slice(0, 300),
        });
        break;
      }

      trajectories.push(trajectory);
      tokensTotal += metrics.tokensTotal;
      toolCalls += metrics.toolCalls;

      // Verification gate: level 3 (unit tests) is the Stage-0 verdict.
      const gateResult = await verifier.verify(3, context, task);
      const verified = gateResult.ok && gateResult.value.passed;

      if (verified) {
        const reader = createFileReader(worktreeDir);
        if (!spec.finalCheck || spec.finalCheck(reader)) {
          attempts.push({
            attempt,
            wallTimeMs: Date.now() - attemptStart,
            tokens: metrics?.tokensTotal ?? 0,
            toolCalls: metrics?.toolCalls ?? 0,
            verified: true,
          });
          passed = true;
          break;
        }
        lastError = 'verification gate passed but the task acceptance check failed';
      } else {
        const messages = gateResult.ok
          ? gateResult.value.errors.map((e) => e.message).join('\n')
          : gateResult.error.map((e) => e.message).join('\n');
        lastError = messages.slice(0, 1000);
      }

      // Feed failure evidence back into the next context selection.
      const rich = await runTestSuite(worktreeDir);
      const feedback = verified
        ? {
            testResults: [
              {
                id: ulid(),
                name: 'acceptance check',
                status: 'failed' as const,
                duration: 0,
                output: lastError,
              },
            ],
            errors: [
              {
                id: ulid(),
                message: `${lastError}. Re-read the task requirements and complete the missing part.`,
                type: 'verification' as const,
              },
            ],
          }
        : buildFailureFeedback(rich);
      testResults = feedback.testResults;
      errors = feedback.errors;
      previousContext = context;

      // Learning loop: pull past fixes for the tests that just failed.
      const failingNames = extractFailingTestNames(rich.output);
      const retrieved = failingNames.flatMap((name) => memory.retrieveForFailure(name));
      const seen = new Set<string>();
      memories = retrieved
        .filter((s) => (seen.has(s.memory.id) ? false : (seen.add(s.memory.id), true)))
        .map((s) => s.memory);

      attempts.push({
        attempt,
        wallTimeMs: Date.now() - attemptStart,
        tokens: metrics?.tokensTotal ?? 0,
        toolCalls: metrics?.toolCalls ?? 0,
        verified: false,
        errorSummary: lastError.slice(0, 300),
      });

      console.log(
        chalk.yellow(`    attempt ${attempt}/${options.maxAttempts} failed: ${lastError.slice(0, 120)}`),
      );
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    // Distill this run's trajectory into memory before tearing down, so the
    // next task (or next bench run on the same store) can retrieve the fixes.
    await eventStore.close();

    // Gate outcomes (TestFailed/TestPassed) are emitted by the verifier into
    // the event store, not the runtime trajectories — reload the persisted
    // events so extractFixes sees the full failure -> change -> pass sequence.
    const reader = createEventStore({
      rootDir: join(options.outDir, 'events', config, spec.id),
    });
    const persistedEvents: Event[] = [];
    for (const sessionId of new Set(sessionIds)) {
      const persisted = await reader.getTrajectory(task.id, sessionId);
      if (persisted) persistedEvents.push(...persisted.events);
    }
    await reader.close();

    if (trajectories.length > 0 || persistedEvents.length > 0) {
      const first = trajectories[0];
      // The runtime's trajectory events are already in the store (runtimes
      // append every event), so dedupe by id — concatenating both copies
      // would double-count them in the distilled trajectory.
      const seen = new Set<string>();
      const mergedEvents = [...trajectories.flatMap((t) => t.events), ...persistedEvents]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      const merged: Trajectory = {
        id: first?.id ?? ulid(),
        taskId: task.id,
        sessionId: first?.sessionId ?? (sessionIds[0] ?? ulid()),
        events: mergedEvents,
        outcome: passed ? 'success' : 'failure',
        metrics: first
          ? {
              ...first.metrics,
              wallTimeMs: Date.now() - startedAt,
              tokensTotal,
              toolCalls,
              passes: trajectories.reduce((acc, t) => acc + t.metrics.passes, 0),
              failures: trajectories.reduce((acc, t) => acc + t.metrics.failures, 0),
            }
          : {
              passes: 0,
              failures: 0,
              tokensTotal,
              tokensByModel: {},
              wallTimeMs: Date.now() - startedAt,
              toolCalls,
              checkpoints: 0,
              contextSelections: 0,
              verificationEscalations: 0,
            },
        startedAt: first?.startedAt ?? now(),
        completedAt: now(),
      };
      memory.ingestTrajectory(merged);
    }
    await runtime.shutdown();
    // Bench runs are disposable — reclaim the worktree copy so 20 tasks x
    // N configs don't accumulate under outDir/worktrees.
    await workspaceManager.destroyWorkspace(workspace.id);
  }

  return {
    ...base,
    passed,
    attempts,
    wallTimeMs: Date.now() - startedAt,
    tokensTotal,
    toolCalls,
    ...(passed ? {} : { error: lastError }),
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runSingle(
  config: BenchConfigKind,
  spec: BenchTaskSpec,
  options: BenchOptions,
): Promise<TaskRunResult> {
  // Dataset imports arrive pre-materialized (fixtureDir); builtin specs get
  // written from base files + mutations as before.
  const fixtureDir = spec.fixtureDir ?? join(options.outDir, 'fixtures', config, spec.id);
  if (!spec.fixtureDir) materializeFixture(spec, fixtureDir);

  console.log(chalk.cyan(`\n[${config}] ${spec.id} (${spec.kind})`));

  if (config === 'prime-raw') {
    return runPrimeRaw(spec, fixtureDir, options);
  }
  return runGuppyWrapped(config, spec, fixtureDir, options);
}

export async function runBench(options: BenchOptions): Promise<TaskRunResult[]> {
  const tasks = options.tasks ?? selectTasks(options.taskFilter);
  if (tasks.length === 0) {
    throw new Error('no tasks matched the filter');
  }

  // One memory store per bench run, shared across configs and tasks so the
  // learning loop compounds within a run and persists under --out.
  const opts: BenchOptions = options.memory
    ? options
    : { ...options, memory: createMemoryStore({ rootDir: join(options.outDir, 'memory') }) };

  const results: TaskRunResult[] = [];
  for (const config of options.configs) {
    for (const spec of tasks) {
      try {
        const result = await runSingle(config, spec, opts);
        results.push(result);
        console.log(
          result.passed
            ? chalk.green(`  PASS ${spec.id} (${result.attempts.length} attempt(s))`)
            : chalk.red(`  FAIL ${spec.id}: ${(result.error ?? 'unknown').slice(0, 120)}`),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(chalk.red(`  ERROR ${spec.id}: ${message}`));
        results.push({
          config,
          taskId: spec.id,
          kind: spec.kind,
          passed: false,
          attempts: [],
          wallTimeMs: 0,
          tokensTotal: 0,
          toolCalls: 0,
          fixtureDir: join(options.outDir, 'fixtures', config, spec.id),
          error: message,
        });
      }
    }
  }
  return results;
}
