/**
 * guppy chat — interactive REPL over the SessionManager loop.
 *
 * Each message becomes a task run through the same gated loop as `guppy run`
 * (verify → retry → memory), streamed live to the terminal. Past fixes are
 * distilled into `<repo>/.guppy/memory`, so later turns are guided by what
 * earlier turns learned — the chat IS the learning loop, not a wrapper on it.
 *
 * Also hosts `buildAgentRuntime`, the shared runtime factory for the `run`
 * and `chat` CLI commands.
 */

import { createInterface } from 'node:readline';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import {
  now,
  ulid,
  type AgentRuntime,
  type Task,
  type ULID,
  type VerificationLevel,
} from '@guppy/contracts';
import type { EventStore } from '@guppy/event-store';
import { createEventStore } from '@guppy/event-store';
import type { WorkspaceManager } from '@guppy/workspace';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import { createPiAdapter, createPrimeDaemonRuntime } from '@guppy/agent-runtime';
import { createCoreRuntime } from '@guppy/core';
import type { McpBridge } from '@guppy/mcp';
import type { ModelConfig } from '@guppy/core';
import {
  THINKING_LEVELS,
  defaultConfigPath,
  describeModel,
  listModels,
  listProviders,
  loadUserConfig,
  maskKey,
  saveUserConfig,
  selectModel,
} from '@guppy/models';
import type { ThinkingLevel } from '@guppy/models';
import type { Model } from '@earendil-works/pi-ai';
import { createSessionManager, type SessionManager } from './session-manager.js';
import { attachLiveStream } from './live-stream.js';
import { analyzeCaptureFile } from '@guppy/bench-runner';

// ---------------------------------------------------------------------------
// Context-savings tracker (ContextOps token savings for run/chat)
// ---------------------------------------------------------------------------

/** Result of scoring whatever new captures appeared since the last call. */
export interface SavingsDelta {
  /** Estimated tokens saved by captures scored in this call (0 when none). */
  saved: number;
  /** Running session total. */
  total: number;
  /** True once ContextOps has successfully scored at least one capture. */
  available: boolean;
  /** Scoring tool + version, e.g. "contextops@0.3.4". */
  tool?: string;
}

/**
 * Scores the core runtime's `{ model, messages, tools }` capture dumps through
 * ContextOps (via the same bridge `@guppy/bench-runner` ships) and accumulates
 * an estimated tokens-saved total. Strictly best-effort and never fatal: if
 * Python or ContextOps is missing, scoring stops and the figure is omitted.
 */
export class ContextSavingsTracker {
  private scored = new Set<string>();
  private total = 0;
  private availableFlag = false;
  private unavailableFlag = false;
  private tool: string | undefined;

  constructor(
    private readonly dir: string,
    private readonly python = 'python',
    private readonly timeoutMs = 10_000,
  ) {}

  /** True when scoring has succeeded at least once and hasn't since failed. */
  private get available(): boolean {
    return this.availableFlag && !this.unavailableFlag;
  }

  /** Score any capture files not yet seen. Never throws. */
  async scoreNew(): Promise<SavingsDelta> {
    if (this.unavailableFlag) {
      return { saved: 0, total: this.total, available: this.available };
    }

    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => f.endsWith('.json') && !this.scored.has(f))
        .sort();
    } catch {
      // No capture dir yet (or unreadable) — nothing to score.
      return { saved: 0, total: this.total, available: this.available };
    }

    let saved = 0;
    for (const file of files) {
      this.scored.add(file);
      try {
        const analysis = await analyzeCaptureFile(join(this.dir, file), this.python, this.timeoutMs);
        saved += analysis.tokensSaved;
        this.total += analysis.tokensSaved;
        this.tool = analysis.tool;
        this.availableFlag = true;
      } catch {
        // Python / ContextOps unavailable — stop spawning doomed subprocesses.
        this.unavailableFlag = true;
        return { saved, total: this.total, available: this.available };
      }
    }

    return {
      saved,
      total: this.total,
      available: this.available,
      ...(this.tool ? { tool: this.tool } : {}),
    };
  }

  /** Running session total (0 until the first successful score). */
  get cumulative(): number {
    return this.total;
  }

  /** True once scoring has proven ContextOps is installed and working. */
  get isAvailable(): boolean {
    return this.available;
  }
}

// ---------------------------------------------------------------------------
// Runtime factory (shared by `guppy run` and `guppy chat`)
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  runtime: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  primeBinary?: string;
  wsl?: string;
  /** Sampling temperature for the core runtime. */
  temperature?: number;
  /** Max completion tokens for the core runtime. */
  maxTokens?: number;
  /** Per-request timeout in ms for the core runtime. */
  timeoutMs?: number;
  /** Stream model output (defaults to on for the CLI; `--no-stream` disables). */
  stream?: boolean;
  /** Reasoning level for catalog models with reasoning (applied via extraBody). */
  thinkingLevel?: ThinkingLevel;
  /** Model↔tool turns within one attempt (pi adapter). */
  maxTurns: number;
  /** Directory for `{ model, messages, tools }` dumps (ContextOps savings). */
  contextCaptureDir?: string;
  /**
   * Connected MCP servers whose tools join the loop (built by `@guppy/mcp`).
   * Optional and opt-in: no bridge, no external tools. The bridge is owned by
   * the caller — `createChatEngine` closes it on shutdown but never on a
   * /model rebuild, so the same external tools survive runtime switches.
   */
  mcpBridge?: McpBridge | null;
}

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
 * Build the agent runtime for the requested kind. Core is Guppy's own
 * in-process loop (the default); prime/pi are opt-in A/B baselines.
 */
export function buildAgentRuntime(
  options: RuntimeOptions,
  eventStore: EventStore,
  workspaceManager: WorkspaceManager,
): AgentRuntime {
  if (options.runtime === 'pi') {
    // Reference adapter: in-process pi-agent-core loop (A/B baseline)
    return createPiAdapter({
      eventStore,
      workspaceManager,
      defaultModel: createDefaultModel(options.model),
      maxTurns: options.maxTurns,
    });
  }
  if (options.runtime === 'prime') {
    // Opt-in: drive the external prime-agent binary headlessly.
    return createPrimeDaemonRuntime({
      eventStore,
      model: options.model,
      // Force the headless json run in-process; the shared daemon's worker
      // lifecycle is flaky on Windows (worker_auth timeouts).
      env: { PRIME_AGENT_NO_DAEMON: '1' },
      ...(options.primeBinary ? { binary: options.primeBinary } : {}),
      ...(options.wsl ? { commandPrefix: ['wsl', '-d', options.wsl, '--'] } : {}),
    });
  }
  // Default: Guppy's own in-process agent core (no pi, no prime).
  return createCoreRuntime({
    eventStore,
    workspaceManager,
    ...(options.mcpBridge?.tools && options.mcpBridge.tools.length > 0
      ? { extraTools: options.mcpBridge.tools }
      : {}),
    model: coreModelConfig(options),
    // Stream by default for the CLI; `--no-stream` turns it off. The bench
    // builds its own runtime, so it stays non-streaming unless it opts in.
    stream: options.stream !== false,
    maxTurns: 30,
    ...(options.contextCaptureDir ? { contextCaptureDir: options.contextCaptureDir } : {}),
  });
}

/**
 * Model config shared by the build runtime and the read-only plan runtime.
 * A requested thinking level maps to the provider-specific reasoning fields
 * via the catalog; unknown/non-reasoning models silently skip it.
 */
function coreModelConfig(options: RuntimeOptions): ModelConfig {
  const thinkingExtra =
    options.thinkingLevel !== undefined
      ? selectModel({
          model: options.model,
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          thinkingLevel: options.thinkingLevel,
        })?.extraBody
      : undefined;
  return {
    provider: options.provider ?? 'openai',
    model: options.model,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(thinkingExtra !== undefined ? { extraBody: thinkingExtra } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: options.retryBaseDelayMs } : {}),
    ...(options.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: options.retryMaxDelayMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

/**
 * A dedicated read-only core runtime for the plan phase (Slice 4). Always the
 * core runtime, and always read-only, so a plan can explore the repo but can
 * never edit it — regardless of which runtime (`core|prime|pi`) executes the
 * build. External (MCP) tools are dropped by the read-only filter.
 */
export function buildPlanRuntime(
  options: RuntimeOptions,
  eventStore: EventStore,
  workspaceManager: WorkspaceManager,
): AgentRuntime {
  return createCoreRuntime({
    eventStore,
    workspaceManager,
    model: coreModelConfig(options),
    stream: options.stream !== false,
    maxTurns: 30,
    readOnly: true,
    ...(options.contextCaptureDir ? { contextCaptureDir: options.contextCaptureDir } : {}),
  });
}

// ---------------------------------------------------------------------------
// One chat turn
// ---------------------------------------------------------------------------

export interface ChatTurnResult {
  ok: boolean;
  outcome?: string;
  durationMs: number;
  tokens?: number;
  toolCalls?: number;
  passes?: number;
  failures?: number;
  error?: string;
  /** The model's final prose answer, when the run produced one. */
  finalAnswer?: string;
  /** Estimated tokens saved this turn (ContextOps), when available. */
  tokensSaved?: number;
  /** Running session-total saved tokens (ContextOps), when available. */
  tokensSavedTotal?: number;
}

/**
 * Run a single chat message through the full gated loop. Never throws: a
 * crashing runtime or failed gate degrades to a result the REPL can print.
 */
export async function runChatTurn(
  sessionManager: SessionManager,
  task: Task,
  savings?: ContextSavingsTracker,
  signal?: AbortSignal,
): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  try {
    const result = await sessionManager.run(task, signal);
    const durationMs = Date.now() - startedAt;
    if (!result.ok) {
      return { ok: false, durationMs, error: result.error.message };
    }
    const t = result.value;
    // Score any new context captures (best-effort; omitted when ContextOps is
    // unavailable) so the footer can show the turn's savings and the total.
    let tokensSaved: number | undefined;
    let tokensSavedTotal: number | undefined;
    if (savings) {
      const delta = await savings.scoreNew();
      if (delta.available) {
        tokensSaved = delta.saved;
        tokensSavedTotal = delta.total;
      }
    }
    return {
      ok: true,
      outcome: t.outcome,
      durationMs,
      tokens: t.metrics.tokensTotal,
      toolCalls: t.metrics.toolCalls,
      passes: t.metrics.passes,
      failures: t.metrics.failures,
      ...(t.finalAnswer ? { finalAnswer: t.finalAnswer } : {}),
      ...(tokensSaved !== undefined ? { tokensSaved } : {}),
      ...(tokensSavedTotal !== undefined ? { tokensSavedTotal } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface PlanTurnResult {
  ok: boolean;
  /** The produced plan (markdown). Empty when the model produced no final answer. */
  plan?: string;
  /** The plan task id — the anchor for the `PlanRevised` audit trail. */
  taskId?: ULID;
  durationMs: number;
  tokens?: number;
  toolCalls?: number;
  error?: string;
  /** Estimated tokens saved this turn (ContextOps), when available. */
  tokensSaved?: number;
}

/**
 * Run a single message through the read-only plan phase (Slice 4). No gate,
 * no edits, no merge — the result is the plan text plus its telemetry. Never
 * throws: a crashing runtime degrades to a failed result the REPL can print.
 */
export async function runPlanTurn(
  sessionManager: SessionManager,
  task: Task,
  savings?: ContextSavingsTracker,
  signal?: AbortSignal,
): Promise<PlanTurnResult> {
  const startedAt = Date.now();
  try {
    const result = await sessionManager.plan(task, signal);
    const durationMs = Date.now() - startedAt;
    if (!result.ok) {
      return { ok: false, durationMs, error: result.error.message };
    }
    let tokensSaved: number | undefined;
    if (savings) {
      const delta = await savings.scoreNew();
      if (delta.available) tokensSaved = delta.saved;
    }
    return {
      ok: true,
      plan: result.value.plan,
      taskId: task.id,
      durationMs,
      tokens: result.value.trajectory.metrics.tokensTotal,
      toolCalls: result.value.trajectory.metrics.toolCalls,
      ...(tokensSaved !== undefined ? { tokensSaved } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Record the approval of a plan right before the build run executes it. The
 * event store auto-manages the session, so appending with the build task's
 * id opens that session's log and later folds the approval into its trace.
 */
export function emitPlanApproved(
  eventStore: EventStore,
  taskId: ULID,
  sessionId: ULID,
  plan: string,
): void {
  eventStore.append({
    id: ulid(),
    timestamp: now(),
    type: 'PlanApproved',
    taskId,
    sessionId,
    payload: { plan },
  });
}

/**
 * Record a human's revision of the model-produced plan as a durable event,
 * with a line diff between the two so the edit trail is auditable. Emitted
 * under the plan task's id with a fresh session (the plan session is already
 * closed; the store auto-opens a new one).
 */
export function emitPlanRevised(
  eventStore: EventStore,
  taskId: ULID,
  previous: string,
  revised: string,
): void {
  eventStore.append({
    id: ulid(),
    timestamp: now(),
    type: 'PlanRevised',
    taskId,
    sessionId: ulid(),
    payload: { previous, revised, diff: diffLines(previous, revised) },
  });
}

/**
 * A minimal LCS line diff, formatted for the event log: `  ` context,
 * `- ` removed, `+ ` added. O(n·m); fine for plan-sized text, and it degrades
 * to a coarse add/remove summary past a line threshold so a pathological
 * input can't blow the DP table.
 */
export function diffLines(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) {
    return `${a.length - 1} lines removed\n+ ${b.length - 1} lines added`;
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    out.push(`- ${a[i]}`);
    i++;
  }
  while (j < m) {
    out.push(`+ ${b[j]}`);
    j++;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The REPL
// ---------------------------------------------------------------------------

export interface ChatOptions extends RuntimeOptions {
  repoPath: string;
  maxTurns: number;
  verificationLevel: VerificationLevel;
  quiet: boolean;
  local: boolean;
  /** Keep the worktree after each turn instead of merging changes back. */
  keepWorktree: boolean;
  /** Commit-message template for merge-back; `{task}` is replaced with the task description. */
  commitMessage?: string;
  /** Merge changes back without creating git commits (files overlaid onto the repo). */
  noCommit?: boolean;
  /** With noCommit, overwrite uncommitted repo changes instead of refusing. */
  force?: boolean;
  /** Where to materialize worktrees (defaults to the workspace manager's cwd-based base). */
  worktreeBase?: string;
  /** Overridable streams so tests/CI can script stdin. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Shared construction of the runtime + session lifecycle used by both the
 * REPL and the TUI. Everything the agent loop needs (event store, sandbox
 * workspace manager, context engine, verification engine) is created exactly
 * once here, so the two front-ends can't drift apart. Model/provider/thinking
 * switches mutate `options` and then call `rebuild`, which tears down the
 * current runtime and builds a fresh one over the same store/workspace.
 */
export interface ChatEngine {
  repoPath: string;
  eventStore: EventStore;
  workspaceManager: WorkspaceManager;
  contextEngine: ContextEngine;
  verificationEngine: ReturnType<typeof createVerificationEngine>;
  /** Current runtime (rebuilt in place on /model & /thinking switches). */
  readonly agentRuntime: AgentRuntime;
  /** Current session manager (rebuilt alongside the runtime). */
  readonly sessionManager: SessionManager;
  /** Mutate runtime options, then rebuild the runtime + session in place. */
  rebuild(mutate: () => void): Promise<void>;
  /** Shut down the runtime and close the event store. */
  shutdown(): Promise<void>;
  /** Accumulates ContextOps token savings across turns (best-effort). */
  savings: ContextSavingsTracker;
}

export function createChatEngine(options: ChatOptions): ChatEngine {
  const repoPath = resolve(options.repoPath);
  // Capture the exact model payloads so the chat footer can report ContextOps
  // token savings (best-effort; the figure is omitted when scoring is
  // unavailable). A stable per-repo dir keeps filenames unique across turns.
  options.contextCaptureDir = resolve(repoPath, '.guppy', 'context');
  const savings = new ContextSavingsTracker(options.contextCaptureDir);
  const eventStore = createEventStore({ rootDir: resolve(repoPath, '.guppy', 'events') });
  const workspaceManager = createWorkspaceManager({
    dockerImage: 'guppy/executor:latest',
    useContainers: !options.local,
    ...(options.worktreeBase ? { worktreeBase: options.worktreeBase } : {}),
  });
  const contextEngine = new ContextEngine({ maxTokens: 100_000 });
  const verificationEngine = createVerificationEngine({
    eventStore,
    workspaceManager,
    projectRoot: repoPath,
    timeout: 300_000,
  });

  /** Build a session manager over the current runtime (reused on /model switch). */
  const createSession = (): SessionManager =>
    createSessionManager({
      repoPath,
      agentRuntime,
      // The plan phase gets a dedicated read-only core runtime so /plan never
      // edits the repo, whatever the build runtime is.
      planRuntime,
      contextEngine,
      verificationEngine,
      eventStore,
      // Pass the same (local-mode) workspace manager the verification engine
      // uses — otherwise the session manager silently creates a second manager
      // with Docker defaults and `--local` stops working.
      workspaceManager,
      keepWorktree: options.keepWorktree,
      ...(options.commitMessage ? { commitMessage: options.commitMessage } : {}),
      ...(options.noCommit ? { noCommit: true } : {}),
      ...(options.force ? { force: true } : {}),
      maxTurns: options.maxTurns,
    });

  let agentRuntime = buildAgentRuntime(options, eventStore, workspaceManager);
  let planRuntime = buildPlanRuntime(options, eventStore, workspaceManager);
  let sessionManager = createSession();

  return {
    repoPath,
    eventStore,
    workspaceManager,
    contextEngine,
    verificationEngine,
    get agentRuntime() {
      return agentRuntime;
    },
    get sessionManager() {
      return sessionManager;
    },
    async rebuild(mutate: () => void): Promise<void> {
      await agentRuntime.shutdown();
      await planRuntime.shutdown();
      mutate();
      agentRuntime = buildAgentRuntime(options, eventStore, workspaceManager);
      planRuntime = buildPlanRuntime(options, eventStore, workspaceManager);
      sessionManager = createSession();
    },
    async shutdown(): Promise<void> {
      await agentRuntime.shutdown();
      await planRuntime.shutdown();
      await eventStore.close();
      // MCP servers are child processes; close them or they outlive the parent.
      await options.mcpBridge?.close();
    },
    savings,
  };
}

export async function runChat(options: ChatOptions): Promise<void> {
  const engine = createChatEngine(options);
  const repoPath = engine.repoPath;
  const eventStore = engine.eventStore;

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isTty = (input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY === true;
  const detachLiveStream = options.quiet ? () => {} : attachLiveStream(eventStore);
  const rl = createInterface({ input, output, terminal: isTty });

  let verificationLevel = options.verificationLevel;
  let shuttingDown = false;
  let busy = false;
  // Plan/build mode (Slice 4): /plan turns messages into read-only plan runs;
  // /build approves the last plan and executes it through the full gated loop.
  let mode: 'plan' | 'build' = 'build';
  let pendingPlan: string | null = null;
  // The model-produced plan (the last PlanProduced), kept separate from
  // pendingPlan so a revision's diff is always against the model, not a
  // prior human edit.
  let modelPlan: string | null = null;
  let planTaskId: ULID | null = null;
  // True while the user is revising the plan by hand (the next input line is
  // captured verbatim as the revised plan, no model call).
  let editingPlan = false;

  // -------------------------------------------------------------------------
  // Model catalog commands (/models, /provider, /model)
  // -------------------------------------------------------------------------

  let activeProvider: string | undefined = options.provider;

  /** Compact token counts: 131072 → "131k", 1048576 → "1.0M". */
  const compactTokens = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

  const printProviders = (): void => {
    const providers = listProviders();
    const compatible = providers.filter((p) => p.coreCompatibleCount > 0).length;
    console.log(
      chalk.gray(
        `  ${providers.length} providers — ${compatible} serve OpenAI-compatible models (usable by the core runtime):`,
      ),
    );
    for (const p of providers) {
      const tag = p.coreCompatibleCount > 0 ? chalk.green('core') : chalk.gray('native');
      console.log(
        chalk.gray(
          `    ${p.id.padEnd(24)} ${p.name.padEnd(22)} ${String(p.modelCount).padStart(4)} models  [${tag}]`,
        ),
      );
    }
    console.log(chalk.gray('  Use /provider <id> to filter, then /models to browse.'));
  };

  const printModels = (query?: string): void => {
    const models = listModels({
      ...(activeProvider ? { provider: activeProvider } : {}),
      ...(query ? { query } : {}),
      coreCompatibleOnly: true,
      limit: 30,
    });
    const scope = activeProvider ? ` (provider ${activeProvider})` : '';
    console.log(
      chalk.gray(
        `  ${models.length} core-compatible model(s)${scope}${query ? ` matching "${query}"` : ''}:`,
      ),
    );
    for (const m of models) {
      console.log(
        chalk.gray(
          `    ${m.provider.padEnd(12)} ${m.id}  ctx ${compactTokens(m.contextWindow)}  max ${compactTokens(m.maxTokens)}${m.reasoning ? '  reasoning' : ''}`,
        ),
      );
    }
    if (models.length >= 30) console.log(chalk.gray('    … use /models <query> to narrow further'));
    console.log(
      chalk.gray(
        '  Native-only models (Anthropic / Gemini / OpenAI-responses) need an adapter — see `guppy models`.',
      ),
    );
  };

  const printConfig = (): void => {
    const path = defaultConfigPath();
    const config = loadUserConfig(path);
    console.log(chalk.gray(`  Config: ${path}`));
    const entries = Object.entries(config.providers);
    if (entries.length === 0) {
      console.log(chalk.yellow('  No providers configured. Run `guppy setup` or /setup <provider> <key>.'));
    } else {
      for (const [id, preset] of entries) {
        const parts: string[] = [];
        if (preset.apiKey) parts.push(`key ${maskKey(preset.apiKey)}`);
        if (preset.baseUrl) parts.push(`baseUrl ${preset.baseUrl}`);
        console.log(chalk.gray(`    ${id.padEnd(20)} ${parts.join(' · ') || '(no key)'}`));
      }
    }
    if (config.default) {
      console.log(chalk.gray(`    default model: ${config.default.provider}/${config.default.model}`));
    }
  };

  /** Rebuild runtime + session after a mutation (keeps memory/events). */
  const swapRuntime = (mutate: () => void): Promise<void> => engine.rebuild(mutate);

  /** Swap the active model: rebuild runtime + session while keeping memory/events. */
  async function rebuildRuntime(next: ModelConfig): Promise<void> {
    await swapRuntime(() => {
      options.model = next.model;
      options.provider = next.provider;
      if (next.baseUrl !== undefined) options.baseUrl = next.baseUrl;
      else delete options.baseUrl;
      if (next.apiKey !== undefined) options.apiKey = next.apiKey;
      else delete options.apiKey;
    });
  }

  /** Prompt unless the REPL is already shutting down (rl.prompt() throws after close). */
  const prompt = (): void => {
    if (shuttingDown) return;
    rl.prompt();
  };

  const closeResources = async (): Promise<void> => {
    detachLiveStream();
    rl.close();
    await eventStore.close();
    console.log(chalk.gray('\n[Guppy] Bye.'));
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // If a turn is mid-flight (e.g. stdin hit EOF or the user typed /exit
    // while the agent was working), defer the whole close until the turn
    // lands — otherwise the stream detaches mid-run and the finished turn
    // would prompt on a closed interface.
    if (!busy) await closeResources();
  };

  const printHelp = (): void => {
    console.log(chalk.gray('  /help              show this help'));
    console.log(chalk.gray('  /models [query]    list core-compatible models (search by id/name)'));
    console.log(chalk.gray('  /provider [id]     list providers, or set the active provider'));
    console.log(chalk.gray('  /model <id>        switch the active model mid-session'));
    console.log(chalk.gray('  /setup [p] [key]   show config, or store a provider API key'));
    console.log(
      chalk.gray('  /thinking [level]  show or set reasoning level (off|minimal|low|medium|high|xhigh|max)'),
    );
    console.log(chalk.gray('  /verify <level>    set the verification level (0-5; 6 formal = unsupported)'));
    console.log(chalk.gray('  /plan              plan a task read-only (no edits) before executing'));
    console.log(chalk.gray('  /build             approve and run the last plan, or return to build mode'));
    console.log(chalk.gray('  /edit [text]       revise the pending plan by hand, then /build to run it'));
    console.log(chalk.gray('  /exit, /quit       leave the chat'));
    console.log(chalk.gray('  anything else      run it as a task through the gated agent loop'));
  };

  const runTask = async (task: Task): Promise<void> => {
    const result = await runChatTurn(engine.sessionManager, task, engine.savings);
    if (result.ok) {
      if (result.finalAnswer) {
        console.log(`\n${result.finalAnswer}`);
      }
      const status =
        result.outcome === 'success'
          ? chalk.green(`completed (${result.outcome})`)
          : result.outcome === 'cancelled'
            ? chalk.yellow('cancelled (interrupted)')
            : chalk.yellow(`finished (${result.outcome})`);
      console.log(chalk.gray(`\n[Guppy] ${status}`));
      const savedPart =
        result.tokensSaved !== undefined
          ? `  Saved: ≈${compactTokens(result.tokensSaved)}`
          : '';
      console.log(
        chalk.gray(
          `  Duration: ${result.durationMs}ms  Tokens: ${result.tokens ?? 0}  Tool calls: ${result.toolCalls ?? 0}  ` +
            `Tests: ${result.passes ?? 0} passed / ${result.failures ?? 0} failed${savedPart}`,
        ),
      );
    } else {
      console.error(chalk.red(`\n[Guppy] Turn failed: ${result.error}`));
    }
  };

  const handleTurn = async (userInput: string): Promise<void> => {
    console.log(chalk.blue(`\n[Guppy] Working on: ${userInput}`));
    await runTask({
      id: ulid(),
      description: userInput,
      repoPath,
      tags: [],
      verificationLevel,
      createdAt: now(),
      metadata: { chat: true },
    });
  };

  const handlePlanTurn = async (userInput: string): Promise<void> => {
    console.log(chalk.blue(`\n[Guppy] Planning (read-only): ${userInput}`));
    const result = await runPlanTurn(
      engine.sessionManager,
      {
        id: ulid(),
        description: userInput,
        repoPath,
        tags: [],
        verificationLevel,
        createdAt: now(),
        metadata: { chat: true, mode: 'plan' },
      },
      engine.savings,
    );
    if (result.ok) {
      pendingPlan = result.plan ?? null;
      modelPlan = result.plan ?? null;
      planTaskId = result.taskId ?? null;
      if (result.plan) {
        console.log(`\n${result.plan}`);
        console.log(chalk.cyan('Plan ready — /build to execute · /edit to revise'));
      } else {
        console.log(
          chalk.yellow('\n[Guppy] The model produced no plan — describe the task again, or /build to leave plan mode.'),
        );
      }
      const savedPart =
        result.tokensSaved !== undefined ? `  Saved: ≈${compactTokens(result.tokensSaved)}` : '';
      console.log(
        chalk.gray(
          `  Duration: ${result.durationMs}ms  Tokens: ${result.tokens ?? 0}  Tool calls: ${result.toolCalls ?? 0}${savedPart}`,
        ),
      );
    } else {
      console.error(chalk.red(`\n[Guppy] Plan failed: ${result.error}`));
    }
  };

  /** Approve the pending plan and run it through the full gated loop. */
  const approveAndBuild = async (): Promise<void> => {
    const plan = pendingPlan;
    pendingPlan = null;
    modelPlan = null;
    planTaskId = null;
    editingPlan = false;
    const task: Task = {
      id: ulid(),
      description: plan ?? '',
      repoPath,
      tags: [],
      verificationLevel,
      createdAt: now(),
      metadata: { chat: true, approvedPlan: true },
    };
    if (plan) {
      emitPlanApproved(engine.eventStore, task.id, ulid(), plan);
      console.log(chalk.blue('\n[Guppy] Executing the approved plan…'));
      await runTask(task);
    }
  };

  console.log(chalk.blue('\n[Guppy] Chat mode — each message runs the full gated loop (verify → retry → memory).'));
  console.log(chalk.gray(`  Repo: ${repoPath}`));
  console.log(
    chalk.gray(
      `  Runtime: ${options.runtime}  Model: ${options.model}  Verification: ${verificationLevel}  Max turns: ${options.maxTurns}`,
    ),
  );
  console.log(chalk.gray('  Commands: /help  /models  /provider  /model  /verify <0-5>  /plan  /build  /exit'));
  rl.prompt();

  rl.on('line', (line) => {
    const userInput = line.trim();
    if (!userInput) {
      prompt();
      return;
    }
    // While revising, any command other than /edit cancels the capture and
    // runs normally; a bare line is captured as the revised plan below.
    if (editingPlan && userInput.startsWith('/') && userInput !== '/edit' && !userInput.startsWith('/edit ')) {
      editingPlan = false;
    }
    if (userInput === '/exit' || userInput === '/quit') {
      void shutdown();
      return;
    }
    if (userInput === '/help') {
      printHelp();
      prompt();
      return;
    }
    if (userInput.startsWith('/verify ')) {
      const level = Number(userInput.slice('/verify '.length).trim());
      if (Number.isInteger(level) && level >= 0 && level <= 5) {
        verificationLevel = level as VerificationLevel;
        console.log(chalk.gray(`  Verification level set to ${level}.`));
      } else {
        console.log(chalk.yellow('  Usage: /verify <level 0-5> (level 6 formal verification is unsupported)'));
      }
      prompt();
      return;
    }
    if (userInput === '/models' || userInput.startsWith('/models ')) {
      printModels(userInput.slice('/models '.length).trim() || undefined);
      prompt();
      return;
    }
    if (userInput === '/provider' || userInput.startsWith('/provider ')) {
      const id = userInput.slice('/provider '.length).trim();
      if (!id) {
        printProviders();
      } else {
        const provider = listProviders().find((p) => p.id === id);
        if (!provider) {
          console.log(chalk.yellow(`  Unknown provider: ${id}`));
        } else {
          activeProvider = id;
          console.log(
            chalk.gray(
              `  Provider set to ${id} (${provider.name}) — ${provider.coreCompatibleCount}/${provider.modelCount} models are core-compatible.`,
            ),
          );
        }
      }
      prompt();
      return;
    }
    if (userInput.startsWith('/model ')) {
      const id = userInput.slice('/model '.length).trim();
      if (!id) {
        console.log(chalk.yellow('  Usage: /model <model-id>'));
        prompt();
        return;
      }
      if (busy) {
        console.log(chalk.yellow('  Still working — wait for the current turn to finish before switching models.'));
        prompt();
        return;
      }
      const next = selectModel({ model: id, ...(activeProvider ? { provider: activeProvider } : {}) });
      if (!next) {
        console.log(
          chalk.yellow(
            `  No model "${id}" found${activeProvider ? ` in provider ${activeProvider}` : ''}. Use /models to search.`,
          ),
        );
        prompt();
        return;
      }
      busy = true;
      void (async () => {
        try {
          await rebuildRuntime(next);
          const desc = describeModel(next.provider, next.model);
          console.log(chalk.green(`  Model set to ${next.provider}/${next.model}`));
          if (desc) {
            console.log(
              chalk.gray(
                `    Context ${compactTokens(desc.contextWindow)}  Max output ${compactTokens(desc.maxTokens)}${desc.reasoning ? '  Reasoning' : ''}`,
              ),
            );
          }
        } catch (e) {
          console.error(chalk.red(`  Could not switch model: ${e instanceof Error ? e.message : String(e)}`));
        } finally {
          busy = false;
          if (!shuttingDown) prompt();
        }
      })();
      return;
    }
    if (userInput === '/setup' || userInput.startsWith('/setup ')) {
      const args = userInput.slice('/setup '.length).trim();
      if (args === '') {
        printConfig();
        prompt();
        return;
      }
      const space = args.indexOf(' ');
      const provider = space === -1 ? args : args.slice(0, space);
      const apiKey = space === -1 ? '' : args.slice(space + 1).trim();
      if (!apiKey) {
        console.log(chalk.yellow('  Usage: /setup (show) or /setup <provider> <api-key>'));
      } else {
        const config = loadUserConfig();
        config.providers[provider] = { ...(config.providers[provider] ?? {}), apiKey };
        saveUserConfig(config);
        console.log(chalk.green(`  Saved API key for ${provider} (${maskKey(apiKey)}).`));
      }
      prompt();
      return;
    }
    if (userInput === '/thinking' || userInput.startsWith('/thinking ')) {
      const arg = userInput.slice('/thinking '.length).trim();
      if (arg === '') {
        console.log(
          chalk.gray(`  Thinking: ${options.thinkingLevel ?? 'off'} (levels: ${THINKING_LEVELS.join('|')})`),
        );
        prompt();
        return;
      }
      if (!(THINKING_LEVELS as readonly string[]).includes(arg)) {
        console.log(chalk.yellow(`  Invalid thinking level "${arg}" — use ${THINKING_LEVELS.join('|')}.`));
        prompt();
        return;
      }
      if (busy) {
        console.log(chalk.yellow('  Still working — wait for the current turn to finish.'));
        prompt();
        return;
      }
      const level = arg as ThinkingLevel;
      busy = true;
      void (async () => {
        try {
          await swapRuntime(() => {
            if (level === 'off') delete options.thinkingLevel;
            else options.thinkingLevel = level;
          });
          console.log(chalk.green(`  Thinking set to ${level}.`));
        } catch (e) {
          console.error(
            chalk.red(`  Could not set thinking: ${e instanceof Error ? e.message : String(e)}`),
          );
        } finally {
          busy = false;
          if (!shuttingDown) prompt();
        }
      })();
      return;
    }
    if (userInput === '/plan') {
      if (mode === 'plan') {
        console.log(chalk.yellow('  Already in plan mode.'));
      } else {
        mode = 'plan';
        pendingPlan = null;
        modelPlan = null;
        planTaskId = null;
        editingPlan = false;
        console.log(
          chalk.gray('  Plan mode — messages are read-only planning turns (no edits). /build to approve and run.'),
        );
      }
      prompt();
      return;
    }
    if (userInput === '/build') {
      if (mode === 'plan' && !pendingPlan) {
        mode = 'build';
        modelPlan = null;
        planTaskId = null;
        editingPlan = false;
        console.log(chalk.gray('  Build mode — no plan pending. Describe a task to run it.'));
        prompt();
        return;
      }
      if (mode === 'build') {
        console.log(chalk.yellow('  Already in build mode.'));
        prompt();
        return;
      }
      if (busy) {
        console.log(chalk.yellow('  Still working — wait for the current turn to finish.'));
        prompt();
        return;
      }
      mode = 'build';
      busy = true;
      void (async () => {
        await approveAndBuild();
        busy = false;
        if (shuttingDown) {
          await closeResources();
        } else {
          prompt();
        }
      })();
      return;
    }
    if (userInput === '/edit' || userInput.startsWith('/edit ')) {
      if (busy) {
        console.log(chalk.yellow('  Still working — wait for the current turn to finish.'));
        prompt();
        return;
      }
      if (!pendingPlan) {
        console.log(chalk.yellow('  No plan to revise — /plan <task> to produce one first.'));
        prompt();
        return;
      }
      const inline = userInput.slice('/edit '.length).trim();
      if (inline) {
        if (planTaskId !== null && modelPlan !== null && inline !== modelPlan) {
          emitPlanRevised(engine.eventStore, planTaskId, modelPlan, inline);
        }
        pendingPlan = inline;
        editingPlan = false;
        console.log(`\n${pendingPlan}`);
        console.log(chalk.cyan('Plan ready — /build to execute · /edit to revise'));
      } else {
        editingPlan = true;
        console.log(
          chalk.gray('  Revise the plan — type your revised plan on the next line, then /build to run it.'),
        );
      }
      prompt();
      return;
    }
    if (userInput.startsWith('/')) {
      console.log(chalk.yellow(`  Unknown command: ${userInput} (try /help)`));
      prompt();
      return;
    }
    if (busy) {
      console.log(chalk.yellow('  Still working — wait for the current turn to finish.'));
      prompt();
      return;
    }
    if (editingPlan) {
      // Capture the line verbatim as the revised plan (no model call).
      editingPlan = false;
      if (planTaskId !== null && modelPlan !== null && userInput !== modelPlan) {
        emitPlanRevised(engine.eventStore, planTaskId, modelPlan, userInput);
      }
      pendingPlan = userInput;
      console.log(`\n${pendingPlan}`);
      console.log(chalk.cyan('Plan ready — /build to execute · /edit to revise'));
      prompt();
      return;
    }
    busy = true;
    void (async () => {
      if (mode === 'plan') {
        await handlePlanTurn(userInput);
      } else {
        await handleTurn(userInput);
      }
      busy = false;
      if (shuttingDown) {
        // Exit requested mid-turn (EOF or /exit) — finish the shutdown now.
        await closeResources();
      } else {
        prompt();
      }
    })();
  });

  rl.on('close', () => {
    void shutdown();
  });
}
