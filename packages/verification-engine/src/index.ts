/**
 * Verification Engine — Layered verification with escalation
 * Level 0: Syntax | 1: Typecheck | 2: Lint | 3: Unit Tests | 4: Property Tests | 5: Integration | 6: Formal
 */

import type {
  VerificationLevel,
  VerificationResult,
  VerificationError,
  Task,
  Context,
  ULID,
  Result,
} from '@guppy/contracts';
import { ulid, now, ok, err } from '@guppy/contracts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { EventStore } from '@guppy/event-store';
import type { WorkspaceManager } from '@guppy/workspace';

export interface VerificationEngineConfig {
  eventStore: EventStore;
  workspaceManager: WorkspaceManager;
  projectRoot: string;
  timeout: number;
}

const LEVEL_NAMES: Record<VerificationLevel, string> = {
  0: 'syntax',
  1: 'typecheck',
  2: 'lint',
  3: 'unit-tests',
  4: 'property-tests',
  5: 'integration-tests',
  6: 'formal-verification',
};

// Tool commands run via `npx --no-install` against the worktree, which the
// workspace manager guarantees carries the repo's node_modules (symlinked
// from the source repo in local mode, bind-mounted in container mode).
// `--no-install` makes a missing tool a hard error instead of downloading a
// fresh one from the registry, and avoids `--prefix <hostPath>`, which a
// container cannot see. Level 3-5 commands run via `npm run` in the worktree
// and resolve the repo's test runners the same way.
//
// Defaults are overridable per project via `guppy.json` (see
// loadGuppyConfig): non-Node repos can gate on pytest, cargo test, make
// test, or any command whose tool is on the PATH.
const DEFAULT_LEVEL_COMMANDS: Record<VerificationLevel, string[]> = {
  0: [], // Syntax errors surface via tsc at level 1; no standalone command
  1: ['tsc', '--noEmit'],
  2: ['eslint', '.', '--ext', '.ts,.tsx'],
  3: ['npm', 'test'],
  4: ['npm', 'run', 'test:property', '--if-present'],
  5: ['npm', 'run', 'test:integration', '--if-present'],
  6: ['dafny', 'verify'], // Unsupported: no tooling setup (CLI rejects -v 6)
};

// ---------------------------------------------------------------------------
// Per-project verification config (`<repo>/guppy.json`)
// ---------------------------------------------------------------------------

/**
 * One level's command override. `alwaysAvailable` skips availability probing
 * (useful when the command itself is the repo's own script runner, e.g.
 * `make` in a repo that always ships a Makefile).
 */
export interface LevelCommandConfig {
  /** Command to run for this level, with the worktree as cwd. */
  command: string[];
  /** Skip availability probing and always run this level. */
  alwaysAvailable?: boolean;
}

export interface GuppyVerificationConfig {
  /** `"1"` … `"6"`; value is `{ command, alwaysAvailable? }` or a bare command array. */
  levels?: Partial<Record<string, LevelCommandConfig | string[]>>;
}

export interface GuppyConfig {
  verification?: GuppyVerificationConfig;
}

/**
 * Read `<projectRoot>/guppy.json`. Returns null when absent or unreadable
 * (a corrupt config logs a warning and falls back to defaults — the gate
 * must never break over its own config).
 */
export function loadGuppyConfig(projectRoot: string): GuppyConfig | null {
  const configPath = join(projectRoot, 'guppy.json');
  if (!existsSync(configPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as GuppyConfig;
  } catch (e) {
    console.warn(
      `[Verification] Could not read ${configPath}: ${e instanceof Error ? e.message : String(e)} — using default levels`,
    );
    return null;
  }
}

/** Normalize a level's config entry; null when the command is invalid. */
export function normalizeLevelCommand(cfg: LevelCommandConfig | string[]): LevelCommandConfig | null {
  const command = Array.isArray(cfg) ? cfg : cfg?.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((c) => typeof c === 'string' && c.trim() !== '')
  ) {
    return null;
  }
  return {
    command,
    ...(Array.isArray(cfg) ? {} : cfg.alwaysAvailable === true ? { alwaysAvailable: true } : {}),
  };
}

/**
 * Portable PATH probe — no subprocess, works on Windows (PATHEXT names) and
 * POSIX. `npm` and other shell-resolvable tools return true.
 */
export function commandOnPath(tool: string): boolean {
  const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        if (statSync(join(dir, tool + ext)).isFile()) return true;
      } catch {
        // Keep looking.
      }
    }
  }
  return false;
}

export class VerificationEngine {
  private config: VerificationEngineConfig;
  private currentWorkspaceId: ULID | null = null;
  /** Effective per-level commands: `guppy.json` overrides on top of defaults. */
  private levelCommands: Record<VerificationLevel, string[]> = { ...DEFAULT_LEVEL_COMMANDS };
  /** Levels the config marks always-available (never skipped by probing). */
  private alwaysAvailableLevels = new Set<VerificationLevel>();
  /**
   * Levels overridden in guppy.json: only these probe the system PATH (a
   * non-Node repo's pytest/cargo/make). Default levels keep their original
   * node_modules-only semantics so a machine's global tsc/eslint never
   * changes behavior the repo didn't opt into.
   */
  private configuredLevels = new Set<VerificationLevel>();

  constructor(config: VerificationEngineConfig) {
    this.config = config;
    const guppy = loadGuppyConfig(config.projectRoot);
    const levels = guppy?.verification?.levels;
    if (levels) {
      for (const [rawLevel, cfg] of Object.entries(levels)) {
        const level = Number(rawLevel);
        if (!Number.isInteger(level) || level < 0 || level > 6) {
          console.warn(`[Verification] guppy.json: ignoring unknown verification level "${rawLevel}"`);
          continue;
        }
        if (cfg === undefined) continue;
        const normalized = normalizeLevelCommand(cfg);
        if (!normalized) {
          console.warn(`[Verification] guppy.json: ignoring invalid command for level ${rawLevel}`);
          continue;
        }
        this.levelCommands[level as VerificationLevel] = normalized.command;
        this.configuredLevels.add(level as VerificationLevel);
        if (normalized.alwaysAvailable) this.alwaysAvailableLevels.add(level as VerificationLevel);
      }
    }
  }

  setWorkspace(workspaceId: ULID): void {
    this.currentWorkspaceId = workspaceId;
  }

  /** Whether a level can actually run in this repo (its tool is installed). */
  levelAvailable(level: VerificationLevel): boolean {
    if (this.alwaysAvailableLevels.has(level)) return true;
    const command = this.levelCommands[level];
    if (command.length === 0) return true;
    return this.resolveTool(command, this.configuredLevels.has(level)) !== 'missing';
  }

  /**
   * Human-readable reason a level can't run, e.g. `'tsc' is not installed in
   * this repo`. Undefined for levels with no tool (level 0) or when the tool
   * is installed. Single wording shared by the engine and the session manager
   * so the same condition never reads two ways.
   */
  levelSkipReason(level: VerificationLevel): string | undefined {
    if (this.alwaysAvailableLevels.has(level)) return undefined;
    const tool = this.levelCommands[level]?.[0];
    if (!tool) return undefined;
    return `'${tool}' is not installed in this repo`;
  }

  async verify(
    level: VerificationLevel,
    context: Context,
    task: Task
  ): Promise<Result<VerificationResult, VerificationError[]>> {
    if (!this.currentWorkspaceId) {
      return err([{
        level,
        file: 'unknown',
        message: 'No workspace set',
        rule: LEVEL_NAMES[level],
      }]);
    }

    console.log(`[Verification] Running level ${level} (${LEVEL_NAMES[level]})`);

    const startTime = Date.now();

    try {
      // Run only the requested level; callers escalate level by level
      const { output, errors } = await this.runLevel(level);

      const passed = errors.length === 0;
      const duration = Date.now() - startTime;

      const verificationResult: VerificationResult = {
        level,
        passed,
        errors,
        duration,
        details: {
          levelsRun: [level],
          command: this.levelCommands[level].join(' '),
        },
      };

      this.logVerificationEvents(level, output, errors, duration, task.id, context.sessionId);

      return ok(verificationResult);
    } catch (e) {
      return err([{
        level,
        file: 'unknown',
        message: e instanceof Error ? e.message : String(e),
        rule: LEVEL_NAMES[level],
      }]);
    }
  }

  private logVerificationEvents(
    level: VerificationLevel,
    output: string,
    errors: VerificationError[],
    duration: number,
    taskId: ULID,
    sessionId: ULID
  ): void {
    if (level === 1) {
      const passed = errors.length === 0;
      this.config.eventStore.append({
        id: ulid(),
        timestamp: now(),
        type: passed ? 'TypecheckPassed' : 'TypecheckFailed',
        taskId,
        sessionId,
        payload: {
          errors: errors.map(e => ({ file: e.file, message: e.message, line: e.line ?? 0 })),
          duration,
        },
      });
      return;
    }

    if (level === 2) {
      const passed = errors.length === 0;
      this.config.eventStore.append({
        id: ulid(),
        timestamp: now(),
        type: passed ? 'LintPassed' : 'LintFailed',
        taskId,
        sessionId,
        payload: {
          errors: errors.map(e => ({ file: e.file, message: e.message, line: e.line ?? 0 })),
          duration,
        },
      });
      return;
    }

    if (level === 0) {
      // Level 0 (syntax) is a no-op with no command and no audit trail.
      return;
    }

    // Test levels: emit one event per test so clustering and memory
    // distillation key on real test names instead of the generic level name
    // ('unit-tests'). Unknown runner output falls back to one suite-level
    // event so the gate still leaves an audit trail.
    const tests = parseTestResults(output);
    if (tests.length === 0) {
      const passed = errors.length === 0;
      tests.push({ name: LEVEL_NAMES[level], status: passed ? 'passed' : 'failed' });
    }

    for (const test of tests) {
      this.config.eventStore.append({
        id: ulid(),
        timestamp: now(),
        type: test.status === 'failed' ? 'TestFailed' : 'TestPassed',
        taskId,
        sessionId,
        payload: {
          id: ulid(),
          name: test.name,
          status: test.status,
          duration,
          ...(test.output !== undefined ? { output: test.output } : {}),
        },
      });
    }
  }

  async escalateAndVerify(
    currentLevel: VerificationLevel,
    context: Context,
    task: Task,
    reason: string
  ): Promise<Result<VerificationResult, VerificationError[]>> {
    const nextLevel = Math.min(currentLevel + 1, 6) as VerificationLevel;

    this.config.eventStore.append({
      id: ulid(),
      timestamp: now(),
      type: 'VerificationEscalated',
      taskId: task.id,
      sessionId: context.sessionId,
      payload: { fromLevel: currentLevel, toLevel: nextLevel, reason },
    });

    console.log(`[Verification] Escalating from ${currentLevel} to ${nextLevel}: ${reason}`);
    return this.verify(nextLevel, context, task);
  }

  private async runLevel(
    level: VerificationLevel
  ): Promise<{ output: string; errors: VerificationError[] }> {
    const command = this.levelCommands[level];
    if (!command || command.length === 0) {
      return { output: '', errors: [] };
    }

    // Node-modules tools (tsc/eslint/dafny) resolve from the worktree's own
    // node_modules via `npx --no-install` (never from the registry); PATH
    // tools (npm/pytest/cargo/make/… from the default ladder or guppy.json)
    // run as-is. The workspace manager guarantees node_modules is present in
    // the worktree — symlinked from the source repo in local mode, bind-
    // mounted in container mode — so resolution never needs the host
    // projectRoot path (which a container cannot see).
    const effective = this.effectiveCommand(level, command);

    const result = await this.config.workspaceManager.exec(this.currentWorkspaceId!, effective, {
      timeout: this.config.timeout,
    });

    if (!result.ok) {
      return {
        output: '',
        errors: [{
          level,
          file: 'unknown',
          message: result.error.message,
          rule: LEVEL_NAMES[level],
        }],
      };
    }

    const execResult = result.value;
    const output = `${execResult.stdout}\n${execResult.stderr}`;
    if (execResult.exitCode !== 0) {
      return { output, errors: this.parseErrors(level, execResult.stdout, execResult.stderr) };
    }

    return { output, errors: [] };
  }

  private parseErrors(level: VerificationLevel, stdout: string, stderr: string): VerificationError[] {
    const errors: VerificationError[] = [];
    const output = stdout + '\n' + stderr;

    switch (level) {
      case 0: // Syntax
      case 1: { // TypeScript
        const tsErrors = output.matchAll(/([^\s:]+)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)/g);
        for (const match of tsErrors) {
          errors.push({
            level,
            file: match[1] ?? 'unknown',
            line: parseInt(match[2] ?? '0', 10),
            column: parseInt(match[3] ?? '0', 10),
            message: match[6] ?? 'unknown error',
            rule: `TS${match[5] ?? '0'}`,
          });
        }
        break;
      }
      case 2: // ESLint (stylish reporter, the default)
        errors.push(...parseLintErrors(output).map(e => ({ ...e, level })));
        break;
      case 3: // Unit tests
      case 4: // Property tests
      case 5: { // Integration tests
        const testFailures = output.matchAll(/(\d+\)\s+)?(.+?)\s+(?:failed|Error:)\s*(.*)/g);
        for (const match of testFailures) {
          errors.push({
            level,
            file: 'test',
            message: (match[2] ?? '') + (match[3] ? ': ' + match[3] : ''),
            rule: 'test-failure',
          });
        }
        break;
      }
    }

    return errors.length > 0 ? errors : [{
      level,
      file: 'unknown',
      message: output.slice(0, 500),
      rule: LEVEL_NAMES[level],
    }];
  }

  // ---------------------------------------------------------------------------
  // Budget-aware verification
  // ---------------------------------------------------------------------------

  async verifyWithBudget(
    context: Context,
    task: Task,
    maxLevel: VerificationLevel = task.verificationLevel
  ): Promise<VerificationResult> {
    let lastResult: VerificationResult = {
      level: 0,
      passed: true,
      errors: [],
      duration: 0,
      details: {},
    };

    // Escalate upward while levels keep passing; a failure stops the ladder —
    // the agent must fix it before stricter (and costlier) levels run.
    for (let level = 0; level <= maxLevel; level++) {
      const command = this.levelCommands[level as VerificationLevel];
      if (command.length > 0 && !this.levelAvailable(level as VerificationLevel)) {
        // A missing tool is an environment condition, never an agent fault:
        // skip the level with a note instead of failing the ladder on it.
        console.log(`[Verification] Level ${level} skipped: ${this.levelSkipReason(level as VerificationLevel)}`);
        lastResult = {
          ...lastResult,
          level: level as VerificationLevel,
          details: { ...lastResult.details, [`level${level}Skipped`]: `${command[0]} not installed` },
        };
        continue;
      }
      const result = await this.verify(level as VerificationLevel, context, task);

      if (!result.ok) {
        return {
          level: level as VerificationLevel,
          passed: false,
          errors: result.error,
          duration: 0,
          details: { error: result.error[0]?.message },
        };
      }

      lastResult = result.value;

      if (!result.value.passed) {
        return lastResult;
      }

      // Passed this level — record escalation before the loop advances
      if (level < maxLevel && level < 6) {
        this.config.eventStore.append({
          id: ulid(),
          timestamp: now(),
          type: 'VerificationEscalated',
          taskId: task.id,
          sessionId: context.sessionId,
          payload: {
            fromLevel: level,
            toLevel: level + 1,
            reason: `Level ${level} passed, escalating to ${level + 1} within budget`,
          },
        });
      }
    }

    return lastResult;
  }

  /**
   * Where a level's command resolves: `npm` (always available), the
   * worktree's node_modules (npx-wrapped), the system PATH (run as-is), or
   * `missing`. The node_modules check covers the symlink in local mode, the
   * bind mount mirror in container mode, and deps installed into the sandbox
   * (which land on the rw-mounted host worktree). `probePath` is true only
   * for guppy.json-configured levels — the PATH check is what makes a
   * non-Node repo's pytest/cargo/make resolvable.
   */
  private resolveTool(command: string[], probePath: boolean): 'npm' | 'node_modules' | 'path' | 'missing' {
    const tool = command[0];
    if (!tool || tool === 'npm') return 'npm';
    for (const binDir of this.binDirs()) {
      if (
        existsSync(join(binDir, tool)) ||
        existsSync(join(binDir, `${tool}.cmd`)) ||
        existsSync(join(binDir, `${tool}.exe`))
      ) {
        return 'node_modules';
      }
    }
    return probePath && commandOnPath(tool) ? 'path' : 'missing';
  }

  /** Worktree node_modules/.bin first (per-workspace), then the source repo's. */
  private binDirs(): string[] {
    const dirs: string[] = [];
    const worktree = this.currentWorkspaceId
      ? this.config.workspaceManager.getWorktreePath(this.currentWorkspaceId)
      : undefined;
    if (worktree) dirs.push(join(worktree, 'node_modules', '.bin'));
    dirs.push(join(this.config.projectRoot, 'node_modules', '.bin'));
    return dirs;
  }

  /** Wrap node-modules tools in `npx --no-install`; npm/PATH commands run as-is. */
  private effectiveCommand(level: VerificationLevel, command: string[]): string[] {
    if (this.resolveTool(command, this.configuredLevels.has(level)) === 'node_modules') {
      return ['npx', '--no-install', ...command];
    }
    return command;
  }
}

// ---------------------------------------------------------------------------
// ESLint output parsing
// ---------------------------------------------------------------------------

/**
 * Parse eslint stylish output (the default reporter) into lint errors.
 *
 * Real eslint 9 output puts the file path on its own header line, then one
 * indented `line:col severity message rule` row per violation (the rule id
 * is right-aligned, so message and rule are separated by runs of spaces):
 *
 *   src/math.ts
 *     2:3  error  Unexpected console statement  no-console
 *
 * A few reporters emit `path:line:col` on one line, so that compact form is
 * accepted as a fallback. Verified against eslint 9.39.5 output.
 */
export function parseLintErrors(output: string): Array<Omit<VerificationError, 'level'>> {
  const errors: Array<Omit<VerificationError, 'level'>> = [];
  let currentFile: string | null = null;
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const header = /^(.+\.(?:tsx?|jsx?|m?[cj]s|vue))$/.exec(line);
    if (header) {
      currentFile = header[1] ?? null;
      continue;
    }
    const row = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w\/-]+)\s*$/.exec(line);
    if (row) {
      errors.push({
        file: currentFile ?? 'unknown',
        line: parseInt(row[1]!, 10),
        column: parseInt(row[2]!, 10),
        message: row[4] ?? 'unknown error',
        rule: row[5] ?? 'unknown-rule',
      });
      continue;
    }
    const compact = /^([^\s:]+?\.(?:tsx?|jsx?|m?[cj]s|vue)):(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w\/-]+)\s*$/.exec(line);
    if (compact) {
      errors.push({
        file: compact[1] ?? 'unknown',
        line: parseInt(compact[2] ?? '0', 10),
        column: parseInt(compact[3] ?? '0', 10),
        message: compact[5] ?? 'unknown error',
        rule: compact[6] ?? 'unknown-rule',
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Test output parsing
// ---------------------------------------------------------------------------

export interface ParsedTestResult {
  name: string;
  status: 'passed' | 'failed';
  output?: string;
}

/**
 * Parse node:test reporter output into per-test results.
 *
 * Understands the default spec reporter (`✔ name (1.2ms)` / `✖ name (1.2ms)`)
 * and falls back to TAP (`ok 1 - name` / `not ok 1 - name`). The spec
 * reporter repeats failing tests in its "failing tests:" summary, so results
 * are deduplicated by name — the first occurrence (the main listing) carries
 * the authoritative status.
 */
export function parseTestResults(output: string): ParsedTestResult[] {
  const results: ParsedTestResult[] = [];
  const seen = new Set<string>();

  const specLine = /^[ \t]*([\u2714\u2716])[ \t]+(.+?)[ \t]+\(\d+(?:\.\d+)?[ \t]*m?s\)[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = specLine.exec(output)) !== null) {
    const status = match[1] === '\u2714' ? 'passed' : 'failed';
    const name = (match[2] ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    results.push({
      name,
      status,
      ...(status === 'failed' ? { output: extractFailureDetail(output, name) } : {}),
    });
  }
  if (results.length > 0) return results;

  const tapLine = /^(not )?ok[ \t]+\d+[ \t]*[-–][ \t]*(.+)$/gm;
  while ((match = tapLine.exec(output)) !== null) {
    const status = match[1] ? 'failed' : 'passed';
    const name = (match[2] ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    results.push({ name, status });
  }

  return results;
}

/** Pull the assertion message out of the spec reporter's failing-test block. */
function extractFailureDetail(output: string, name: string): string {
  const marker = 'failing tests';
  const summary = output.includes(marker) ? output.slice(output.indexOf(marker)) : output;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`[\u2716][ \\t]+${escaped}[ \\t]*\\([^)]*\\)`);
  const found = header.exec(summary);
  if (!found) return `${name} failed`;

  const lines: string[] = [];
  for (const line of summary.slice(found.index + found[0].length).split('\n').slice(1)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (/^[\u2716]/.test(trimmed) || trimmed.startsWith('test at') || trimmed.startsWith('at ')) break;
    lines.push(trimmed);
  }

  const useful = lines.filter(
    (l) => !/^(at |generatedMessage:|code:|actual:|expected:|operator:|diff:)/.test(l),
  );
  const sample = useful.slice(0, 2).join(' | ').trim();
  return (sample || `${name} failed`).slice(0, 500);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVerificationEngine(config: VerificationEngineConfig): VerificationEngine {
  return new VerificationEngine(config);
}