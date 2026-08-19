/**
 * Guppy CLI — Main entry point
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ulid, now } from '@guppy/contracts';
import type { Task, VerificationLevel } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine, loadSkills, parseSkillMarkdown, saveSkill, slug } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import {
  BUILTIN_REGISTRY,
  defaultSkillsDir,
  installSkill,
  listInstalledSkills,
  loadRegistry,
  removeSkill,
} from '@guppy/skills';
import {
  THINKING_LEVELS,
  defaultConfigPath,
  hasAnyApiKey,
  isNoKeyProvider,
  listModels,
  listProviders,
  loadUserConfig,
  maskKey,
  resolveRuntimeOptions,
  saveUserConfig,
  selectModel,
} from '@guppy/models';
import type { ThinkingLevel } from '@guppy/models';
import {
  ALL_CONFIGS,
  analyzeContextCaptures,
  attachContextHealth,
  effectiveRetrySettings,
  loadDataset,
  runBench,
  selectTasks,
  writeReport,
  type BenchConfigKind,
  type DatasetSource,
} from '@guppy/bench-runner';
import {
  addMcpServer,
  connectMcpServers,
  defaultMcpConfigPath,
  loadMcpConfig,
  removeMcpServer,
  type McpBridge,
} from '@guppy/mcp';
import { createSessionManager } from './session-manager.js';
import { latestCheckpoint } from './checkpoint.js';
import { attachLiveStream } from './live-stream.js';
import { buildAgentRuntime, runChat, type RuntimeOptions } from './chat.js';
import { runTui } from './tui.js';
import { runLaunchPicker, runSetupWizard } from './pickers.js';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

const program = new Command();

program
  .name('guppy')
  .description('Next-gen agent harness for long-horizon software engineering')
  .version('1.0.0');

/** Parse a numeric CLI option into a finite number, or undefined when absent/invalid. */
function optNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the -v verification level. Level 6 (formal verification / Dafny) has
 * no tooling set up yet — reject it loudly instead of silently never running
 * a gate, which is what requesting it would otherwise do.
 */
function parseVerificationLevel(value: string): VerificationLevel {
  const level = parseInt(value, 10);
  if (!Number.isInteger(level) || level < 0 || level > 5) {
    console.error(
      chalk.red(
        `[Guppy] Invalid verification level "${value}": use 0-5 (level 6 formal verification is not supported yet).`,
      ),
    );
    process.exit(1);
  }
  return level as VerificationLevel;
}

/** Parse the --thinking flag, rejecting unknown levels loudly. */
function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined || value === '') return undefined;
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
  console.error(
    chalk.red(`[Guppy] Invalid thinking level "${value}": use ${THINKING_LEVELS.join('|')}.`),
  );
  process.exit(1);
}

/** Print the per-user provider config with keys masked. */
function printUserConfig(): void {
  const path = defaultConfigPath();
  const config = loadUserConfig(path);
  console.log(chalk.blue(`[Guppy] Config: ${path}`));
  const entries = Object.entries(config.providers);
  if (entries.length === 0) {
    console.log(chalk.yellow('  No providers configured. Run `guppy setup` to add one.'));
  } else {
    for (const [id, preset] of entries) {
      const parts: string[] = [];
      if (preset.apiKey) parts.push(`key ${maskKey(preset.apiKey)}`);
      if (preset.baseUrl) parts.push(`baseUrl ${preset.baseUrl}`);
      console.log(chalk.gray(`  ${id.padEnd(20)} ${parts.join(' · ') || '(no key)'}`));
    }
  }
  if (config.default) {
    console.log(chalk.gray(`  default model: ${config.default.provider}/${config.default.model}`));
  }
}

/**
 * A prompt queue over one readline interface. The `line` listener is
 * registered once, up front, so lines already buffered in a piped stdin are
 * queued rather than lost between `await`ed prompts (rl.question() drops them).
 */
function createPrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const buffer: string[] = [];
  const pending: Array<{ resolve: (line: string) => void }> = [];
  rl.on('line', (line) => {
    const waiter = pending.shift();
    if (waiter) waiter.resolve(line);
    else buffer.push(line);
  });
  rl.on('close', () => {
    while (pending.length > 0) pending.shift()!.resolve('');
  });
  return {
    ask(question: string): Promise<string> {
      process.stdout.write(question);
      if (buffer.length > 0) return Promise.resolve(buffer.shift()!);
      return new Promise((resolve) => pending.push({ resolve }));
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * Redirect a first run with no usable API key to onboarding instead of a dead
 * `claude-3-5-sonnet` fallback (Track C). An explicit --model/--provider/
 * --api-key/--base-url bypasses the gate — the user is choosing an endpoint,
 * so its auth is their call. A configured default pointing at a keyless local
 * provider (ollama, etc.) also bypasses it.
 */
function ensureKeyConfigured(options: CommanderRuntimeOptions): void {
  if (
    options.model !== undefined ||
    options.provider !== undefined ||
    options.apiKey !== undefined ||
    options.baseUrl !== undefined
  ) {
    return;
  }
  const config = loadUserConfig();
  if (hasAnyApiKey(config)) return;
  if (isNoKeyProvider(resolveRuntimeOptions({}, config).provider)) return;
  console.error(chalk.yellow('[Guppy] No API key configured.'));
  console.error(
    chalk.gray('  Run `guppy setup` to add a provider key, or pass --provider/--model/--api-key.'),
  );
  console.error(chalk.gray('  Local models need no key: `guppy chat --provider ollama`.'));
  process.exit(1);
}

/** Commander option shape shared by `run` and `chat` (runtime-affecting flags). */
interface CommanderRuntimeOptions {
  runtime: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string;
  maxRetries?: string;
  retryBaseDelay?: string;
  retryMaxDelay?: string;
  temperature?: string;
  maxTokens?: string;
  modelTimeoutMs?: string;
  stream?: boolean;
  primeBinary?: string;
  wsl?: string;
  maxHistoryTokens?: string;
  historySummary?: string;
  maxTurns: string;
}

/** Normalize commander flags into the runtime factory's strict option shape. */
function toRuntimeOptions(options: CommanderRuntimeOptions): RuntimeOptions {
  const maxRetries = optNumber(options.maxRetries);
  const retryBaseDelayMs = optNumber(options.retryBaseDelay);
  const retryMaxDelayMs = optNumber(options.retryMaxDelay);
  const temperature = optNumber(options.temperature);
  const maxTokens = optNumber(options.maxTokens);
  const timeoutMs = optNumber(options.modelTimeoutMs);
  const thinkingLevel = parseThinkingLevel(options.thinking);
  // Resolve provider/model/baseUrl/apiKey precedence: an explicit CLI flag
  // wins, then the per-user config preset (key/baseUrl + default model), then
  // the runtime's own env-var resolution.
  const resolved = resolveRuntimeOptions(
    {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    },
    loadUserConfig(),
  );
  return {
    runtime: options.runtime,
    model: resolved.model,
    ...(resolved.provider !== undefined ? { provider: resolved.provider } : {}),
    ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
    ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(retryBaseDelayMs !== undefined ? { retryBaseDelayMs } : {}),
    ...(retryMaxDelayMs !== undefined ? { retryMaxDelayMs } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(options.stream === false ? { stream: false } : {}),
    ...(options.primeBinary ? { primeBinary: options.primeBinary } : {}),
    ...(options.wsl ? { wsl: options.wsl } : {}),
    ...(options.maxHistoryTokens !== undefined
      ? { maxHistoryTokens: optNumber(options.maxHistoryTokens) ?? 60_000 }
      : {}),
    ...(options.historySummary === 'llm' ? { historySummary: true } : {}),
    maxTurns: parseInt(options.maxTurns, 10),
  };
}

/**
 * Connect the registered MCP servers for a run/chat session. Returns null
 * when disabled (`--no-mcp`) or nothing is registered. A broken server is
 * logged and skipped, never fatal. The caller owns the returned bridge and
 * must close it (MCP servers are child processes and would outlive the CLI).
 */
async function connectMcpForCli(options: { noMcp?: boolean; cwd: string }): Promise<McpBridge | null> {
  if (options.noMcp) return null;
  const config = loadMcpConfig();
  const names = Object.keys(config.mcpServers);
  if (names.length === 0) return null;
  const bridge = await connectMcpServers(config, {
    // Sandbox layer 2: servers start inside the repo, not wherever the CLI
    // was launched, so relative file operations stay in the workspace.
    cwd: options.cwd,
    log: (message) => console.log(chalk.gray(message)),
  });
  if (bridge.connected > 0) {
    console.log(
      chalk.gray(
        `[Guppy] MCP: ${bridge.connected} server(s) connected · ${bridge.tools.length} external tool(s) available.`,
      ),
    );
  }
  if (bridge.failed > 0) {
    console.log(
      chalk.yellow(`[Guppy] MCP: ${bridge.failed} server(s) failed to connect (see logs above) — guppy mcp list to inspect.`),
    );
  }
  return bridge;
}

program
  .command('run [task]')
  .description('Run a coding task in a repository')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-m, --model <model>', 'Model id (default: ~/.guppy/config.json default, else claude-3-5-sonnet)')
  .option('--provider <name>', 'Model provider for the core runtime (openai, openrouter, nvidia, …)')
  .option('--base-url <url>', 'OpenAI-compatible API base URL for the core runtime')
  .option('--api-key <key>', 'API key for the core runtime (provider env var used when omitted)')
  .option('--max-retries <number>', 'Max retries per model request for the core runtime (429/5xx/network)')
  .option('--retry-base-delay <ms>', 'Initial backoff delay in ms for the core runtime')
  .option('--retry-max-delay <ms>', 'Max single backoff delay in ms for the core runtime')
  .option('--temperature <number>', 'Sampling temperature for the core runtime')
  .option('--max-tokens <number>', 'Max completion tokens for the core runtime')
  .option('--model-timeout-ms <ms>', 'Per-request timeout in ms for the core runtime')
  .option('--thinking <level>', `Reasoning level for catalog models with reasoning (${THINKING_LEVELS.join('|')})`)
  .option('--no-stream', 'Disable streaming model output (wait for the full response)')
  .option('-t, --max-turns <number>', 'Maximum turns', '20')
  .option('-v, --verification <level>', 'Verification level (0-5; 6 formal = unsupported)', '3')
  .option('--runtime <kind>', 'Agent runtime: core | prime | pi', 'core')
  .option('--wsl <distro>', 'Run prime-agent inside this WSL2 distro (Windows hosts)')
  .option('--prime-binary <path>', 'prime-agent executable (defaults to `prime-agent` on PATH)')
  .option('--local', 'Run without Docker (host execution, plain worktrees)')
  .option('--max-history-tokens <n>', 'History-token budget before older turns are compressed into a recap (0 = never compress)', '60000')
  .option('--history-summary <mode>', "Summarize the compressed history with an LLM ('llm') or keep the deterministic recap ('none')", 'none')
  .option('--keep-worktree', 'Keep the worktree after the run instead of merging changes back')
  .option('--commit-message <template>', 'Commit-message template for merge-back ({task} placeholder)', 'guppy: apply agent changes')
  .option('--no-commit', 'Merge changes back without creating git commits (files overlaid onto the repo)')
  .option('--force', 'With --no-commit, overwrite uncommitted repo changes (dangerous)')
  .option('-q, --quiet', 'Suppress live event streaming (summary only)')
  .option('--resume', 'Resume the most recent interrupted run in this repo')
  .option('--no-mcp', 'Do not load registered MCP servers')
  .action(async (taskDescription, options) => {
    ensureKeyConfigured(options);
    const repoPath = resolve(options.repo);
    const runtimeOptions = toRuntimeOptions(options);
    // Load registered MCP servers so their tools join the loop (opt-out with
    // --no-mcp). The bridge must be closed before the process exits.
    const mcpBridge = await connectMcpForCli({ noMcp: options.noMcp, cwd: repoPath });
    if (mcpBridge) runtimeOptions.mcpBridge = mcpBridge;
    // Capture the exact model payloads so the run summary can report ContextOps
    // token savings (best-effort; omitted when scoring is unavailable).
    runtimeOptions.contextCaptureDir = resolve(repoPath, '.guppy', 'context');
    const resumeCheckpoint = options.resume ? latestCheckpoint(repoPath) : null;

    if (options.resume && !resumeCheckpoint) {
      console.error(chalk.red(`[Guppy] No checkpoint found under ${repoPath}/.guppy/checkpoints to resume.`));
      process.exit(1);
    }
    if (!options.resume && !taskDescription) {
      console.error(chalk.red('[Guppy] A task description is required (or pass --resume to continue a previous run).'));
      process.exit(1);
    }

    const task: Task = resumeCheckpoint
      ? resumeCheckpoint.task
      : {
          id: ulid(),
          description: taskDescription,
          repoPath,
          tags: [],
          verificationLevel: parseVerificationLevel(options.verification),
          createdAt: now(),
          metadata: {},
        };

    console.log(chalk.blue(resumeCheckpoint ? '[Guppy] Resuming...' : '[Guppy] Initializing...'));
    console.log(chalk.gray(`  Repo: ${repoPath}`));
    console.log(chalk.gray(`  Task: ${task.description}`));
    console.log(chalk.gray(`  Runtime: ${options.runtime}`));
    console.log(chalk.gray(`  Model: ${runtimeOptions.model}`));
    console.log(chalk.gray(`  Max turns: ${resumeCheckpoint?.maxTurns ?? options.maxTurns}`));
    console.log(chalk.gray(`  Verification: ${task.verificationLevel}`));
    if (resumeCheckpoint) {
      console.log(chalk.gray(`  Resume: attempt ${resumeCheckpoint.attemptsCompleted + 1}/${resumeCheckpoint.maxTurns}`));
    }

    // Initialize components
    const eventStore = createEventStore({
      rootDir: resolve(repoPath, '.guppy', 'events'),
    });

    // Live-stream every event the runtimes and verification engine append
    // (tool calls, model turns, gate results) so a run is watchable. The
    // store is the single funnel, so this covers core/prime/pi and --resume.
    const detachLiveStream = options.quiet ? () => {} : attachLiveStream(eventStore);

    const workspaceManager = createWorkspaceManager({
      dockerImage: 'guppy/executor:latest',
      useContainers: !options.local,
    });

    // Fail loudly (and helpfully) when the sandbox can't run: an obscure
    // dockerode error mid-run is the worst possible DX for a missing daemon
    // or unbuilt image.
    const probe = await workspaceManager.probeContainerRuntime();
    if (!probe.ok) {
      console.error(chalk.red(`[Guppy] ${probe.reason}.`));
      process.exit(1);
    }

    const contextEngine = new ContextEngine({
      maxTokens: 100_000,
    });

    const verificationEngine = createVerificationEngine({
      eventStore,
      workspaceManager,
      projectRoot: repoPath,
      timeout: 300_000,
    });

    const agentRuntime = buildAgentRuntime(runtimeOptions, eventStore, workspaceManager);

    // Pass the same event store and workspace manager the runtime and
    // verification engine already use; otherwise the session manager silently
    // creates its own (a second store under `.guppy/events`, and a workspace
    // manager with Docker defaults — which breaks `--local`).
    const sessionManager = createSessionManager({
      repoPath,
      agentRuntime,
      contextEngine,
      verificationEngine,
      eventStore,
      workspaceManager,
      keepWorktree: options.keepWorktree,
      ...(options.commitMessage !== 'guppy: apply agent changes' ? { commitMessage: options.commitMessage } : {}),
      // commander parses `--no-commit` as the negation of `commit`.
      ...(options.commit === false ? { noCommit: true } : {}),
      ...(options.force ? { force: true } : {}),
      maxTurns: resumeCheckpoint?.maxTurns ?? parseInt(options.maxTurns, 10),
    });

    console.log(chalk.green(resumeCheckpoint ? '[Guppy] Resuming task...' : '[Guppy] Starting task...'));

    const startTime = Date.now();
    const result = resumeCheckpoint
      ? await sessionManager.resumeTask(resumeCheckpoint)
      : await sessionManager.run(task);
    const duration = Date.now() - startTime;

    detachLiveStream();

    // ContextOps token savings (best-effort): score the captures this run
    // produced and surface the estimate only when scoring actually worked.
    const contextHealth = await analyzeContextCaptures(resolve(repoPath, '.guppy', 'context'));
    const savedTokens =
      contextHealth && !contextHealth.skipped ? contextHealth.tokensSaved : undefined;

    if (result.ok) {
      const trajectory = result.value;
      console.log(chalk.green('\n[Guppy] Task completed!'));
      console.log(chalk.gray(`  Outcome: ${trajectory.outcome}`));
      console.log(chalk.gray(`  Duration: ${duration}ms`));
      console.log(chalk.gray(`  Tokens: ${trajectory.metrics.tokensTotal}`));
      console.log(chalk.gray(`  Tool calls: ${trajectory.metrics.toolCalls}`));
      console.log(chalk.gray(`  Tests passed: ${trajectory.metrics.passes}`));
      console.log(chalk.gray(`  Tests failed: ${trajectory.metrics.failures}`));
      if (savedTokens !== undefined) {
        console.log(chalk.gray(`  Context savings (ContextOps, est.): ≈${savedTokens}`));
      }
    } else {
      console.error(chalk.red('\n[Guppy] Task failed:'), result.error.message);
      await mcpBridge?.close();
      process.exit(1);
    }
    await mcpBridge?.close();
  });

program
  .command('chat')
  .description('Interactive chat over the agent loop (each message is a gated task run)')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-m, --model <model>', 'Model id (default: ~/.guppy/config.json default, else claude-3-5-sonnet)')
  .option('--provider <name>', 'Model provider for the core runtime (openai, openrouter, nvidia, …)')
  .option('--base-url <url>', 'OpenAI-compatible API base URL for the core runtime')
  .option('--api-key <key>', 'API key for the core runtime (provider env var used when omitted)')
  .option('--max-retries <number>', 'Max retries per model request for the core runtime (429/5xx/network)')
  .option('--retry-base-delay <ms>', 'Initial backoff delay in ms for the core runtime')
  .option('--retry-max-delay <ms>', 'Max single backoff delay in ms for the core runtime')
  .option('--temperature <number>', 'Sampling temperature for the core runtime')
  .option('--max-tokens <number>', 'Max completion tokens for the core runtime')
  .option('--model-timeout-ms <ms>', 'Per-request timeout in ms for the core runtime')
  .option('--thinking <level>', `Reasoning level for catalog models with reasoning (${THINKING_LEVELS.join('|')})`)
  .option('--no-stream', 'Disable streaming model output (wait for the full response)')
  .option('--max-history-tokens <n>', 'History-token budget before older turns are compressed into a recap (0 = never compress)', '60000')
  .option('--history-summary <mode>', "Summarize the compressed history with an LLM ('llm') or keep the deterministic recap ('none')", 'none')
  .option('-t, --max-turns <number>', 'Maximum turns', '20')
  .option('-v, --verification <level>', 'Verification level (0-5; 6 formal = unsupported)', '3')
  .option('--runtime <kind>', 'Agent runtime: core | prime | pi', 'core')
  .option('--wsl <distro>', 'Run prime-agent inside this WSL2 distro (Windows hosts)')
  .option('--prime-binary <path>', 'prime-agent executable (defaults to `prime-agent` on PATH)')
  .option('--local', 'Run without Docker (host execution, plain worktrees)')
  .option('--keep-worktree', 'Keep the worktree after each turn instead of merging changes back')
  .option('--commit-message <template>', 'Commit-message template for merge-back ({task} placeholder)', 'guppy: apply agent changes')
  .option('--no-commit', 'Merge changes back without creating git commits (files overlaid onto the repo)')
  .option('--force', 'With --no-commit, overwrite uncommitted repo changes (dangerous)')
  .option('-q, --quiet', 'Suppress live event streaming (summary only)')
  .option('--no-mcp', 'Do not load registered MCP servers')
  .option('--tui', 'Use the fullscreen terminal interface (default when stdin/stdout are TTYs)')
  .option('--no-tui', 'Use the line-based REPL instead of the fullscreen TUI')
  .action(async (options) => {
    // Fullscreen TUI on an interactive terminal; the REPL everywhere else
    // (piped stdin, scripts, CI). `--tui` / `--no-tui` force either way.
    const useTui = options.tui ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

    // M2 launch picker: on an interactive terminal with nothing explicitly
    // chosen (no --model/--provider/--base-url/--api-key), guide the user
    // through arrow-key pickers instead of falling back to a dead model id.
    // No key at all → run the setup wizard inline. Key but no default model →
    // pick provider + live model. Both persist the choice as the default so
    // the next launch is frictionless.
    if (useTui) {
      const config = loadUserConfig();
      const explicit =
        options.model !== undefined ||
        options.provider !== undefined ||
        options.baseUrl !== undefined ||
        options.apiKey !== undefined;
      if (!explicit && !hasAnyApiKey(config) && !isNoKeyProvider(resolveRuntimeOptions({}, config).provider)) {
        const picked = await runSetupWizard();
        if (!picked) {
          console.log(chalk.yellow('[Guppy] Setup cancelled — nothing saved.'));
          process.exit(0);
        }
        const next = loadUserConfig();
        next.providers[picked.provider] = {
          ...(next.providers[picked.provider] ?? {}),
          ...(picked.apiKey !== undefined ? { apiKey: picked.apiKey } : {}),
          ...(picked.baseUrl !== undefined ? { baseUrl: picked.baseUrl } : {}),
        };
        next.default = { provider: picked.provider, model: picked.model };
        saveUserConfig(next);
        console.log(chalk.green(`\n[Guppy] Saved ${picked.provider} → default ${picked.provider}/${picked.model}`));
      } else if (!explicit && !config.default) {
        const picked = await runLaunchPicker(new ProcessTerminal(), config);
        if (!picked) {
          console.log(chalk.yellow('[Guppy] No model selected — exiting.'));
          process.exit(0);
        }
        options.model = picked.model;
        options.provider = picked.provider;
        if (picked.baseUrl !== undefined) options.baseUrl = picked.baseUrl;
        if (picked.apiKey !== undefined) options.apiKey = picked.apiKey;
        // Remember the pick so the next launch skips straight into chat.
        const next = loadUserConfig();
        next.default = { provider: picked.provider, model: picked.model };
        saveUserConfig(next);
      }
    }

    ensureKeyConfigured(options);
    const probe = await createWorkspaceManager({
      dockerImage: 'guppy/executor:latest',
      useContainers: !options.local,
    }).probeContainerRuntime();
    if (!probe.ok) {
      console.error(chalk.red(`[Guppy] ${probe.reason}.`));
      process.exit(1);
    }
    // Load registered MCP servers so their tools join the chat loop (opt-out
    // with --no-mcp). The chat engine closes the bridge on shutdown. The
    // servers start inside the repo (sandbox layer 2).
    const repoPath = resolve(options.repo);
    const mcpBridge = await connectMcpForCli({ noMcp: options.noMcp, cwd: repoPath });
    const chatOptions = {
      repoPath,
      ...toRuntimeOptions(options),
      ...(mcpBridge ? { mcpBridge } : {}),
      verificationLevel: parseVerificationLevel(options.verification),
      quiet: options.quiet,
      local: options.local,
      keepWorktree: options.keepWorktree,
      ...(options.commitMessage !== 'guppy: apply agent changes' ? { commitMessage: options.commitMessage } : {}),
      // commander parses `--no-commit` as the negation of `commit`.
      ...(options.commit === false ? { noCommit: true } : {}),
      ...(options.force ? { force: true } : {}),
    };
    if (useTui) {
      await runTui(chatOptions);
    } else {
      await runChat(chatOptions);
    }
  });

program
  .command('replay <task-id> <session-id>')
  .description('Replay a session from event log')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .action(async (taskId, sessionId, options) => {
    const repoPath = resolve(options.repo);
    const eventStore = createEventStore({
      rootDir: resolve(repoPath, '.guppy', 'events'),
    });

    console.log(chalk.blue(`[Guppy] Replaying task: ${taskId}, session: ${sessionId}`));

    try {
      let eventCount = 0;
      for await (const event of eventStore.readEvents({ taskId: taskId as any, sessionId: sessionId as any, index: 0 })) {
        eventCount++;
        const time = new Date(event.timestamp).toISOString();
        console.log(chalk.gray(`  [${time}] ${event.type}`));
        if (event.payload) {
          console.log(chalk.gray(`    ${JSON.stringify(event.payload, null, 2)}`));
        }
      }
      console.log(chalk.green(`\n[Guppy] Replay complete. Total events: ${eventCount}`));
    } catch (e) {
      console.error(chalk.red('[Guppy] Replay failed:'), e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program
  .command('trace <task-id>')
  .description('Show event trace for a task')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-s, --session <session-id>', 'Specific session ID (optional)')
  .option('-t, --type <event-type>', 'Filter by event type (optional)')
  .action(async (taskId, options) => {
    const repoPath = resolve(options.repo);
    const eventStore = createEventStore({
      rootDir: resolve(repoPath, '.guppy', 'events'),
    });

    console.log(chalk.blue(`[Guppy] Trace for task: ${taskId}`));

    try {
      const sessions = options.session ? [options.session as any] : await eventStore.listSessions(taskId as any);
      
      if (sessions.length === 0) {
        console.log(chalk.yellow('No sessions found for this task'));
        return;
      }

      let totalEvents = 0;
      for (const sessionId of sessions) {
        console.log(chalk.cyan(`\n=== Session: ${sessionId} ===`));
        let eventCount = 0;
        for await (const event of eventStore.readEvents({ taskId: taskId as any, sessionId, index: 0 })) {
          if (options.type && event.type !== options.type) continue;
          eventCount++;
          totalEvents++;
          const time = new Date(event.timestamp).toISOString();
          console.log(chalk.gray(`  [${time}] ${event.type}`));
          if (event.payload) {
            const payloadStr = JSON.stringify(event.payload, null, 2);
            // Truncate long payloads
            if (payloadStr.length > 500) {
              console.log(chalk.gray(`    ${payloadStr.slice(0, 500)}...`));
            } else {
              console.log(chalk.gray(`    ${payloadStr}`));
            }
          }
        }
        console.log(chalk.gray(`  Events: ${eventCount}`));
      }
      console.log(chalk.green(`\n[Guppy] Trace complete. Total events: ${totalEvents}`));
    } catch (e) {
      console.error(chalk.red('[Guppy] Trace failed:'), e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

const skillCmd = program.command('skill').description('Author, install, list, and remove skills');
skillCmd
  .command('add <name> <description>')
  .description('Author a repo skill (writes <repo>/.guppy/skills/<slug>.md)')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('--tags <tags>', 'Comma-separated tags that trigger the skill')
  .option('--prompt <prompt>', 'Skill prompt body (edit the file to extend it)')
  .action(async (name, description, options) => {
    const repoPath = resolve(options.repo);
    const skillsDir = resolve(repoPath, '.guppy', 'skills');
    try {
      const skill = saveSkill(skillsDir, {
        name,
        description,
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.tags
          ? { tags: options.tags.split(',').map((t: string) => t.trim()).filter((t: string) => t !== '') }
          : {}),
      });
      console.log(chalk.green(`[Guppy] Skill "${skill.name}" saved (${skill.id})`));
      console.log(chalk.gray(`  ${skillsDir}`));
      console.log(chalk.gray('  It will be loaded into the context when a task matches its description/tags.'));
    } catch (e) {
      console.error(chalk.red('[Guppy] Could not save skill:'), e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

skillCmd
  .command('install [source]')
  .description('Install a skill: a registry name, an https:// URL to a .md skill file, or a local path')
  .option('--registry <ref>', 'Registry manifest: https:// URL, file path, or inline JSON (default: the builtin registry)')
  .option('--force', 'Overwrite an already-installed skill with the same name')
  .option('--dir <path>', 'Install into this directory instead of the per-user skills dir')
  .action(async (source: string | undefined, options: { registry?: string; force?: boolean; dir?: string }) => {
    // No source -> show what the (effective) registry offers, with installed marks.
    if (!source) {
      const { registry } = await loadRegistry(options.registry);
      const installed = new Set(
        listInstalledSkills({ ...(options.dir ? { dir: resolve(options.dir) } : {}) }).map((i) =>
          i.skill.name.toLowerCase(),
        ),
      );
      const label = registry.name ?? 'registry';
      console.log(chalk.blue(`[Guppy] Skills available in ${label}:`));
      for (const entry of registry.skills) {
        const mark = installed.has(entry.name.toLowerCase()) ? chalk.green('installed') : chalk.gray('available');
        const src = entry.source === 'builtin' ? 'builtin' : entry.source;
        console.log(chalk.gray(`  - ${entry.name.padEnd(18)} ${mark}`));
        console.log(chalk.gray(`      ${entry.description}`));
        console.log(chalk.gray(`      ${src}`));
      }
      console.log(chalk.gray('  Install one with: guppy skill install <name>'));
      return;
    }
    try {
      const result = await installSkill(source, {
        ...(options.registry ? { registry: options.registry } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.dir ? { dir: resolve(options.dir) } : {}),
      });
      console.log(chalk.green(`[Guppy] Skill "${result.skill.name}" installed (${result.skill.id})`));
      console.log(chalk.gray(`  ${result.file}`));
      console.log(chalk.gray(`  source: ${result.source}`));
      console.log(
        chalk.gray('  It is loaded into the context of every run/chat in every repo — `guppy skill list` to inspect, `guppy skill remove <name>` to uninstall.'),
      );
    } catch (e) {
      console.error(chalk.red('[Guppy] Could not install skill:'), e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

skillCmd
  .command('remove <name>')
  .description('Remove an installed skill (per-user first, then the repo skills dir)')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .action((name, options) => {
    const userDir = defaultSkillsDir();
    const userFile = join(userDir, `${slug(name)}.md`);
    if (existsSync(userFile)) {
      removeSkill(name, { dir: userDir });
      console.log(chalk.green(`[Guppy] Skill "${name}" removed from ${userFile}`));
      return;
    }
    const repoPath = resolve(options.repo);
    const repoFile = join(repoPath, '.guppy', 'skills', `${slug(name)}.md`);
    if (existsSync(repoFile)) {
      removeSkill(name, { dir: resolve(repoPath, '.guppy', 'skills') });
      console.log(chalk.green(`[Guppy] Skill "${name}" removed from ${repoFile}`));
      return;
    }
    console.log(
      chalk.yellow(`[Guppy] Skill "${name}" is not installed (checked ${userFile} and ${repoFile}).`),
    );
  });

skillCmd
  .command('list')
  .description('List installed (per-user) and repo skills')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .action((options) => {
    const repoPath = resolve(options.repo);
    const repoSkillsDir = resolve(repoPath, '.guppy', 'skills');
    const userSkillsDir = defaultSkillsDir();
    const installed = listInstalledSkills({ dir: userSkillsDir });
    const repoSkills = loadSkills(repoSkillsDir);
    const total = installed.length + repoSkills.length;
    if (total === 0) {
      console.log(
        chalk.yellow('[Guppy] No skills found. Author one with: guppy skill add <name> <description> · install one with: guppy skill install'),
      );
      return;
    }
    console.log(chalk.blue(`[Guppy] ${total} skill(s): ${installed.length} installed (${userSkillsDir}), ${repoSkills.length} repo (${repoSkillsDir})`));
    for (const i of installed) {
      const tags = i.skill.tags.length > 0 ? ` [${i.skill.tags.join(', ')}]` : '';
      console.log(chalk.gray(`  ${chalk.green('[user]')} ${i.skill.name}${tags}`));
      console.log(chalk.gray(`      ${i.skill.description}`));
      console.log(chalk.gray(`      source: ${i.source ?? 'local'}`));
    }
    for (const s of repoSkills) {
      const tags = s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
      console.log(chalk.gray(`  ${chalk.cyan('[repo]')} ${s.name}${tags}`));
      console.log(chalk.gray(`      ${s.description}`));
    }
  });

function parseBenchConfigs(value: string): BenchConfigKind[] {
  const configs = value.split(',').map((v) => v.trim()) as BenchConfigKind[];
  for (const config of configs) {
    if (!ALL_CONFIGS.includes(config)) {
      throw new Error(`unknown config '${config}' (expected one of: ${ALL_CONFIGS.join(', ')})`);
    }
  }
  return configs;
}

program
  .command('benchmark')
  .description(
    'Run the benchmark suite: the hermetic builtin fixtures, or a SWE-bench / LiveCodeBench JSONL dataset',
  )
  .option('-s, --suite <name>', 'Suite: builtin | swe-bench | livecodebench', 'builtin')
  .option('--dataset <path>', 'Path to a SWE-bench / LiveCodeBench JSONL (required with -s swe-bench/livecodebench)')
  .option('--repo <path>', 'Local checkout of the target repo (test patch is applied on top)')
  .option('-n, --count <number>', 'Max dataset instances to run', '20')
  .option('--config <list>', `Configs, comma-separated (${ALL_CONFIGS.join(', ')})`, 'guppy-core')
  .option('--tasks <list>', 'Builtin task ids / kinds / prefixes, comma-separated (default: all)')
  .option('--out <dir>', 'Output directory')
  .option('--model <id>', 'Model for the guppy-core config', 'claude-3-5-sonnet')
  .option('--provider <name>', 'Model provider for the guppy-core config (openai, openrouter, nvidia, …)')
  .option('--base-url <url>', 'OpenAI-compatible API base URL for the guppy-core config')
  .option('--api-key <key>', 'API key for the guppy-core config (provider env var used when omitted)')
  .option('--max-attempts <n>', 'Max closed-loop attempts per task', '3')
  .option('--attempt-timeout <ms>', 'Per-attempt timeout in ms', '600000')
  .option('--model-timeout-ms <ms>', 'Per-request timeout in ms for the guppy-core config')
  .option('--skills <dir>', 'Skills dir injected into every task for the guppy-core-skill config (default: the installed per-user skills dir)')
  .option('--dry-run', 'Materialize fixtures and gate them; never invoke an LLM', false)
  .action(async (options: Record<string, string | boolean>) => {
    const suite = String(options['suite']);
    const outDir = resolve(
      typeof options['out'] === 'string' && options['out'] !== ''
        ? options['out']
        : join('.guppy', 'bench', new Date().toISOString().replace(/[:.]/g, '-')),
    );

    // Builtin suite: the hermetic fixtures. Dataset suites: parse the JSONL,
    // materialize each instance as a fixture, and run them through the same
    // harness. Both feed runBench, so reports/JSON/tokens-saved behave alike.
    const tasks =
      suite === 'builtin'
        ? selectTasks(
            typeof options['tasks'] === 'string' && options['tasks'] !== ''
              ? options['tasks'].split(',').map((v) => v.trim())
              : undefined,
          )
        : loadDataset({
            source: suite as DatasetSource,
            path: String(options['dataset'] ?? ''),
            repoDir: resolve(String(options['repo'] ?? '')),
            outDir,
            count: parseInt(String(options['count']), 10) || 20,
          });

    if (tasks.length === 0) {
      console.error(chalk.red(`[Guppy] No tasks matched (suite: ${suite}).`));
      process.exit(1);
    }

    const configs = parseBenchConfigs(String(options['config']));
    const modelTimeoutMs = optNumber(options['modelTimeoutMs']);
    const benchOptions = {
      outDir,
      configs,
      tasks,
      model: String(options['model']),
      ...(typeof options['provider'] === 'string' && options['provider'] !== ''
        ? { provider: String(options['provider']) }
        : {}),
      ...(typeof options['baseUrl'] === 'string' && options['baseUrl'] !== ''
        ? { baseUrl: String(options['baseUrl']) }
        : {}),
      ...(typeof options['apiKey'] === 'string' && options['apiKey'] !== ''
        ? { apiKey: String(options['apiKey']) }
        : {}),
      maxAttempts: parseInt(String(options['maxAttempts']), 10) || 3,
      attemptTimeoutMs: parseInt(String(options['attemptTimeout']), 10) || 600_000,
      ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : {}),
      ...(typeof options['skills'] === 'string' && options['skills'] !== ''
        ? { skillsDir: resolve(String(options['skills'])) }
        : {}),
      dryRun: options['dryRun'] === true,
    };

    console.log(chalk.blue(`[Guppy] Benchmark (suite: ${suite})`));
    console.log(chalk.gray(`  Out:      ${outDir}`));
    console.log(chalk.gray(`  Configs:  ${configs.join(', ')}`));
    console.log(chalk.gray(`  Tasks:    ${tasks.length}`));
    console.log(chalk.gray(`  Model:    ${benchOptions.model}`));
    const retry = effectiveRetrySettings(benchOptions);
    console.log(chalk.gray(`  Retries (guppy-core): ${retry.maxRetries} (base ${retry.baseDelayMs}ms, max ${retry.maxDelayMs}ms)`));
    if (benchOptions.dryRun) {
      console.log(chalk.yellow('  Mode:     dry-run (no LLM calls)'));
    }

    const results = await runBench(benchOptions);
    if (!benchOptions.dryRun) {
      await attachContextHealth(results, benchOptions);
    }
    const { reportPath, jsonPath } = writeReport(results, benchOptions);

    const passed = results.filter((r) => r.passed).length;
    let done = `\nDone: ${passed}/${results.length} passed. Report: ${reportPath} | Data: ${jsonPath}`;
    const scored = results.filter((r) => r.contextHealth && !r.contextHealth.skipped);
    if (scored.length > 0) {
      const saved = scored.reduce((a, r) => a + (r.contextHealth?.tokensSaved ?? 0), 0);
      const tool = scored.find((r) => r.contextHealth?.tool)?.contextHealth?.tool ?? 'contextops';
      done += ` | Tokens saved (${tool}, est.): ${saved}`;
    }
    console.log(chalk.bold(done));
  });

program
  .command('providers')
  .description('List model providers from the built-in catalog')
  .action(() => {
    const providers = listProviders();
    console.log(chalk.blue(`[Guppy] ${providers.length} providers:`));
    for (const p of providers) {
      const tag = p.coreCompatibleCount > 0 ? 'core-compatible' : 'native-only';
      console.log(
        chalk.gray(
          `  ${p.id.padEnd(24)} ${p.name.padEnd(22)} ${String(p.modelCount).padStart(4)} models  ${p.coreCompatibleCount} core  [${tag}]`,
        ),
      );
    }
    console.log(
      chalk.gray('  "core-compatible" = OpenAI-compatible chat completions, usable by `guppy run` / `guppy chat`. Native-only providers need an adapter.'),
    );
  });

program
  .command('models [query]')
  .description('List models from the built-in catalog (search by id/name)')
  .option('--provider <id>', 'Filter by provider id (e.g. groq, openrouter)')
  .option('--compatible', 'Only OpenAI-compatible models (usable by the core runtime)')
  .option('--limit <n>', 'Max results', '40')
  .action((query: string | undefined, options: { provider?: string; compatible?: boolean; limit: string }) => {
    const models = listModels({
      ...(options.provider ? { provider: options.provider } : {}),
      ...(query ? { query } : {}),
      ...(options.compatible ? { coreCompatibleOnly: true } : {}),
      limit: parseInt(options.limit, 10) || 40,
    });
    console.log(chalk.blue(`[Guppy] ${models.length} model(s):`));
    for (const m of models) {
      const tag = m.coreCompatible ? chalk.green('core') : chalk.gray('native');
      console.log(
        chalk.gray(
          `  ${m.provider.padEnd(12)} ${m.id}  ctx ${m.contextWindow}  max ${m.maxTokens}${m.reasoning ? '  reasoning' : ''}  [${tag}]`,
        ),
      );
    }
  });

const configCmd = program
  .command('config')
  .description('Show or edit the per-user provider config (~/.guppy/config.json)');

configCmd.action(printUserConfig);

configCmd
  .command('set <provider> <apiKey>')
  .description('Store an API key for a provider')
  .option('--base-url <url>', 'Override the provider base URL')
  .option('--default-model <id>', 'Also set this provider/model as the default')
  .action((provider: string, apiKey: string, options: { baseUrl?: string; defaultModel?: string }) => {
    const path = defaultConfigPath();
    const config = loadUserConfig(path);
    const existing = config.providers[provider] ?? {};
    config.providers[provider] = {
      ...existing,
      apiKey,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    };
    if (options.defaultModel !== undefined) {
      config.default = { provider, model: options.defaultModel };
    }
    saveUserConfig(config, path);
    console.log(chalk.green(`[Guppy] Saved ${provider} → ${path}`));
    if (config.default) {
      console.log(chalk.gray(`  default model: ${config.default.provider}/${config.default.model}`));
    }
  });

configCmd
  .command('remove <provider>')
  .description('Remove a provider from the config')
  .action((provider: string) => {
    const path = defaultConfigPath();
    const config = loadUserConfig(path);
    if (!(provider in config.providers)) {
      console.log(chalk.yellow(`[Guppy] No config for "${provider}".`));
      return;
    }
    delete config.providers[provider];
    if (config.default?.provider === provider) {
      delete config.default;
    }
    saveUserConfig(config, path);
    console.log(chalk.green(`[Guppy] Removed ${provider}.`));
  });

configCmd
  .command('path')
  .description('Print the config file path')
  .action(() => {
    console.log(defaultConfigPath());
  });

program
  .command('setup')
  .description('Interactive provider setup: pick a provider, paste a key, pick a model (arrow keys)')
  .action(async () => {
    // Interactive terminal → the M2 arrow-key wizard (provider → key → live
    // model list from that provider's API, so nobody types model ids by
    // heart). Piped/non-TTY stdin keeps the scriptable readline flow.
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (interactive) {
      const picked = await runSetupWizard();
      if (!picked) {
        console.log(chalk.yellow('[Guppy] Setup cancelled — nothing saved.'));
        return;
      }
      const config = loadUserConfig();
      config.providers[picked.provider] = {
        ...(config.providers[picked.provider] ?? {}),
        ...(picked.apiKey !== undefined ? { apiKey: picked.apiKey } : {}),
        ...(picked.baseUrl !== undefined ? { baseUrl: picked.baseUrl } : {}),
      };
      config.default = { provider: picked.provider, model: picked.model };
      const path = saveUserConfig(config);
      console.log(chalk.green(`\n[Guppy] Saved ${picked.provider} → ${path}`));
      console.log(chalk.green(`  Default model: ${picked.provider}/${picked.model}`));
      console.log(
        chalk.gray('  Keys are stored in plaintext with 0600 permissions — rotate them if the file leaks.'),
      );
      return;
    }

    const providers = listProviders().filter((p) => p.coreCompatibleCount > 0);
    console.log(chalk.blue('[Guppy] Provider setup'));
    console.log(chalk.gray('  Core-compatible providers (usable by the core runtime):'));
    for (const p of providers) {
      console.log(chalk.gray(`    ${p.id.padEnd(24)} ${p.name} (${p.modelCount} models)`));
    }
    console.log(chalk.gray('  Prefer scripts/CI? Use: guppy config set <provider> <key>'));

    const prompts = createPrompter();
    try {
      const provider = (await prompts.ask('\nProvider id: ')).trim();
      if (!providers.some((p) => p.id === provider)) {
        console.error(
          chalk.red(`[Guppy] Unknown provider "${provider}". Run \`guppy providers\` to list them.`),
        );
        process.exit(1);
      }
      const apiKey = (await prompts.ask(`API key for ${provider}: `)).trim();
      if (!apiKey) {
        console.error(chalk.red('[Guppy] No API key entered — nothing saved.'));
        process.exit(1);
      }

      const config = loadUserConfig();
      config.providers[provider] = { ...(config.providers[provider] ?? {}), apiKey };

      const modelChoice = (await prompts.ask('Default model (leave blank to skip): ')).trim();
      if (modelChoice) {
        if (!selectModel({ provider, model: modelChoice })) {
          console.log(
            chalk.yellow(`  Note: "${modelChoice}" not found in ${provider}'s catalog — saved anyway.`),
          );
        }
        config.default = { provider, model: modelChoice };
      }

      const path = saveUserConfig(config);
      console.log(chalk.green(`\n[Guppy] Saved ${provider} → ${path}`));
      if (config.default) {
        console.log(chalk.green(`  Default model: ${config.default.provider}/${config.default.model}`));
      }
      console.log(
        chalk.gray('  Keys are stored in plaintext with 0600 permissions — rotate them if the file leaks.'),
      );
    } finally {
      prompts.close();
    }
  });

const mcpCmd = program.command('mcp').description('Register and inspect MCP tool servers');

mcpCmd
  .command('add <name> <command>')
  .description('Register an MCP server (spawned over stdio when the agent runs)')
  .option('--args <args>', 'Comma-separated arguments to the server command')
  .option('--env <key=value,...>', 'Comma-separated extra environment variables')
  .option('--config <path>', 'Config file (default: ~/.guppy/mcp.json)')
  .action((name, command, options) => {
    const config = addMcpServer(
      name,
      {
        command,
        ...(options.args ? { args: options.args.split(',').map((a: string) => a.trim()).filter(Boolean) } : {}),
        ...(options.env
          ? {
              env: Object.fromEntries(
                options.env.split(',').map((kv: string) => {
                  const eq = kv.indexOf('=');
                  if (eq <= 0) throw new Error(`env must be key=value, got "${kv}"`);
                  return [kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()];
                }),
              ),
            }
          : {}),
      },
      options.config ? resolve(options.config) : undefined,
    );
    console.log(chalk.green(`[Guppy] MCP server "${name}" registered.`));
    console.log(chalk.gray(`  ${defaultMcpConfigPath()}`));
    console.log(
      chalk.yellow(
        '  MCP servers start inside the workspace with a scrubbed environment (no API keys or tokens) and are' +
          ' force-killed with their whole process tree when the session ends. This is containment, not a jail:' +
          ' a server still runs with your account permissions. Only add servers you trust.',
      ),
    );
    console.log(chalk.gray(`  ${config.mcpServers[name] ? 'It will load automatically on the next run/chat (--no-mcp to skip).' : ''}`));
  });

mcpCmd
  .command('list')
  .description('List registered MCP servers')
  .option('--config <path>', 'Config file (default: ~/.guppy/mcp.json)')
  .action((options) => {
    const path = options.config ? resolve(options.config) : defaultMcpConfigPath();
    const config = loadMcpConfig(path);
    const names = Object.keys(config.mcpServers);
    if (names.length === 0) {
      console.log(chalk.yellow(`[Guppy] No MCP servers registered (${path}). Add one with: guppy mcp add <name> <command>`));
      return;
    }
    console.log(chalk.blue(`[Guppy] ${names.length} MCP server(s) in ${path}:`));
    for (const name of names) {
      const server = config.mcpServers[name];
      if (!server) continue;
      const cmdLine = [server.command, ...(server.args ?? [])].join(' ');
      console.log(chalk.gray(`  - ${name}`));
      console.log(chalk.gray(`      ${cmdLine}`));
      if (server.env && Object.keys(server.env).length > 0) {
        console.log(chalk.gray(`      env: ${Object.keys(server.env).join(', ')}`));
      }
    }
  });

mcpCmd
  .command('remove <name>')
  .description('Unregister an MCP server')
  .option('--config <path>', 'Config file (default: ~/.guppy/mcp.json)')
  .action((name, options) => {
    const path = options.config ? resolve(options.config) : undefined;
    const config = loadMcpConfig(path);
    if (!config.mcpServers[name]) {
      console.log(chalk.yellow(`[Guppy] No MCP server named "${name}" is registered.`));
      return;
    }
    removeMcpServer(name, path);
    console.log(chalk.green(`[Guppy] MCP server "${name}" removed.`));
  });

// pnpm forwards `pnpm cli -- chat --local` by passing a literal `--` as the
// first user argument; commander treats that as end-of-options and silently
// drops every flag after it (`-r`, `--local`, …). Strip a leading `--` so the
// pnpm form behaves exactly like the direct `node dist/cli.js` form.
const userArgs = process.argv.slice(2);
if (userArgs[0] === '--') userArgs.shift();
program.parse(userArgs, { from: 'user' });