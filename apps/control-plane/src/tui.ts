/**
 * guppy TUI — fullscreen terminal interface over the same agent loop the
 * readline REPL drives.
 *
 * The engine (event store, sandbox, runtime, session manager) is shared with
 * `runChat` via `createChatEngine`; this module is purely the rendering shell
 * on top of pi-tui: a scrollable transcript fed by the live event stream, an
 * input dock, a status line, and a `/models` SelectList overlay. Every turn is
 * still a gated task run through `runChatTurn`, so the TUI and the REPL are two
 * views of the identical harness.
 */

import chalk from 'chalk';
import {
  Input,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import type { Component, OverlayHandle } from '@earendil-works/pi-tui';
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
import { Transcript, buildModelItems, compactTokens, renderStatusLine, selectListTheme } from './tui-logic.js';

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
    const input = new Input();

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
          { component: input, basis: 'auto', shrink: 1, minSize: 1 },
        ]),
      );
    }
    tui.setFocus(input);

    let busy = false;
    let shuttingDown = false;
    let finished = false;
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
    // the layout, so pipe them into the scrollable transcript instead. Restored
    // before the goodbye line so the exit message reaches the real terminal.
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

    const detachLiveStream = options.quiet
      ? () => {}
      : engine.eventStore.subscribe((event) => {
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

    // -----------------------------------------------------------------------
    // Model picker overlay
    // -----------------------------------------------------------------------

    let modelsOverlay: OverlayHandle | null = null;
    let modelsSelectList: SelectList | null = null;
    let modelFilter = '';

    const closeModels = (): void => {
      if (modelsOverlay) {
        modelsOverlay.hide();
        modelsOverlay = null;
      }
      modelsSelectList = null;
      modelFilter = '';
      tui.setFocus(input);
      tui.requestRender();
    };

    const openModels = (query?: string): void => {
      if (modelsOverlay) return;
      const models = listModels({
        ...(activeProvider ? { provider: activeProvider } : {}),
        ...(query ? { query } : {}),
        coreCompatibleOnly: true,
        limit: 200,
      });
      const list = new SelectList(buildModelItems(models), 12, selectListTheme());
      list.onSelect = (item) => {
        const id = item.value;
        closeModels();
        void switchModel(id);
      };
      list.onCancel = () => closeModels();
      modelsSelectList = list;
      modelFilter = query ?? '';
      if (modelFilter) list.setFilter(modelFilter);
      modelsOverlay = tui.showOverlay(list, {
        anchor: 'top-center',
        width: '90%',
        maxHeight: '60%',
        offsetY: 2,
      });
      tui.requestRender();
    };

    // Type-ahead filter for the picker: printable chars refine the list while
    // the overlay is open; arrows/Enter/Escape/Ctrl+C still reach the SelectList.
    tui.addInputListener((data) => {
      if (modelsOverlay) {
        if (data === '\x7f' || data === '\x08') {
          modelFilter = modelFilter.slice(0, -1);
          modelsSelectList?.setFilter(modelFilter);
          tui.requestRender();
          return { consume: true };
        }
        if (data.length === 1) {
          const code = data.charCodeAt(0);
          if (code >= 32 && code < 127) {
            modelFilter += data;
            modelsSelectList?.setFilter(modelFilter);
            tui.requestRender();
            return { consume: true };
          }
        }
        return undefined;
      }
      if (matchesKey(data, 'ctrl+c')) {
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
      chalk.gray('  Commands: /help  /models  /provider  /model  /thinking  /verify <0-5>  /exit'),
    ];

    const helpLines = (): string[] => [
      chalk.gray('  /help              show this help'),
      chalk.gray('  /models [query]    open the model picker (type to filter, arrows to move, Enter to switch, Esc to close)'),
      chalk.gray('  /provider [id]     list providers, or filter the picker to one provider'),
      chalk.gray('  /model <id>        switch the active model'),
      chalk.gray('  /thinking [level]  show or set reasoning level (off|minimal|low|medium|high|xhigh|max)'),
      chalk.gray('  /verify <level>    set the verification level (0-5)'),
      chalk.gray('  /exit, /quit, Ctrl+C   leave the chat'),
      chalk.gray('  anything else      run it as a task through the gated agent loop'),
    ];

    async function switchModel(id: string): Promise<void> {
      if (!id) {
        transcript.append(chalk.yellow('Usage: /model <model-id>'));
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
          chalk.yellow(`No model "${id}" found${activeProvider ? ` in provider ${activeProvider}` : ''}. Use /models to search.`),
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
        transcript.append(
          chalk.gray(`Thinking: ${options.thinkingLevel ?? 'off'} (levels: ${THINKING_LEVELS.join('|')})`),
        );
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
        transcript.append(
          chalk.yellow('Usage: /verify <level 0-5> (level 6 formal verification is unsupported)'),
        );
      }
      tui.requestRender();
    }

    function setProvider(line: string): void {
      const id = line.slice('/provider '.length).trim();
      if (!id) {
        const providers = listProviders();
        const compatible = providers.filter((p) => p.coreCompatibleCount > 0).length;
        transcript.append(
          chalk.gray(`${providers.length} providers — ${compatible} serve OpenAI-compatible models (usable by the core runtime):`),
        );
        for (const p of providers) {
          const tag = p.coreCompatibleCount > 0 ? 'core' : 'native';
          transcript.append(
            chalk.gray(`  ${p.id.padEnd(24)} ${p.name.padEnd(22)} ${String(p.modelCount).padStart(4)} models  [${tag}]`),
          );
        }
        transcript.append(chalk.gray('  Use /provider <id> to filter, then /models to browse.'));
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
      transcript.append(chalk.blue(`\n[Guppy] Working on: ${line}`));
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
      input.setValue('');
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
        openModels(line.slice('/models '.length).trim() || undefined);
        return;
      }
      if (line === '/provider' || line.startsWith('/provider ')) {
        setProvider(line);
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
      if (line.startsWith('/verify ')) {
        setVerify(line);
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

    input.onSubmit = (value: string) => {
      void submitLine(value);
    };

    transcript.appendLines(welcomeLines());
    refreshStatus();
    tui.start();
  });
}
