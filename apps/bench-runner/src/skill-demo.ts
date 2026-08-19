/**
 * Skill-impact demo — deterministic, no LLM required.
 *
 * Proves the Slice 5 claim hermetically: a skill in the agent's context
 * changes behavior and flips the verification gate. The same fixture and a
 * scripted runtime run twice:
 *
 *   - Run A (no skills):  the agent makes a naive cosmetic edit, the gate
 *                         stays red.
 *   - Run B (skill in):   the agent reads the clamp-argument-order skill
 *                         from the context and applies the correct fix, the
 *                         gate goes green.
 *
 * This is the deterministic counterpart of
 * `guppy-bench run --config guppy-core,guppy-core-skill`, which measures the
 * same effect with a real model at scale.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ulid,
  now,
  ok,
  err,
  type Task,
  type Context,
  type Workspace,
  type AgentRuntime,
  type Checkpoint,
  type Trajectory,
  type Result,
  type ULID,
} from '@guppy/contracts';
import { createEventStore, type EventStore } from '@guppy/event-store';
import { createWorkspaceManager, type WorkspaceManager } from '@guppy/workspace';
import { ContextEngine, loadSkills } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import {
  BASE_FILES,
  getTask,
  materializeFixture,
  runTestSuite,
  type BenchTaskSpec,
} from './fixtures.js';
import { readWorktreeFiles } from './runner.js';

/**
 * The only hint the scripted agent has: this skill's body says the clamp
 * argument order in the fixture is wrong and states the correct form.
 */
export const CLAMP_SKILL_FILE = `---
name: clamp-fix
description: The correct clamp implementation is Math.min(Math.max(value, min), max)
tags: clamp, math
---
The clamp function is broken because Math.max(Math.min(value, min), max) returns
min for every input. Write Math.min(Math.max(value, min), max) instead.
`;

/**
 * Scripted runtime: applies the correct fix (undo the seeded mutation) when
 * the `clamp-fix` skill is in the context, otherwise makes a naive cosmetic
 * edit that cannot satisfy the gate. Mirrors a real model that follows the
 * skill's documented ritual vs one that guesses.
 */
class SkillProbeRuntime implements AgentRuntime {
  private workspace: Workspace | null = null;

  constructor(
    private readonly spec: BenchTaskSpec,
    private readonly eventStore: EventStore,
  ) {}

  async initialize(workspace: Workspace): Promise<void> {
    this.workspace = workspace;
  }

  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    const dir = this.workspace?.worktreePath;
    if (!dir) return ok(this.emptyTrajectory(task, context.sessionId));

    // The probe only knows how to fix the fixture when the clamp-fix skill is
    // in the context; without it, it makes a naive cosmetic edit.
    const hasSkill = context.skills.some((s) => s.name.toLowerCase() === 'clamp-fix');
    const mutation = this.spec.mutations[0];
    const changed: string[] = [];

    if (mutation) {
      const abs = join(dir, mutation.file);
      if (hasSkill) {
        const content = readFileSync(abs, 'utf8');
        const fixed = mutation.wholeFile
          ? BASE_FILES[mutation.file] ?? content
          : content.replace(mutation.replace, mutation.find);
        writeFileSync(abs, fixed, 'utf8');
      } else {
        writeFileSync(abs, readFileSync(abs, 'utf8') + '\n// inspected; nothing suspicious\n', 'utf8');
      }
      changed.push(mutation.file);
    }

    for (const path of changed) {
      this.eventStore.append({
        id: ulid(),
        timestamp: now(),
        type: 'FileChanged',
        taskId: task.id,
        sessionId: context.sessionId,
        payload: { path, operation: 'modify' },
      });
    }
    return ok(this.emptyTrajectory(task, context.sessionId));
  }

  private emptyTrajectory(task: Task, sessionId: ULID): Trajectory {
    return {
      id: ulid(),
      taskId: task.id,
      sessionId,
      events: [],
      outcome: 'success',
      metrics: {
        passes: 0,
        failures: 0,
        tokensTotal: 0,
        tokensByModel: {},
        wallTimeMs: 0,
        toolCalls: 1,
        checkpoints: 0,
        contextSelections: 0,
        verificationEscalations: 0,
      },
      startedAt: now(),
      completedAt: now(),
    };
  }

  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return err(new Error('scripted runtime does not support resume'));
  }

  async shutdown(): Promise<void> {
    // Nothing to release.
  }
}

export interface SkillDemoRun {
  gatePassed: boolean;
  suiteGreen: boolean;
  skillInContext: boolean;
}

export interface SkillDemoReport {
  taskId: string;
  /** No skills injected — the naive baseline. */
  runANoSkill: SkillDemoRun;
  /** The clamp-fix skill injected — the treatment. */
  runBWithSkill: SkillDemoRun;
  passed: boolean;
}

export interface SkillDemoOptions {
  outDir: string;
  taskId: string;
}

/** Write the clamp-fix skill into `dir` so `loadSkills` picks it up. */
export function writeClampSkill(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'clamp-fix.md');
  writeFileSync(file, CLAMP_SKILL_FILE, 'utf8');
  return file;
}

async function runProbe(params: {
  spec: BenchTaskSpec;
  runId: string;
  outDir: string;
  skillsDir: string | null;
  workspaceManager: WorkspaceManager;
}): Promise<SkillDemoRun> {
  const { spec, runId, outDir, skillsDir, workspaceManager } = params;
  const fixtureDir = join(outDir, 'fixtures', runId, spec.id);
  materializeFixture(spec, fixtureDir);

  const eventStore = createEventStore({
    rootDir: join(outDir, 'events', runId, spec.id),
  });
  const wsResult = await workspaceManager.createWorkspace(fixtureDir);
  if (!wsResult.ok) throw new Error(`workspace creation failed: ${wsResult.error.message}`);
  const workspace = wsResult.value;
  const worktreeDir = workspace.worktreePath ?? fixtureDir;

  const runtime = new SkillProbeRuntime(spec, eventStore);
  await runtime.initialize(workspace);

  const verifier = createVerificationEngine({
    eventStore,
    workspaceManager,
    projectRoot: worktreeDir,
    timeout: 120_000,
  });
  verifier.setWorkspace(workspace.id);

  const contextEngine = new ContextEngine();
  const task: Task = {
    id: ulid(),
    description: spec.description,
    repoPath: worktreeDir,
    tags: [spec.kind, runId],
    verificationLevel: 3,
    createdAt: now(),
    metadata: { benchTaskId: spec.id },
  };

  try {
    const ctxResult = contextEngine.selectContext({
      task,
      availableFiles: readWorktreeFiles(worktreeDir),
      testResults: [],
      errors: [],
      memories: [],
      skills: skillsDir ? loadSkills(skillsDir) : [],
    });
    if (!ctxResult.ok) throw new Error(`context selection failed: ${ctxResult.error.message}`);
    const context = ctxResult.value;
    const skillInContext = context.skills.some((s) => s.name.toLowerCase() === 'clamp-fix');

    await runtime.run(task, context);
    const gate = await verifier.verify(3, context, task);
    const gatePassed = gate.ok && gate.value.passed;
    const suite = await runTestSuite(worktreeDir);

    return { gatePassed, suiteGreen: suite.passed, skillInContext };
  } finally {
    await runtime.shutdown();
    await eventStore.close();
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

export async function runSkillDemo(options: SkillDemoOptions): Promise<SkillDemoReport> {
  const spec = getTask(options.taskId);
  if (!spec) throw new Error(`unknown task: ${options.taskId}`);
  if (spec.mutations.length === 0) {
    throw new Error(`skill-demo needs a task with a seeded mutation, got ${spec.id}`);
  }

  const workspaceManager = createWorkspaceManager({
    dockerImage: 'guppy/executor:latest',
    useContainers: false,
    worktreeBase: join(options.outDir, 'worktrees'),
  });

  // The treatment dir holds the clamp-fix skill; the baseline has none.
  const skillsDir = join(options.outDir, 'skills');
  writeClampSkill(skillsDir);

  const runA = await runProbe({
    spec,
    runId: 'skill-demo-baseline',
    outDir: options.outDir,
    skillsDir: null,
    workspaceManager,
  });
  const runB = await runProbe({
    spec,
    runId: 'skill-demo-treatment',
    outDir: options.outDir,
    skillsDir,
    workspaceManager,
  });

  // Fixtures are scratch; keep the skill file + event stores as evidence.
  rmSync(join(options.outDir, 'fixtures'), { recursive: true, force: true });

  return {
    taskId: spec.id,
    runANoSkill: runA,
    runBWithSkill: runB,
    passed:
      !runA.gatePassed &&
      !runA.skillInContext &&
      runB.gatePassed &&
      runB.skillInContext &&
      runB.suiteGreen,
  };
}
