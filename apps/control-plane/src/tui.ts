/**
 * guppy TUI — fullscreen terminal interface over the same agent loop the
 * readline REPL drives.
 *
 * The engine (event store, sandbox, runtime, session manager) is shared with
 * `runChat` via `createChatEngine`; this module is the rendering shell on top
 * of pi-tui. The input is pi-tui's `Editor` wired to a slash-command
 * autocomplete provider — type `/` to drop down the command menu, and
 * `/model <partial>` to drop down matching models — the same interaction
 * prime-agent's `pi` uses. Every turn is still a gated task run through
 * `runChatTurn`, so the TUI and the REPL are two views of the identical
 * harness.
 */

import chalk from 'chalk';
import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import type { Component, EditorTheme, SlashCommand } from '@earendil-works/pi-tui';
import { now, ulid } from '@guppy/contracts';
import type { Task, VerificationLevel } from '@guppy/contracts';
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
import { createChatEngine, runChatTurn } from './chat.js';
import type { ChatOptions } from './chat.js';
import { renderLiveEvent } from './live-stream.js';
import { Transcript, compactTokens, renderStatusLine, selectListTheme } from './tui-logic.js';

/** Adapter: expose the pure `Transcript` buffer as a pi-tui `Component`. */
class TranscriptView implements Component {
  constructor(private readonly transcript: Transcript) {}

  render(width: number): string[] {
    const w = Math.max(1, width);
    return this.transcript.lines.map((line) => truncateToWidth(line, w));
  }

  invalidate(): void {}
}

/**
 * Run the fullscreen TUI. Resolves once the user exits and the runtime/store
 * are shut down. Only call this on a real TTY (the CLI guards that).
 */
export function runTui(options: ChatOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const engine = createChatEngine(options);
    const terminal = new ProcessTerminal();
    const tui = new TuiAltScreen(terminal);

    const transcript = new Transcript();
    const status = new Text('', 0, 0);

    // pi-tui's Editor is the multi-line chat bar (with history + autocomplete)
    // that prime's `pi` uses. The slash-command provider powers the "/" menu.
    const editorTheme: EditorTheme = {
      borderColor: (text: string) => chalk.dim(text),
      selectList: selectListTheme(),
    };
    const editor = new Editor(tui, editorTheme);

    // Without a chosen provider, the catalog's first entries are baseten /
    // cerebras / cloudflare — not what a free-tier user wants. Lead with the
    // providers the launch story targets (Groq / OpenRouter / Google / …).
    const POPULAR_PROVIDERS = ['groq', 'openrouter', 'google', 'openai', 'ollama', 'nvidia'];
    const listCuratedModels = (limit: number): ReturnType<typeof listModels> => {
      const out: ReturnType<typeof listModels> = [];
      for (const pid of POPULAR_PROVIDERS) {
        for (const m of listModels({ provider: pid, coreCompatibleOnly: true })) {
          out.push(m);
          if (out.length >= limit) return out;
        }
      }
      return out;
    };

    const modelCompletions = (prefix: string) => {
      const models = prefix
        ? listModels({
            ...(activeProvider ? { provider: activeProvider } : {}),
            query: prefix,
            coreCompatibleOnly: true,
            limit: 30,
          })
        : activeProvider
          ? listModels({ provider: activeProvider, coreCompatibleOnly: true, limit: 30 })
          : listCuratedModels(30);
      return models.map((m) => ({
        value: m.id,
        label: `${m.provider}/${m.id}`,
        description: `ctx ${compactTokens(m.contextWindow)} · max ${compactTokens(m.maxTokens)}${m.reasoning ? ' · reasoning' : ''}`,
      }));
    };

    const slashCommands: SlashCommand[] = [
      { name: 'help', description: 'show this help' },
      { name: 'models', description: 'list models', argumentHint: 'query' },
      {
        name: 'model',
        description: 'switch the active model',
        argumentHint: 'id or query',
        getArgumentCompletions: modelCompletions,
      },
      {
        name: 'provider',
        description: 'list or set the provider',
        argumentHint: 'id',
        getArgumentCompletions: (prefix) =>
          listProviders()
            .filter((p) => p.coreCompatibleCount > 0 && p.id.includes(prefix))
            .map((p) => ({ value: p.id, label: p.id, description: `${p.name} · ${p.modelCount} models` })),
      },
      {
        name: 'thinking',
        description: 'set reasoning level',
        argumentHint: 'level',
        getArgumentCompletions: () =>
          (THINKING_LEVELS as readonly string[]).map((l) => ({ value: l, label: l })),
      },
      {
        name: 'verify',
        description: 'set verification level (0-5)',
        argumentHint: 'level',
        getArgumentCompletions: () => ['0', '1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v })),
      },
      { name: 'verbose', description: 'toggle raw event logging' },
      { name: 'setup', description: 'store a provider API key', argumentHint: 'provider key' },
      { name: 'exit', description: 'leave the chat' },
      { name: 'quit', description: 'leave the chat' },
    ];
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, engine.repoPath));

    if (isViewportTUI(tui)) {
      tui.setLayoutRoot(
        new VStack([
          {
            component: new ScrollView(new TranscriptView(transcript), {
              follow: 'end',
              primary: true,
              overscroll: 'chain',
            }),
            basis: 0,
            grow: 1,
            minSize: 1,
          },
          { component: status, basis: 'auto', shrink: 1, minSize: 1 },
          { component: editor, basis: 'auto', shrink: 1, minSize: 1 },
        ]),
      );
    }
    tui.setFocus(editor);

    let busy = false;
    let shuttingDown = false;
    let finished = false;
    let verbose = false;
    let activeProvider = options.provider;
    let verificationLevel = options.verificationLevel;

    const refreshStatus = (): void => {
      status.setText(
        renderStatusLine({
          model: options.model,
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
          verificationLevel,
          busy,
        }),
      );
    };

    // The engine (SessionManager, verification engine, core runtime) reports
    // its internal progress through console.log/error. In the alt-screen those
    // raw writes would interleave with pi-tui's synchronized frames and corrupt
    // the layout, so swallow them (and only surface them with /verbose).
    // Restored before the goodbye line so the exit message reaches the real
    // terminal.
    const origConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };
    const stringifyArg = (a: unknown): string => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    };
    const pipeConsole = (...args: unknown[]): void => {
      if (!verbose) return;
      const text = args.map(stringifyArg).join(' ');
      for (const line of text.split('\n')) {
        if (line.trim() !== '') transcript.append(line);
      }
      tui.requestRender();
    };
    const restoreConsole = (): void => {
      console.log = origConsole.log;
      console.error = origConsole.error;
      console.warn = origConsole.warn;
      console.info = origConsole.info;
    };
    console.log = (...a: unknown[]) => pipeConsole(...a);
    console.error = (...a: unknown[]) => pipeConsole(...a);
    console.warn = (...a: unknown[]) => pipeConsole(...a);
    console.info = (...a: unknown[]) => pipeConsole(...a);

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    const detachLiveStream = engine.eventStore.subscribe((event) => {
      // The transcript stays clean by default (user message → result); the raw
      // event stream only appears with /verbose, for debugging a run.
      if (!verbose) return;
      try {
        const line = renderLiveEvent(event);
        if (line) {
          transcript.append(line);
          tui.requestRender();
        }
      } catch {
        // Rendering is best-effort; the event log is the source of truth.
      }
    });

    const finishShutdown = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      detachLiveStream();
      tui.stop();
      await engine.shutdown();
      restoreConsole();
      console.log(chalk.gray('[Guppy] Bye.'));
      resolve();
    };

    const requestShutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      // A turn may be mid-flight (Ctrl+C or /exit while the agent works):
      // defer the teardown until the turn lands rather than racing it — but
      // say so immediately, otherwise it looks like Ctrl+C was ignored.
      if (busy) {
        status.setText(chalk.yellow('[Guppy] shutting down — finishing the current turn…'));
        transcript.append(chalk.yellow('[Guppy] Shutting down after the current turn finishes…'));
        tui.requestRender();
        return;
      }
      await finishShutdown();
    };

    // Ctrl+C quits the chat — unless the editor's autocomplete dropdown is
    // open, in which case it should just dismiss the dropdown.
    tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        if (editor.isShowingAutocomplete()) return undefined;
        void requestShutdown();
        return { consume: true };
      }
      return undefined;
    });

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    const welcomeLines = (): string[] => [
      chalk.blue('[Guppy] Chat mode — each message runs the full gated loop (verify → retry → memory).'),
      chalk.gray(`  Repo: ${engine.repoPath}`),
      chalk.gray(
        `  Runtime: ${options.runtime}  Model: ${options.model}  Verification: ${verificationLevel}  Max turns: ${options.maxTurns}`,
      ),
      chalk.gray('  Type / for commands, or just describe a task and press Enter.'),
    ];

    const helpLines = (): string[] => [
      chalk.gray('  /help              show this help'),
      chalk.gray('  /models [query]    list core-compatible models'),
      chalk.gray('  /model [id]        switch the active model (type /model <partial> for a dropdown)'),
      chalk.gray('  /provider [id]     list providers, or filter to one provider'),
      chalk.gray('  /thinking [level]  show or set reasoning level (off|minimal|low|medium|high|xhigh|max)'),
      chalk.gray('  /verify <level>    set the verification level (0-5)'),
      chalk.gray('  /verbose           toggle raw event/engine logging on or off'),
      chalk.gray('  /exit, /quit, Ctrl+C   leave the chat'),
      chalk.gray('  anything else      run it as a task through the gated agent loop'),
    ];

    const listModelsToTranscript = (query?: string): void => {
      const models = query
        ? listModels({
            ...(activeProvider ? { provider: activeProvider } : {}),
            query,
            coreCompatibleOnly: true,
            limit: 20,
          })
        : activeProvider
          ? listModels({ provider: activeProvider, coreCompatibleOnly: true, limit: 20 })
          : listCuratedModels(20);
      if (models.length === 0) {
        transcript.append(chalk.yellow('No core-compatible models match that query.'));
        tui.requestRender();
        return;
      }
      if (!query && !activeProvider) {
        transcript.append(chalk.gray('Popular free-tier models (Groq / OpenRouter / Google / OpenAI / Ollama / NVIDIA):'));
        transcript.append(chalk.gray('  To see a specific provider, /provider <id> first, or /model <partial> for the dropdown.'));
      } else {
        transcript.append(chalk.gray(`${models.length} model(s):`));
      }
      for (const m of models) {
        transcript.append(
          chalk.gray(
            `  ${m.provider.padEnd(12)} ${m.id}  ctx ${compactTokens(m.contextWindow)}  max ${compactTokens(m.maxTokens)}${m.reasoning ? '  reasoning' : ''}`,
          ),
        );
      }
      tui.requestRender();
    };

    async function switchModel(id: string): Promise<void> {
      if (!id) {
        transcript.append(chalk.yellow('Type /model <partial> to browse (e.g. /model qwen), or /provider <id> to pick a provider first.'));
        tui.requestRender();
        return;
      }
      if (busy) {
        transcript.append(chalk.yellow('Still working — wait for the current turn to finish before switching models.'));
        tui.requestRender();
        return;
      }
      const next = selectModel({ model: id, ...(activeProvider ? { provider: activeProvider } : {}) });
      if (!next) {
        transcript.append(
          chalk.yellow(`No exact model "${id}" — type /model <partial> to see close matches, or /models to list.`),
        );
        tui.requestRender();
        return;
      }
      busy = true;
      refreshStatus();
      try {
        await engine.rebuild(() => {
          options.model = next.model;
          options.provider = next.provider;
          if (next.baseUrl !== undefined) options.baseUrl = next.baseUrl;
          else delete options.baseUrl;
          if (next.apiKey !== undefined) options.apiKey = next.apiKey;
          else delete options.apiKey;
        });
        transcript.append(chalk.green(`Model set to ${next.provider}/${next.model}`));
        const desc = describeModel(next.provider, next.model);
        if (desc) {
          transcript.append(
            chalk.gray(
              `  Context ${compactTokens(desc.contextWindow)}  Max output ${compactTokens(desc.maxTokens)}${desc.reasoning ? '  Reasoning' : ''}`,
            ),
          );
        }
      } catch (e) {
        transcript.append(chalk.red(`Could not switch model: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        busy = false;
        refreshStatus();
        tui.requestRender();
      }
    }

    async function setThinking(line: string): Promise<void> {
      const arg = line.slice('/thinking '.length).trim();
      if (arg === '') {
        transcript.append(chalk.gray(`Thinking: ${options.thinkingLevel ?? 'off'} (levels: ${THINKING_LEVELS.join('|')})`));
        tui.requestRender();
        return;
      }
      if (!(THINKING_LEVELS as readonly string[]).includes(arg)) {
        transcript.append(chalk.yellow(`Invalid thinking level "${arg}" — use ${THINKING_LEVELS.join('|')}.`));
        tui.requestRender();
        return;
      }
      if (busy) {
        transcript.append(chalk.yellow('Still working — wait for the current turn to finish.'));
        tui.requestRender();
        return;
      }
      const level = arg as ThinkingLevel;
      busy = true;
      refreshStatus();
      try {
        await engine.rebuild(() => {
          if (level === 'off') delete options.thinkingLevel;
          else options.thinkingLevel = level;
        });
        transcript.append(chalk.green(`Thinking set to ${level}.`));
      } catch (e) {
        transcript.append(chalk.red(`Could not set thinking: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        busy = false;
        refreshStatus();
        tui.requestRender();
      }
    }

    function setVerify(line: string): void {
      const level = Number(line.slice('/verify '.length).trim());
      if (Number.isInteger(level) && level >= 0 && level <= 5) {
        verificationLevel = level as VerificationLevel;
        transcript.append(chalk.gray(`Verification level set to ${level}.`));
        refreshStatus();
      } else {
        transcript.append(chalk.yellow('Usage: /verify <level 0-5> (level 6 formal verification is unsupported)'));
      }
      tui.requestRender();
    }

    function setProvider(line: string): void {
      const id = line.slice('/provider '.length).trim();
      if (!id) {
        const providers = listProviders();
        const compatible = providers.filter((p) => p.coreCompatibleCount > 0).length;
        transcript.append(chalk.gray(`${providers.length} providers — ${compatible} serve OpenAI-compatible models:`));
        for (const p of providers) {
          const tag = p.coreCompatibleCount > 0 ? 'core' : 'native';
          transcript.append(
            chalk.gray(`  ${p.id.padEnd(24)} ${p.name.padEnd(22)} ${String(p.modelCount).padStart(4)} models  [${tag}]`),
          );
        }
        transcript.append(chalk.gray('  Use /provider <id> to filter, then /model to browse.'));
      } else {
        const provider = listProviders().find((p) => p.id === id);
        if (!provider) {
          transcript.append(chalk.yellow(`Unknown provider: ${id}`));
        } else {
          activeProvider = id;
          transcript.append(
            chalk.gray(`Provider set to ${id} (${provider.name}) — ${provider.coreCompatibleCount}/${provider.modelCount} models are core-compatible.`),
          );
        }
      }
      tui.requestRender();
    }

    function setupProvider(line: string): void {
      const args = line.slice('/setup '.length).trim();
      if (args === '') {
        const path = defaultConfigPath();
        const config = loadUserConfig(path);
        transcript.append(chalk.gray(`Config: ${path}`));
        const entries = Object.entries(config.providers);
        if (entries.length === 0) {
          transcript.append(chalk.yellow('No providers configured. Run `guppy setup` or /setup <provider> <key>.'));
        } else {
          for (const [id, preset] of entries) {
            const parts: string[] = [];
            if (preset.apiKey) parts.push(`key ${maskKey(preset.apiKey)}`);
            if (preset.baseUrl) parts.push(`baseUrl ${preset.baseUrl}`);
            transcript.append(chalk.gray(`  ${id.padEnd(20)} ${parts.join(' · ') || '(no key)'}`));
          }
        }
        if (config.default) {
          transcript.append(chalk.gray(`  default model: ${config.default.provider}/${config.default.model}`));
        }
      } else {
        const space = args.indexOf(' ');
        const provider = space === -1 ? args : args.slice(0, space);
        const apiKey = space === -1 ? '' : args.slice(space + 1).trim();
        if (!apiKey) {
          transcript.append(chalk.yellow('Usage: /setup (show) or /setup <provider> <api-key>'));
        } else {
          const config = loadUserConfig();
          config.providers[provider] = { ...(config.providers[provider] ?? {}), apiKey };
          saveUserConfig(config);
          transcript.append(chalk.green(`Saved API key for ${provider} (${maskKey(apiKey)}).`));
        }
      }
      tui.requestRender();
    }

    // -----------------------------------------------------------------------
    // Turn execution
    // -----------------------------------------------------------------------

    async function runTaskTurn(line: string): Promise<void> {
      busy = true;
      refreshStatus();
      transcript.append(chalk.bold(`You: ${line}`));
      tui.requestRender();
      const task: Task = {
        id: ulid(),
        description: line,
        repoPath: engine.repoPath,
        tags: [],
        verificationLevel,
        createdAt: now(),
        metadata: { chat: true },
      };
      const result = await runChatTurn(engine.sessionManager, task);
      if (result.ok) {
        const statusText =
          result.outcome === 'success'
            ? chalk.green(`completed (${result.outcome})`)
            : chalk.yellow(`finished (${result.outcome})`);
        transcript.append(`\n[Guppy] Task ${statusText}`);
        transcript.append(
          chalk.gray(
            `  Duration: ${result.durationMs}ms  Tokens: ${result.tokens ?? 0}  Tool calls: ${result.toolCalls ?? 0}  ` +
              `Tests: ${result.passes ?? 0} passed / ${result.failures ?? 0} failed`,
          ),
        );
      } else {
        transcript.append(chalk.red(`\n[Guppy] Turn failed: ${result.error}`));
      }
      busy = false;
      refreshStatus();
      tui.requestRender();
      if (shuttingDown) await finishShutdown();
    }

    async function submitLine(raw: string): Promise<void> {
      const line = raw.trim();
      editor.setText('');
      editor.addToHistory(raw);
      tui.requestRender();
      if (!line) return;
      if (line === '/exit' || line === '/quit') {
        await requestShutdown();
        return;
      }
      if (line === '/help') {
        transcript.appendLines(helpLines());
        tui.requestRender();
        return;
      }
      if (line === '/models' || line.startsWith('/models ')) {
        listModelsToTranscript(line.slice('/models '.length).trim() || undefined);
        return;
      }
      if (line === '/provider' || line.startsWith('/provider ')) {
        setProvider(line);
        return;
      }
      if (line === '/model') {
        transcript.append(
          chalk.yellow('Type /model <partial> to browse (e.g. /model qwen), or /provider <id> to pick a provider first.'),
        );
        tui.requestRender();
        return;
      }
      if (line.startsWith('/model ')) {
        await switchModel(line.slice('/model '.length).trim());
        return;
      }
      if (line === '/thinking' || line.startsWith('/thinking ')) {
        await setThinking(line);
        return;
      }
      if (line === '/verify') {
        transcript.append(chalk.yellow('Usage: /verify <level 0-5> (6 formal verification is unsupported).'));
        tui.requestRender();
        return;
      }
      if (line.startsWith('/verify ')) {
        setVerify(line);
        return;
      }
      if (line === '/verbose') {
        verbose = !verbose;
        transcript.append(chalk.gray(`Verbose event logging ${verbose ? 'on' : 'off'}.`));
        tui.requestRender();
        return;
      }
      if (line === '/setup' || line.startsWith('/setup ')) {
        setupProvider(line);
        return;
      }
      if (line.startsWith('/')) {
        transcript.append(chalk.yellow(`Unknown command: ${line} (try /help)`));
        tui.requestRender();
        return;
      }
      if (busy) {
        transcript.append(chalk.yellow('Still working — wait for the current turn to finish.'));
        tui.requestRender();
        return;
      }
      await runTaskTurn(line);
    }

    editor.onSubmit = (value: string) => {
      void submitLine(value);
    };

    transcript.appendLines(welcomeLines());
    refreshStatus();
    tui.start();
  });
}
