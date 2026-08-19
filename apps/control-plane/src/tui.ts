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
  Markdown,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import type {
  Component,
  EditorTheme,
  MarkdownTheme,
  SlashCommand,
  Terminal,
  TUI,
} from '@earendil-works/pi-tui';
import { now, ulid } from '@guppy/contracts';
import type { Task, ULID, VerificationLevel } from '@guppy/contracts';
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
import { createChatEngine, emitPlanApproved, emitPlanRevised, runChatTurn, runPlanTurn } from './chat.js';
import type { ChatOptions } from './chat.js';
import { renderLiveEvent } from './live-stream.js';
import {
  Transcript,
  compactTokens,
  humanizeAction,
  markdownTheme,
  renderContextBar,
  renderTurnFooter,
  selectListTheme,
  type ThemeMode,
} from './tui-logic.js';

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
 * The scrollable chat area: the transcript lines (You messages, meta, footer)
 * plus the latest Guppy reply rendered as markdown (headings, code, lists,
 * tables) via pi-tui's Markdown component. One reply at a time — the previous
 * reply's prose stays in the transcript as plain lines, so the conversation
 * history stays readable while the newest answer gets full markdown treatment.
 */
class ChatView implements Component {
  private markdown: Markdown;
  private replyText = '';

  constructor(
    private readonly transcript: Transcript,
    theme: MarkdownTheme,
  ) {
    this.markdown = new Markdown('', 0, 0, theme);
  }

  /** Set (or clear, with '') the current assistant reply. */
  setReply(text: string): void {
    this.replyText = text || '';
    this.markdown.setText(this.replyText);
  }

  /** Swap the markdown palette (the /theme command) without losing the reply. */
  setTheme(theme: MarkdownTheme): void {
    this.markdown = new Markdown(this.replyText, 0, 0, theme);
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const lines = this.transcript.lines.map((line) => truncateToWidth(line, w));
    if (this.replyText) {
      lines.push('');
      lines.push(...this.markdown.render(w));
    }
    return lines;
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}

/**
 * The inline activity line (UX-SPEC §4/§6): a spinner + one humanized action
 * while busy, zero rows when idle. `set` starts the animation; `clear` stops
 * it (must also run on shutdown so a dangling timer can't keep the process
 * alive).
 */
class ActivityLine implements Component {
  private static readonly FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private text = '';

  constructor(private readonly tui: TUI) {}

  set(text: string): void {
    this.text = text;
    if (this.timer) return;
    this.frame = 0;
    this.tick();
    this.timer = setInterval(() => this.tick(), 80);
  }

  clear(): void {
    this.text = '';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.frame = 0;
    this.tui.requestRender();
  }

  private tick(): void {
    this.frame = (this.frame + 1) % ActivityLine.FRAMES.length;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (!this.text) return [];
    return [`${chalk.cyan(ActivityLine.FRAMES[this.frame])} ${this.text}`];
  }

  invalidate(): void {}
}

/**
 * Run the fullscreen TUI. Resolves once the user exits and the runtime/store
 * are shut down. Only call this on a real TTY (the CLI guards that).
 */
export function runTui(options: ChatOptions, terminal: Terminal = new ProcessTerminal()): Promise<void> {
  return new Promise<void>((resolve) => {
    const engine = createChatEngine(options);
    const tui = new TuiAltScreen(terminal);

    const transcript = new Transcript();

    // Auto-detect the terminal color scheme (best-effort; dark on unknown).
    // A /theme command later swaps this live.
    let themeMode: ThemeMode = 'dark';
    const applyTheme = (mode: ThemeMode): void => {
      themeMode = mode;
      chatView.setTheme(markdownTheme(mode));
      contextBar.setText(renderContextBar(contextBarState(), themeMode));
      tui.requestRender();
    };
    const chatView = new ChatView(transcript, markdownTheme(themeMode));
    const contextBar = new Text('', 0, 0);
    const hint = new Text('', 0, 0);
    const activity = new ActivityLine(tui);

    // pi-tui's Editor is the multi-line chat bar (with history + autocomplete)
    // that prime's `pi` uses. The slash-command provider powers the "/" menu.
    const editorTheme: EditorTheme = {
      borderColor: (text: string) => chalk.dim(text),
      selectList: selectListTheme(themeMode),
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
      {
        name: 'theme',
        description: 'set the color scheme (dark | light)',
        argumentHint: 'mode',
        getArgumentCompletions: () => ['dark', 'light'].map((v) => ({ value: v, label: v })),
      },
      { name: 'setup', description: 'store a provider API key', argumentHint: 'provider key' },
      { name: 'plan', description: 'plan a task read-only before executing' },
      { name: 'build', description: 'approve and run the last plan' },
      { name: 'edit', description: 'revise the pending plan by hand' },
      { name: 'exit', description: 'leave the chat' },
      { name: 'quit', description: 'leave the chat' },
    ];
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, engine.repoPath));

    if (isViewportTUI(tui)) {
      tui.setLayoutRoot(
        new VStack([
          { component: contextBar, basis: 'auto', shrink: 1, minSize: 1 },
          {
            component: new ScrollView(chatView, {
              follow: 'end',
              primary: true,
              overscroll: 'chain',
            }),
            basis: 0,
            grow: 1,
            minSize: 1,
          },
          { component: activity, basis: 'auto', shrink: 1, minSize: 0 },
          { component: editor, basis: 'auto', shrink: 1, minSize: 1 },
          { component: hint, basis: 'auto', shrink: 1, minSize: 1 },
        ]),
      );
    }
    // Plan/build mode (UX-SPEC S6, Slice 4). /plan makes every message a
    // read-only planning turn (the plan is rendered with a plan-gate footer);
    // /build approves the last plan and runs it through the full gated loop.
    let mode: 'plan' | 'build' = 'build';
    // The plan awaiting approval (rendered + stored after a planning turn).
    let pendingPlan: string | null = null;
    // The model-produced plan (the last PlanProduced), kept separate from
    // pendingPlan so a revision's diff is always against the model, not a
    // prior human edit.
    let modelPlan: string | null = null;
    // The plan task id, so PlanRevised lands in the same task trace as the
    // model's PlanProduced.
    let planTaskId: ULID | null = null;
    // True while the user is revising the plan by hand (the next submitted
    // message is captured verbatim as the revised plan, no model call).
    let editingPlan = false;
    const refreshHint = (): void => {
      if (editingPlan) {
        hint.setText(chalk.dim('revising plan — Enter to save · Ctrl+C to cancel'));
      } else if (mode === 'plan') {
        hint.setText(chalk.dim('planning only — no edits · /build to execute'));
      } else {
        hint.setText(chalk.dim('Enter send · Shift+Enter newline · / for commands'));
      }
    };
    refreshHint();
    tui.setFocus(editor);

    let busy = false;
    let shuttingDown = false;
    let finished = false;
    let verbose = false;
    let activeProvider = options.provider;
    let verificationLevel = options.verificationLevel;
    // Aborts the in-flight turn when the user presses Ctrl+C mid-turn (D2:
    // interrupt the whole turn and land a clean "cancelled" state). Created
    // per turn, so one Ctrl+C cancels the current turn and a second (idle)
    // Ctrl+C exits.
    let turnAbort: AbortController | null = null;
    // Session totals for the exit-screen dump (UX-SPEC §11): accumulated
    // across turns so the goodbye line summarizes the whole chat session.
    let sessionTurns = 0;
    let sessionTokens = 0;
    let sessionToolCalls = 0;
    let sessionPasses = 0;
    let sessionFailures = 0;
    let sessionSaved = 0;

    const repoShort = engine.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? engine.repoPath;
    const contextBarState = () => ({
      repo: repoShort,
      model: options.model,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      verificationLevel,
      mode,
      // The cumulative ContextOps savings figure appears only once the
      // tracker has successfully scored a capture (best-effort).
      ...(engine.savings.isAvailable ? { savedTotal: engine.savings.cumulative } : {}),
    });
    const refreshContextBar = (): void => {
      contextBar.setText(renderContextBar(contextBarState(), themeMode));
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
      // While a turn is in flight, the inline activity line shows one calm,
      // humanized action per event ("Running npm test…", "Searching "…"").
      // The transcript stays clean by default; the raw event stream only
      // appears with /verbose, for debugging a run.
      if (busy) {
        const action = humanizeAction(event);
        if (action) activity.set(action);
      }
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
      activity.clear();
      tui.stop();
      await engine.shutdown();
      restoreConsole();
      // Exit-screen dump (UX-SPEC §11): one dim summary line of the session
      // so the goodbye is a record, not a blank terminal. Tokens only, never
      // money; savings omitted when ContextOps never scored.
      if (sessionTurns > 0) {
        let dump = `[Guppy] Session: ${sessionTurns} turn${sessionTurns === 1 ? '' : 's'} · ` +
          `${compactTokens(sessionTokens)} tokens · ${sessionToolCalls} tool calls · ` +
          `${sessionPasses}/${sessionFailures} tests`;
        if (sessionSaved > 0) dump += ` · saved ≈${compactTokens(sessionSaved)}`;
        console.log(chalk.gray(dump));
      }
      console.log(chalk.gray('[Guppy] Bye.'));
      resolve();
    };

    const requestShutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      // A turn may be mid-flight (/exit while the agent works): interrupt it
      // immediately, then tear down once the cancelled turn lands.
      if (busy) {
        turnAbort?.abort();
        activity.set(chalk.yellow('[Guppy] shutting down — interrupting the current turn…'));
        transcript.append(chalk.yellow('[Guppy] Shutting down — interrupting the current turn…'));
        tui.requestRender();
        return;
      }
      await finishShutdown();
    };

    // Ctrl+C: interrupt an in-flight turn (whole-turn abort, lands "cancelled")…
    // or quit the chat when idle. An open autocomplete dropdown just dismisses.
    tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        if (editor.isShowingAutocomplete()) return undefined;
        // Ctrl+C while revising the plan cancels the revision (keeps the
        // pending plan) instead of exiting the chat.
        if (editingPlan) {
          editingPlan = false;
          refreshHint();
          transcript.append(chalk.yellow('[Guppy] Plan revision cancelled.'));
          tui.requestRender();
          return { consume: true };
        }
        if (busy && turnAbort && !turnAbort.signal.aborted) {
          turnAbort.abort();
          activity.set(chalk.yellow('Cancelling turn…'));
          transcript.append(chalk.yellow('[Guppy] Interrupting the turn — landing as cancelled…'));
          tui.requestRender();
          return { consume: true };
        }
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
        `  Model: ${options.model}  Verification: ${verificationLevel}  Max turns: ${options.maxTurns}`,
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
      chalk.gray('  /plan              plan a task read-only (no edits) before executing'),
      chalk.gray('  /build             approve and run the last plan, or return to build mode'),
      chalk.gray('  /edit [text]       revise the pending plan by hand, then /build to run it'),
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
      refreshContextBar();
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
      refreshContextBar();
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
      refreshContextBar();
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
      refreshContextBar();
        tui.requestRender();
      }
    }

    function setVerify(line: string): void {
      const level = Number(line.slice('/verify '.length).trim());
      if (Number.isInteger(level) && level >= 0 && level <= 5) {
        verificationLevel = level as VerificationLevel;
        transcript.append(chalk.gray(`Verification level set to ${level}.`));
        refreshContextBar();
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

    /** One build-mode task through the gated loop; the caller owns busy/abort. */
    async function executeTaskTurn(task: Task, signal?: AbortSignal): Promise<void> {
      const result = await runChatTurn(engine.sessionManager, task, engine.savings, signal);
      activity.clear();
      if (result.ok) {
        sessionTurns++;
        sessionTokens += result.tokens ?? 0;
        sessionToolCalls += result.toolCalls ?? 0;
        sessionPasses += result.passes ?? 0;
        sessionFailures += result.failures ?? 0;
        if (result.tokensSaved !== undefined) sessionSaved += result.tokensSaved;
        chatView.setReply(result.outcome === 'cancelled' ? '' : (result.finalAnswer ?? ''));
        const statusText =
          result.outcome === 'success'
            ? chalk.green(`completed (${result.outcome})`)
            : result.outcome === 'cancelled'
              ? chalk.yellow('cancelled (interrupted)')
              : chalk.yellow(`finished (${result.outcome})`);
        transcript.append(chalk.gray(`\n[Guppy] ${statusText}`));
        transcript.append(
          renderTurnFooter({
            durationMs: result.durationMs,
            ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
            ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
            ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
            ...(result.passes !== undefined ? { passes: result.passes } : {}),
            ...(result.failures !== undefined ? { failures: result.failures } : {}),
            ...(result.tokensSaved !== undefined ? { tokensSaved: result.tokensSaved } : {}),
          }),
        );
      } else {
        chatView.setReply('');
        transcript.append(chalk.red(`\n[Guppy] Turn failed: ${result.error}`));
      }
    }

    async function runTaskTurn(line: string): Promise<void> {
      busy = true;
      turnAbort = new AbortController();
      transcript.append(chalk.bold(`You: ${line}`));
      activity.set('Working…');
      tui.requestRender();
      await executeTaskTurn(
        {
          id: ulid(),
          description: line,
          repoPath: engine.repoPath,
          tags: [],
          verificationLevel,
          createdAt: now(),
          metadata: { chat: true },
        },
        turnAbort.signal,
      );
      turnAbort = null;
      busy = false;
      refreshContextBar();
      tui.requestRender();
      if (shuttingDown) await finishShutdown();
    }

    /** One read-only planning turn: render the plan + the plan-gate footer. */
    async function runPlanTaskTurn(line: string): Promise<void> {
      busy = true;
      turnAbort = new AbortController();
      transcript.append(chalk.bold(`You: ${line}`));
      activity.set('Planning (read-only)…');
      tui.requestRender();
      const result = await runPlanTurn(
        engine.sessionManager,
        {
          id: ulid(),
          description: line,
          repoPath: engine.repoPath,
          tags: [],
          verificationLevel,
          createdAt: now(),
          metadata: { chat: true, mode: 'plan' },
        },
        engine.savings,
        turnAbort.signal,
      );
      turnAbort = null;
      activity.clear();
      if (result.ok) {
        sessionTurns++;
        sessionTokens += result.tokens ?? 0;
        sessionToolCalls += result.toolCalls ?? 0;
        if (result.tokensSaved !== undefined) sessionSaved += result.tokensSaved;
        pendingPlan = result.plan ?? null;
        // Remember the model's plan + its task id so a later /edit diff is
        // always against the model, and PlanRevised lands on the same task.
        modelPlan = result.plan ?? null;
        planTaskId = result.taskId ?? null;
        if (result.plan) {
          chatView.setReply(result.plan);
          transcript.append(chalk.cyan('\nPlan ready — /build to execute · /edit to revise'));
        } else {
          chatView.setReply('');
          transcript.append(
            chalk.yellow('\n[Guppy] The model produced no plan — describe the task again, or /build to leave plan mode.'),
          );
        }
        transcript.append(
          renderTurnFooter({
            durationMs: result.durationMs,
            ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
            ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
            ...(result.tokensSaved !== undefined ? { tokensSaved: result.tokensSaved } : {}),
          }),
        );
      } else {
        chatView.setReply('');
        transcript.append(chalk.red(`\n[Guppy] Plan failed: ${result.error}`));
      }
      busy = false;
      refreshContextBar();
      tui.requestRender();
      if (shuttingDown) await finishShutdown();
    }

    /** Approve the pending plan and execute it through the gated loop. */
    async function runApprovedBuild(plan: string): Promise<void> {
      busy = true;
      turnAbort = new AbortController();
      activity.set('Executing the approved plan…');
      tui.requestRender();
      const task: Task = {
        id: ulid(),
        description: plan,
        repoPath: engine.repoPath,
        tags: [],
        verificationLevel,
        createdAt: now(),
        metadata: { chat: true, approvedPlan: true },
      };
      emitPlanApproved(engine.eventStore, task.id, ulid(), plan);
      await executeTaskTurn(task, turnAbort.signal);
      turnAbort = null;
      busy = false;
      refreshContextBar();
      tui.requestRender();
      if (shuttingDown) await finishShutdown();
    }

    /**
     * Store a hand-revised plan verbatim (no model call) and re-render it with
     * the plan gate so the user can `/build` it. The revised text replaces the
     * model-produced plan; `PlanApproved` at `/build` records whatever was
     * actually approved.
     */
    const saveRevisedPlan = (text: string): void => {
      const revised = text.trim();
      editingPlan = false;
      if (!revised) {
        // Nothing entered: keep the previous plan, just leave revise mode.
        refreshHint();
        tui.requestRender();
        return;
      }
      // Record the edit against the model's plan before it becomes the new
      // pending plan, so the event log keeps the audit trail.
      if (planTaskId !== null && modelPlan !== null && revised !== modelPlan) {
        emitPlanRevised(engine.eventStore, planTaskId, modelPlan, revised);
      }
      pendingPlan = revised;
      chatView.setReply(revised);
      transcript.append(chalk.cyan('\nPlan ready — /build to execute · /edit to revise'));
      refreshHint();
      tui.requestRender();
    };

    async function submitLine(raw: string): Promise<void> {
      const line = raw.trim();
      editor.setText('');
      editor.addToHistory(raw);
      tui.requestRender();
      if (!line) return;
      // While revising, any command other than /edit cancels the capture and
      // runs normally; a bare message is captured as the revised plan below.
      if (editingPlan && line.startsWith('/') && line !== '/edit' && !line.startsWith('/edit ')) {
        editingPlan = false;
        refreshHint();
      }
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
      if (line === '/theme' || line.startsWith('/theme ')) {
        const mode = line.slice('/theme '.length).trim() as ThemeMode;
        if (mode !== 'dark' && mode !== 'light') {
          transcript.append(chalk.yellow('Usage: /theme <dark|light> (currently ' + themeMode + ').'));
        } else {
          applyTheme(mode);
          transcript.append(chalk.gray(`Theme set to ${mode}.`));
        }
        tui.requestRender();
        return;
      }
      if (line === '/setup' || line.startsWith('/setup ')) {
        setupProvider(line);
        return;
      }
      if (line === '/plan') {
        if (busy) {
          transcript.append(chalk.yellow('Still working — wait for the current turn to finish.'));
        } else if (mode === 'plan') {
          transcript.append(chalk.yellow('Already in plan mode.'));
        } else {
          mode = 'plan';
          pendingPlan = null;
          modelPlan = null;
          planTaskId = null;
          editingPlan = false;
          transcript.append(
            chalk.gray('Plan mode — messages are read-only planning turns (no edits). /build to approve and run.'),
          );
          refreshContextBar();
          refreshHint();
        }
        tui.requestRender();
        return;
      }
      if (line === '/build') {
        if (busy) {
          transcript.append(chalk.yellow('Still working — wait for the current turn to finish.'));
          tui.requestRender();
          return;
        }
        if (mode === 'plan' && pendingPlan) {
          const plan = pendingPlan;
          pendingPlan = null;
          modelPlan = null;
          planTaskId = null;
          editingPlan = false;
          mode = 'build';
          refreshContextBar();
          refreshHint();
          tui.requestRender();
          await runApprovedBuild(plan);
          return;
        }
        if (mode === 'plan' && !pendingPlan) {
          mode = 'build';
          modelPlan = null;
          planTaskId = null;
          editingPlan = false;
          transcript.append(chalk.gray('Build mode — no plan pending. Describe a task to run it.'));
          refreshContextBar();
          refreshHint();
          tui.requestRender();
          return;
        }
        transcript.append(chalk.yellow('Already in build mode.'));
        tui.requestRender();
        return;
      }
      if (line === '/edit' || line.startsWith('/edit ')) {
        if (busy) {
          transcript.append(chalk.yellow('Still working — wait for the current turn to finish.'));
          tui.requestRender();
          return;
        }
        if (!pendingPlan) {
          transcript.append(chalk.yellow('No plan to revise — /plan <task> to produce one first.'));
          tui.requestRender();
          return;
        }
        const inline = line.slice('/edit '.length).trim();
        if (inline) {
          saveRevisedPlan(inline);
        } else {
          editingPlan = true;
          transcript.append(
            chalk.gray('Revise the plan — type your changes (Shift+Enter for newlines), then Enter to save. Ctrl+C cancels.'),
          );
          refreshHint();
          tui.requestRender();
        }
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
      if (editingPlan) {
        saveRevisedPlan(line);
        return;
      }
      if (mode === 'plan') {
        await runPlanTaskTurn(line);
        return;
      }
      await runTaskTurn(line);
    }

    editor.onSubmit = (value: string) => {
      void submitLine(value);
    };

    transcript.appendLines(welcomeLines());
    refreshContextBar();
    tui.start();

    // Auto-detect the terminal scheme once the alt screen is live (best-effort;
    // the OSC query needs the terminal running). Falls back to the dark
    // palette on a non-responding terminal. /theme can override afterwards.
    void tui
      .queryTerminalColorScheme({ timeoutMs: 1_000 })
      .then((scheme) => {
        if (scheme === 'light' || scheme === 'dark') applyTheme(scheme);
      })
      .catch(() => {
        // Unknown scheme: keep the boot-time dark palette.
      });
  });
}
