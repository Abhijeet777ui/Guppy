import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@earendil-works/pi-tui';
import { pickModel, runSetupWizard } from '../src/pickers.js';
import { stripAnsi } from '../src/tui-logic.js';

/** Minimal in-memory pi-tui `Terminal` (mirrors the chat.test.ts harness). */
class FakeTerminal implements Terminal {
  output = '';
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  private onInput: ((data: string) => void) | null = null;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  /** Feed raw keystrokes through the TUI's real input pipeline. */
  emit(data: string): void {
    this.onInput?.(data);
  }

  get text(): string {
    return stripAnsi(this.output);
  }
}

function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('pickModel — live list from the provider', () => {
  it('lists live models and returns the arrow-selected one with the base URL', async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] })) as typeof fetch;

    const fake = new FakeTerminal();
    const promise = pickModel(fake, 'groq', 'gk-123');

    await waitFor(() => fake.text.includes('Pick a model for groq'));
    expect(fake.text).toContain('Live models from groq');
    expect(fake.text).toContain('model-a');

    // Arrow down to model-b, Enter to select.
    fake.emit('\u001b[B');
    fake.emit('\r');

    const result = await promise;
    expect(result).toEqual({ model: 'model-b', baseUrl: 'https://api.groq.com/openai/v1' });
  });

  it('falls back to the catalog when the live fetch fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const fake = new FakeTerminal();
    const promise = pickModel(fake, 'groq', 'gk-123');

    await waitFor(() => fake.text.includes('Pick a model for groq'));
    expect(fake.text).toContain('Catalog models for groq');

    fake.emit('\r');
    const result = await promise;
    expect(result?.model).toBeTruthy();
  });

  it('returns null when cancelled with Escape', async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] })) as typeof fetch;

    const fake = new FakeTerminal();
    const promise = pickModel(fake, 'groq', 'gk-123');
    await waitFor(() => fake.text.includes('Pick a model for groq'));
    fake.emit('\u001b');
    await expect(promise).resolves.toBeNull();
  });
});

describe('runSetupWizard — provider, key, live model', () => {
  it('walks the whole flow and returns the picks', async () => {
    // The curated provider list leads with groq, so Enter on the first screen
    // selects it; the live model fetch then feeds the model picker.
    globalThis.fetch = (async () =>
      fakeResponse({
        data: [{ id: 'qwen/qwen3.6-27b' }, { id: 'llama-3.3-70b-versatile' }],
      })) as typeof fetch;

    const fake = new FakeTerminal();
    const promise = runSetupWizard(fake);

    // Step 1: provider picker → Enter selects groq (curated first).
    await waitFor(() => fake.text.includes('Pick a provider'));
    fake.emit('\r');

    // Step 2: key input → type the key, then Enter.
    await waitFor(() => fake.text.includes('Paste your API key for groq'));
    for (const ch of 'gk-123') fake.emit(ch);
    fake.emit('\r');

    // Step 3: model picker → live models listed (sorted), Enter selects the
    // first, which is llama-3.3-70b-versatile (alphabetically before qwen).
    await waitFor(() => fake.text.includes('Pick a model for groq'));
    expect(fake.text).toContain('llama-3.3-70b-versatile');
    fake.emit('\r');

    const result = await promise;
    expect(result).toEqual({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gk-123',
    });
  });

  it('cancels cleanly when the provider step is escaped', async () => {
    const fake = new FakeTerminal();
    const promise = runSetupWizard(fake);
    await waitFor(() => fake.text.includes('Pick a provider'));
    fake.emit('\u001b');
    await expect(promise).resolves.toBeNull();
  });
});
