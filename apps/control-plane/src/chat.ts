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
import { resolve } from 'node:path';
import chalk from 'chalk';
import {
  now,
  ulid,
  type AgentRuntime,
  type Task,
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
import type { ModelConfig } from '@guppy/core';
import {
  defaultConfigPath,
  describeModel,
  listModels,
  listProviders,
  loadUserConfig,
  maskKey,
  saveUserConfig,
  selectModel,
} from '@guppy/models';
import type { Model } from '@earendil-works/pi-ai';
import { createSessionManager, type SessionManager } from './session-manager.js';
import { attachLiveStream } from './live-stream.js';

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
  /** Model↔tool turns within one attempt (pi adapter). */
  maxTurns: number;
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
    model: {
      provider: options.provider ?? 'openai',
      model: options.model,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: options.retryBaseDelayMs } : {}),
      ...(options.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: options.retryMaxDelayMs } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
    // Stream by default for the CLI; `--no-stream` turns it off. The bench
    // builds its own runtime, so it stays non-streaming unless it opts in.
    stream: options.stream !== false,
    maxTurns: 30,
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
}

/**
 * Run a single chat message through the full gated loop. Never throws: a
 * crashing runtime or failed gate degrades to a result the REPL can print.
 */
export async function runChatTurn(sessionManager: SessionManager, task: Task): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  try {
    const result = await sessionManager.run(task);
    const durationMs = Date.now() - startedAt;
    if (!result.ok) {
      return { ok: false, durationMs, error: result.error.message };
    }
    const t = result.value;
    return {
      ok: true,
      outcome: t.outcome,
      durationMs,
      tokens: t.metrics.tokensTotal,
      toolCalls: t.metrics.toolCalls,
      passes: t.metrics.passes,
      failures: t.metrics.failures,
    };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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

export async function runChat(options: ChatOptions): Promise<void> {
  const repoPath = resolve(options.repoPath);
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
  let sessionManager = createSession();

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const isTty = (input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY === true;
  const detachLiveStream = options.quiet ? () => {} : attachLiveStream(eventStore);
  const rl = createInterface({ input, output, terminal: isTty });

  let verificationLevel = options.verificationLevel;
  let shuttingDown = false;
  let busy = false;

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

  /** Swap the active model: rebuild runtime + session while keeping memory/events. */
  async function rebuildRuntime(next: ModelConfig): Promise<void> {
    await agentRuntime.shutdown();
    options.model = next.model;
    options.provider = next.provider;
    if (next.baseUrl !== undefined) options.baseUrl = next.baseUrl;
    else delete options.baseUrl;
    if (next.apiKey !== undefined) options.apiKey = next.apiKey;
    else delete options.apiKey;
    agentRuntime = buildAgentRuntime(options, eventStore, workspaceManager);
    sessionManager = createSession();
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
    console.log(chalk.gray('  /verify <level>    set the verification level (0-5; 6 formal = unsupported)'));
    console.log(chalk.gray('  /exit, /quit       leave the chat'));
    console.log(chalk.gray('  anything else      run it as a task through the gated agent loop'));
  };

  const handleTurn = async (userInput: string): Promise<void> => {
    const task: Task = {
      id: ulid(),
      description: userInput,
      repoPath,
      tags: [],
      verificationLevel,
      createdAt: now(),
      metadata: { chat: true },
    };
    console.log(chalk.blue(`\n[Guppy] Working on: ${userInput}`));
    const result = await runChatTurn(sessionManager, task);
    if (result.ok) {
      const status =
        result.outcome === 'success'
          ? chalk.green(`completed (${result.outcome})`)
          : chalk.yellow(`finished (${result.outcome})`);
      console.log(`\n[Guppy] Task ${status}`);
      console.log(
        chalk.gray(
          `  Duration: ${result.durationMs}ms  Tokens: ${result.tokens ?? 0}  Tool calls: ${result.toolCalls ?? 0}  ` +
            `Tests: ${result.passes ?? 0} passed / ${result.failures ?? 0} failed`,
        ),
      );
    } else {
      console.error(chalk.red(`\n[Guppy] Turn failed: ${result.error}`));
    }
  };

  console.log(chalk.blue('\n[Guppy] Chat mode — each message runs the full gated loop (verify → retry → memory).'));
  console.log(chalk.gray(`  Repo: ${repoPath}`));
  console.log(
    chalk.gray(
      `  Runtime: ${options.runtime}  Model: ${options.model}  Verification: ${verificationLevel}  Max turns: ${options.maxTurns}`,
    ),
  );
  console.log(chalk.gray('  Commands: /help  /models  /provider  /model  /verify <0-5>  /exit'));
  rl.prompt();

  rl.on('line', (line) => {
    const userInput = line.trim();
    if (!userInput) {
      prompt();
      return;
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
    busy = true;
    void (async () => {
      await handleTurn(userInput);
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
