/**
 * M2 picker screens — arrow-key selection for setup and chat launch.
 *
 * Standalone pi-tui screens (each boots its own alt-screen TUI) so the user
 * never has to type a provider id or model name from memory: pick a provider
 * with up/down, paste the key, then pick a model from the provider's *live*
 * model list (fetched from its real /models endpoint, falling back to the
 * catalog).
 *
 * The screens are deliberately small — title, one list/input, hint — matching
 * the §5 onboarding wireframes. Each returns the chosen value (or null when
 * the user cancels with Esc/Ctrl+C); callers own persistence.
 */

import {
  Input,
  ProcessTerminal,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
  isViewportTUI,
  matchesKey,
} from '@earendil-works/pi-tui';
import type { SelectItem, Terminal } from '@earendil-works/pi-tui';
import {
  fetchLiveModels,
  listModels,
  listProviders,
  type CatalogProvider,
} from '@guppy/models';
import { compactTokens, selectListTheme } from './tui-logic.js';

/** A model option shown in a picker: the id the runtime will receive. */
export interface ModelOption {
  /** Model id sent to the endpoint (live id or catalog id). */
  model: string;
  /** Provider base URL so a live model works even when not in the catalog. */
  baseUrl?: string;
}

export interface LaunchPick {
  provider: string;
  model: string;
  /** Provider base URL (catalog) so the runtime hits the right endpoint. */
  baseUrl?: string;
  apiKey?: string;
}

/** Provider ids the launch story targets first (Groq / OpenRouter / …). */
const POPULAR = ['groq', 'openrouter', 'google', 'openai', 'ollama', 'nvidia'];

function catalogBaseUrl(provider: string): string | undefined {
  return listProviders().find((p) => p.id === provider)?.baseUrl;
}

function curatedProviders(): CatalogProvider[] {
  const all = listProviders().filter((p) => p.coreCompatibleCount > 0);
  const byPop = new Map(all.map((p) => [p.id, p]));
  const ordered: CatalogProvider[] = [];
  for (const id of POPULAR) {
    const p = byPop.get(id);
    if (p) ordered.push(p);
    byPop.delete(id);
  }
  ordered.push(...byPop.values());
  return ordered;
}

function providerItems(providers: CatalogProvider[]): SelectItem[] {
  return providers.map((p) => ({
    value: p.id,
    label: `${p.id} — ${p.name}`,
    description: `${p.modelCount} models (${p.coreCompatibleCount} core)`,
  }));
}

/** Sort model ids so free-tier (:free suffix) entries lead. */
function orderLiveModels(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const af = a.includes(':free') ? 0 : 1;
    const bf = b.includes(':free') ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.localeCompare(b);
  });
}

/**
 * Turn live model ids (no catalog metadata) or catalog models into picker
 * items. Live ids are shown plainly; catalog models get ctx/max info.
 */
function modelItems(ids: string[]): SelectItem[] {
  const known = new Map(listModels({ coreCompatibleOnly: true }).map((m) => [m.id, m]));
  return ids.map((id) => {
    const m = known.get(id);
    return {
      value: id,
      label: id,
      description: m
        ? `ctx ${compactTokens(m.contextWindow)} · max ${compactTokens(m.maxTokens)}${m.reasoning ? ' · reasoning' : ''}`
        : 'live',
    };
  });
}

/** One arrow-key list screen. Resolves with the item, or null on cancel. */
function runListPicker(opts: {
  terminal: Terminal;
  title: string;
  hint: string;
  items: SelectItem[];
  maxVisible?: number;
}): Promise<SelectItem | null> {
  return new Promise((resolve) => {
    const tui = new TuiAltScreen(opts.terminal);
    const title = new Text(opts.title, 0, 0);
    const hint = new Text(opts.hint, 0, 0);
    const list = new SelectList(opts.items, opts.maxVisible ?? 10, selectListTheme());
    let done = false;
    const finish = (item: SelectItem | null): void => {
      if (done) return;
      done = true;
      tui.stop();
      resolve(item);
    };
    list.onSelect = (item) => finish(item);
    list.onCancel = () => finish(null);
    // SelectList isn't focusable (no `focused`), so forward navigation keys
    // from the TUI and re-render after each change.
    tui.addInputListener((data) => {
      if (
        matchesKey(data, 'up') ||
        matchesKey(data, 'down') ||
        matchesKey(data, 'enter') ||
        matchesKey(data, 'escape') ||
        matchesKey(data, 'ctrl+c')
      ) {
        list.handleInput(data);
        tui.requestRender();
        return { consume: true };
      }
      return undefined;
    });
    if (isViewportTUI(tui)) {
      tui.setLayoutRoot(
        new VStack([
          { component: title, basis: 'auto', shrink: 1, minSize: 1 },
          { component: list, basis: 0, grow: 1, minSize: 1 },
          { component: hint, basis: 'auto', shrink: 1, minSize: 1 },
        ]),
      );
    }
    tui.start();
  });
}

/** One single-line text input screen. Resolves with the value, or null. */
function runKeyInput(opts: {
  terminal: Terminal;
  title: string;
  hint: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const tui = new TuiAltScreen(opts.terminal);
    const title = new Text(opts.title, 0, 0);
    const hint = new Text(opts.hint, 0, 0);
    const input = new Input();
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      tui.stop();
      resolve(value);
    };
    input.onSubmit = (value) => finish(value);
    input.onEscape = () => finish(null);
    tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        finish(null);
        return { consume: true };
      }
      return undefined;
    });
    if (isViewportTUI(tui)) {
      tui.setLayoutRoot(
        new VStack([
          { component: title, basis: 'auto', shrink: 1, minSize: 1 },
          { component: input, basis: 'auto', shrink: 1, minSize: 1 },
          { component: hint, basis: 'auto', shrink: 1, minSize: 1 },
        ]),
      );
    }
    tui.setFocus(input);
    tui.start();
  });
}

/** Pick a provider with arrow keys. Returns the provider id, or null. */
export async function pickProvider(terminal: Terminal): Promise<string | null> {
  const providers = curatedProviders();
  const item = await runListPicker({
    terminal,
    title: 'Pick a provider',
    hint: 'up/down navigate · Enter select · Esc/Ctrl+C cancel',
    items: providerItems(providers),
  });
  return item?.value ?? null;
}

/**
 * Pick a model for a provider. Tries the provider's *live* /models endpoint
 * first (the models that key can actually call); on any failure falls back to
 * the static catalog. Returns the model id + provider base URL, or null.
 */
export async function pickModel(
  terminal: Terminal,
  provider: string,
  apiKey: string | undefined,
): Promise<ModelOption | null> {
  const baseUrl = catalogBaseUrl(provider);
  const live = await fetchLiveModels(provider, apiKey, baseUrl);
  let ids: string[];
  let source: 'live' | 'catalog';
  if (live.ok && live.models && live.models.length > 0) {
    ids = orderLiveModels(live.models);
    source = 'live';
  } else {
    ids = listModels({ provider, coreCompatibleOnly: true }).map((m) => m.id);
    source = 'catalog';
  }
  const item = await runListPicker({
    terminal,
    title: `Pick a model for ${provider}`,
    hint:
      source === 'live'
        ? `Live models from ${provider} (${ids.length}) · up/down navigate · Enter select · Esc cancel`
        : `Catalog models for ${provider} (live list unavailable) · up/down navigate · Enter select · Esc cancel`,
    items: modelItems(ids),
    maxVisible: 12,
  });
  if (!item) return null;
  return { model: item.value, ...(baseUrl !== undefined ? { baseUrl } : {}) };
}

/**
 * The M2 onboarding wizard: provider → API key → live model picker. Returns
 * the picks so the caller can persist them; null means the user cancelled.
 */
export async function runSetupWizard(
  terminal: Terminal = new ProcessTerminal(),
): Promise<LaunchPick | null> {
  const provider = await pickProvider(terminal);
  if (!provider) return null;

  const baseUrl = catalogBaseUrl(provider);
  const noKey = ['ollama', 'lmstudio', 'lm-studio', 'local', 'vllm'].includes(provider);
  let apiKey: string | undefined;
  if (!noKey) {
    const key = await runKeyInput({
      terminal,
      title: `Paste your API key for ${provider}`,
      hint: 'Paste the key, then Enter · Esc/Ctrl+C cancel (stored in ~/.guppy/config.json)',
    });
    if (key === null) return null;
    const trimmed = key.trim();
    if (trimmed === '') return null;
    apiKey = trimmed;
  }

  const picked = await pickModel(terminal, provider, apiKey);
  if (!picked) return null;
  const modelBaseUrl = picked.baseUrl ?? baseUrl;
  return {
    provider,
    model: picked.model,
    ...(modelBaseUrl !== undefined ? { baseUrl: modelBaseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

/**
 * The chat-launch picker: provider (preferring configured keys / no-key
 * providers) → live model list → the runtime options for this session.
 */
export async function runLaunchPicker(
  terminal: Terminal = new ProcessTerminal(),
  config: { providers: Record<string, { apiKey?: string }> },
): Promise<LaunchPick | null> {
  const all = curatedProviders();
  const noKeyIds = ['ollama', 'lmstudio', 'lm-studio', 'local', 'vllm'];
  const keyed = all.filter((p) => {
    const preset = config.providers[p.id];
    return preset?.apiKey || noKeyIds.includes(p.id);
  });
  const rest = all.filter((p) => !keyed.includes(p));
  const item = await runListPicker({
    terminal,
    title: 'Pick a provider',
    hint: 'up/down navigate · Enter select · Esc/Ctrl+C cancel',
    items: providerItems([...keyed, ...rest]),
  });
  const provider = item?.value ?? null;
  if (!provider) return null;

  const preset = config.providers[provider];
  const apiKey = preset?.apiKey;
  const picked = await pickModel(terminal, provider, apiKey);
  if (!picked) return null;
  const baseUrl = picked.baseUrl ?? catalogBaseUrl(provider);
  return {
    provider,
    model: picked.model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}
