/**
 * Guppy CLI — Main entry point
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline';
import { ulid, now } from '@guppy/contracts';
import type { Task, VerificationLevel } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine, loadSkills, saveSkill } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import {
  defaultConfigPath,
  listModels,
  listProviders,
  loadUserConfig,
  maskKey,
  resolveRuntimeOptions,
  saveUserConfig,
  selectModel,
} from '@guppy/models';
import {
  ALL_CONFIGS,
  attachContextHealth,
  effectiveRetrySettings,
  loadDataset,
  runBench,
  selectTasks,
  writeReport,
  type BenchConfigKind,
  type DatasetSource,
} from '@guppy/bench-runner';
import { createSessionManager } from './session-manager.js';
import { latestCheckpoint } from './checkpoint.js';
import { attachLiveStream } from './live-stream.js';
import { buildAgentRuntime, runChat, type RuntimeOptions } from './chat.js';
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

/** Commander option shape shared by `run` and `chat` (runtime-affecting flags). */
interface CommanderRuntimeOptions {
  runtime: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  maxRetries?: string;
  retryBaseDelay?: string;
  retryMaxDelay?: string;
  temperature?: string;
  maxTokens?: string;
  modelTimeoutMs?: string;
  stream?: boolean;
  primeBinary?: string;
  wsl?: string;
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
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(retryBaseDelayMs !== undefined ? { retryBaseDelayMs } : {}),
    ...(retryMaxDelayMs !== undefined ? { retryMaxDelayMs } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(options.stream === false ? { stream: false } : {}),
    ...(options.primeBinary ? { primeBinary: options.primeBinary } : {}),
    ...(options.wsl ? { wsl: options.wsl } : {}),
    maxTurns: parseInt(options.maxTurns, 10),
  };
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
  .option('--no-stream', 'Disable streaming model output (wait for the full response)')
  .option('-t, --max-turns <number>', 'Maximum turns', '20')
  .option('-v, --verification <level>', 'Verification level (0-5; 6 formal = unsupported)', '3')
  .option('--runtime <kind>', 'Agent runtime: core | prime | pi', 'core')
  .option('--wsl <distro>', 'Run prime-agent inside this WSL2 distro (Windows hosts)')
  .option('--prime-binary <path>', 'prime-agent executable (defaults to `prime-agent` on PATH)')
  .option('--local', 'Run without Docker (host execution, plain worktrees)')
  .option('--keep-worktree', 'Keep the worktree after the run instead of merging changes back')
  .option('--commit-message <template>', 'Commit-message template for merge-back ({task} placeholder)', 'guppy: apply agent changes')
  .option('--no-commit', 'Merge changes back without creating git commits (files overlaid onto the repo)')
  .option('--force', 'With --no-commit, overwrite uncommitted repo changes (dangerous)')
  .option('-q, --quiet', 'Suppress live event streaming (summary only)')
  .option('--resume', 'Resume the most recent interrupted run in this repo')
  .action(async (taskDescription, options) => {
    const repoPath = resolve(options.repo);
    const runtimeOptions = toRuntimeOptions(options);
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

    if (result.ok) {
      const trajectory = result.value;
      console.log(chalk.green('\n[Guppy] Task completed!'));
      console.log(chalk.gray(`  Outcome: ${trajectory.outcome}`));
      console.log(chalk.gray(`  Duration: ${duration}ms`));
      console.log(chalk.gray(`  Tokens: ${trajectory.metrics.tokensTotal}`));
      console.log(chalk.gray(`  Tool calls: ${trajectory.metrics.toolCalls}`));
      console.log(chalk.gray(`  Tests passed: ${trajectory.metrics.passes}`));
      console.log(chalk.gray(`  Tests failed: ${trajectory.metrics.failures}`));
    } else {
      console.error(chalk.red('\n[Guppy] Task failed:'), result.error.message);
      process.exit(1);
    }
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
  .option('--no-stream', 'Disable streaming model output (wait for the full response)')
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
  .action(async (options) => {
    const probe = await createWorkspaceManager({
      dockerImage: 'guppy/executor:latest',
      useContainers: !options.local,
    }).probeContainerRuntime();
    if (!probe.ok) {
      console.error(chalk.red(`[Guppy] ${probe.reason}.`));
      process.exit(1);
    }
    await runChat({
      repoPath: resolve(options.repo),
      ...toRuntimeOptions(options),
      verificationLevel: parseVerificationLevel(options.verification),
      quiet: options.quiet,
      local: options.local,
      keepWorktree: options.keepWorktree,
      ...(options.commitMessage !== 'guppy: apply agent changes' ? { commitMessage: options.commitMessage } : {}),
      // commander parses `--no-commit` as the negation of `commit`.
      ...(options.commit === false ? { noCommit: true } : {}),
      ...(options.force ? { force: true } : {}),
    });
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

const skillCmd = program.command('skill').description('Author and list repo skills');
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
  .command('list')
  .description('List skills loaded from <repo>/.guppy/skills')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .action((options) => {
    const repoPath = resolve(options.repo);
    const skills = loadSkills(resolve(repoPath, '.guppy', 'skills'));
    if (skills.length === 0) {
      console.log(chalk.yellow('[Guppy] No skills found. Author one with: guppy skill add <name> <description>'));
      return;
    }
    console.log(chalk.blue(`[Guppy] ${skills.length} skill(s) in ${resolve(repoPath, '.guppy', 'skills')}:`));
    for (const s of skills) {
      console.log(chalk.gray(`  - ${s.name}${s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : ''}`));
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
  .description('Interactive provider setup: pick a provider, paste a key, save to ~/.guppy/config.json')
  .action(async () => {
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

program.parse();