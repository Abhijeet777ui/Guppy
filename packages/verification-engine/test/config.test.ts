/**
 * Per-project verification config (`<repo>/guppy.json`) — overrides the
 * default ladder per level so non-Node repos can gate on pytest, cargo test,
 * make test, or any command whose tool is on the PATH. A missing tool is an
 * environment condition, never an agent fault: it skips with a note.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventStore } from '@guppy/event-store';
import type { WorkspaceManager } from '@guppy/workspace';
import {
  VerificationEngine,
  commandOnPath,
  loadGuppyConfig,
  normalizeLevelCommand,
  type LevelCommandConfig,
} from '../src/index.js';

function fixtureDir(guppyJson: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-verif-config-'));
  if (guppyJson !== null) writeFileSync(join(dir, 'guppy.json'), guppyJson, 'utf8');
  return dir;
}

function makeEngine(projectRoot: string): VerificationEngine {
  const eventStore = { append: () => undefined } as unknown as EventStore;
  const workspaceManager = { getWorktreePath: () => undefined } as unknown as WorkspaceManager;
  return new VerificationEngine({ eventStore, workspaceManager, projectRoot, timeout: 5_000 });
}

describe('loadGuppyConfig', () => {
  it('reads levels from <repo>/guppy.json', () => {
    const dir = fixtureDir(JSON.stringify({ verification: { levels: { '3': ['pytest', '-q'] } } }));
    try {
      const cfg = loadGuppyConfig(dir);
      expect(cfg?.verification?.levels?.['3']).toEqual(['pytest', '-q']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when there is no guppy.json', () => {
    const dir = fixtureDir(null);
    try {
      expect(loadGuppyConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a corrupt guppy.json instead of throwing', () => {
    const dir = fixtureDir('{ not json');
    try {
      expect(loadGuppyConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('normalizeLevelCommand', () => {
  it('accepts a bare command array', () => {
    expect(normalizeLevelCommand(['pytest', '-q'])).toEqual({ command: ['pytest', '-q'] });
  });

  it('accepts an object with alwaysAvailable', () => {
    const cfg: LevelCommandConfig = { command: ['make', 'test'], alwaysAvailable: true };
    expect(normalizeLevelCommand(cfg)).toEqual({ command: ['make', 'test'], alwaysAvailable: true });
  });

  it('rejects empty or non-string commands', () => {
    expect(normalizeLevelCommand([])).toBeNull();
    expect(normalizeLevelCommand([''])).toBeNull();
    expect(normalizeLevelCommand({ command: [] })).toBeNull();
    expect(normalizeLevelCommand({ command: [123 as unknown as string] })).toBeNull();
  });
});

describe('commandOnPath', () => {
  it('finds a real binary and misses a fake one', () => {
    expect(commandOnPath('node')).toBe(true);
    expect(commandOnPath('guppy-definitely-not-a-real-tool')).toBe(false);
  });
});

describe('VerificationEngine config wiring', () => {
  it('overrides level commands from guppy.json and keeps defaults for the rest', () => {
    const dir = fixtureDir(
      JSON.stringify({
        verification: {
          levels: {
            '1': { command: ['guppy-nonexistent-tsc-zzz'] },
            '3': ['node', '--test', 'test/*.test.ts'],
          },
        },
      }),
    );
    try {
      const engine = makeEngine(dir);
      // Level 1 uses the config's tool — missing, so skipped (default tsc
      // is fully replaced; the machine's PATH cannot leak in).
      expect(engine.levelAvailable(1)).toBe(false);
      expect(engine.levelSkipReason(1)).toBe("'guppy-nonexistent-tsc-zzz' is not installed in this repo");
      // Level 3 resolves `node` on the PATH — available with zero node_modules.
      expect(engine.levelAvailable(3)).toBe(true);
      // Unconfigured levels keep defaults: npm-run levels always qualify.
      expect(engine.levelAvailable(4)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('alwaysAvailable skips probing entirely', () => {
    const dir = fixtureDir(
      JSON.stringify({
        verification: { levels: { '2': { command: ['guppy-nonexistent-lint-zzz'], alwaysAvailable: true } } },
      }),
    );
    try {
      const engine = makeEngine(dir);
      expect(engine.levelAvailable(2)).toBe(true);
      expect(engine.levelSkipReason(2)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores invalid levels and commands without breaking the engine', () => {
    const dir = fixtureDir(
      JSON.stringify({
        verification: {
          levels: {
            '9': ['bogus'],
            '3': [],
          },
        },
      }),
    );
    try {
      const engine = makeEngine(dir);
      // Invalid level 3 config → the default npm test ladder stays.
      expect(engine.levelAvailable(3)).toBe(true);
      expect(engine.levelAvailable(0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
