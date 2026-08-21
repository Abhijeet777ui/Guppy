/**
 * Headless real-model TUI sign-off driver (roadmap 0.4).
 *
 * Boots the REAL `runTui` against a virtual terminal with the REAL engine
 * (model + provider + key from ~/.guppy/config.json), drives one turn on a
 * red clamp fixture, and dumps the rendered screens at each checkpoint —
 * the "headless-verified screenshot" evidence for the M1-M3 visual sign-off.
 *
 * Usage: node .scratch/tui-signoff.mjs [fixtureDir]
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTui } from '../dist/tui.js';
import { formatScreen, renderAnsiScreen } from '../dist/ansi-screen.js';
import { stripAnsi } from '../dist/tui-logic.js';
import { loadUserConfig, resolveRuntimeOptions } from '../../../packages/models/dist/index.js';

const fixtureDir = process.argv[2] ?? join(mkdtempSync(join(tmpdir(), 'guppy-signoff-')), 'fixture');

// Red clamp fixture (same shape as the bench bugfix-clamp).
const PACKAGE_JSON = JSON.stringify({
  name: 'signoff-fixture',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/*.test.ts' },
});
const TEST_FILE = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/math.ts';\n\ntest('clamp keeps values inside the range', () => {\n  assert.equal(clamp(5, 0, 10), 5);\n  assert.equal(clamp(-3, 0, 10), 0);\n  assert.equal(clamp(15, 0, 10), 10);\n});\n`;
const BROKEN_SRC = `export function clamp(v: number, min: number, max: number): number {\n  return Math.max(Math.min(v, min), max);\n}\n`;

mkdirSync(join(fixtureDir, 'src'), { recursive: true });
mkdirSync(join(fixtureDir, 'test'), { recursive: true });
writeFileSync(join(fixtureDir, 'package.json'), PACKAGE_JSON, 'utf8');
writeFileSync(join(fixtureDir, 'src', 'math.ts'), BROKEN_SRC, 'utf8');
writeFileSync(join(fixtureDir, 'test', 'math.test.ts'), TEST_FILE, 'utf8');

class FakeTerminal {
  output = '';
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  constructor() {}
  start(onInput, onResize) {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop() {}
  async drainInput() {}
  write(data) {
    this.output += data;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  emit(data) {
    this.onInput?.(data);
  }
  onInput = null;
  get text() {
    return stripAnsi(this.output);
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Resolve the key exactly as the CLI does: explicit flags win, then the
// per-user config preset. The script passes provider+model explicitly, so the
// groq preset's apiKey lands in the runtime.
const resolved = resolveRuntimeOptions(
  { model: 'qwen/qwen3.6-27b', provider: 'groq' },
  loadUserConfig(),
);
if (!resolved.apiKey) {
  console.error('[Guppy] No groq API key in ~/.guppy/config.json — run: guppy config set groq <key>');
  process.exit(1);
}

const fake = new FakeTerminal();
// runTui swaps console.log while the alt screen is live; capture the real
// one first so the screen dumps below actually print.
const realLog = console.log.bind(console);
// runTui's default is ProcessTerminal; pass the virtual one.
const tuiPromise = runTui(
  {
    repoPath: fixtureDir,
    runtime: 'core',
    model: resolved.model,
    provider: resolved.provider,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    maxTurns: 6,
    verificationLevel: 3,
    quiet: true,
    local: true,
    keepWorktree: true,
    worktreeBase: join(fixtureDir, '..', 'worktrees'),
  },
  fake,
);

const dump = (label) => {
  realLog(String.fromCharCode(10) + formatScreen(renderAnsiScreen(fake.output, fake.rows, fake.columns), label));
};

try {
  await waitFor(() => fake.text.includes('Chat mode'), 30_000, 'boot');
  await new Promise((r) => setTimeout(r, 300));
  dump('1. boot — build mode (real Groq model)');

  for (const ch of 'fix the clamp so the tests pass') fake.emit(ch);
  fake.emit(String.fromCharCode(13));
  try {
    await waitFor(() => /completed \(success\)|finished \(|Turn failed/.test(fake.text), 240_000, 'turn completion');
  } catch (e) {
    dump('TIMEOUT — last screen');
    throw e;
  }
  await new Promise((r) => setTimeout(r, 400));
  dump('2. after a real chat turn (reply + footer)');

  fake.emit(String.fromCharCode(3)); // Ctrl+C → exit
  await tuiPromise;
} finally {
  fake.emit(String.fromCharCode(3));
  await Promise.race([
    tuiPromise.catch(() => {}),
    new Promise((r) => setTimeout(r, 8_000)),
  ]);
  rmSync(join(fixtureDir, '..', 'worktrees'), { recursive: true, force: true });
}
