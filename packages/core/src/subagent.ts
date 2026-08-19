/**
 * Recursive subagent tool — the native-to-guppy form of prime's RLM idea.
 *
 * The parent runtime exposes a `subagent` tool. When the model calls it, a
 * child CoreAgentRuntime is spawned on the sub-task with:
 *
 * - its OWN event-store trace (a fresh child taskId + sessionId, so the
 *   child's full run is queryable via `getTrajectory(childTask, childSession)`
 *   and never pollutes the parent's session),
 * - its OWN budget (child maxTurns; a child can also cap per-call with
 *   `max_turns`), and
 * - its OWN verification gate (the same ladder the harness uses, run after
 *   the child finishes, before anything is handed back).
 *
 * The child works in the SAME workspace as the parent (the fold-back is the
 * workspace itself — the child's edits are physically present when the tool
 * returns) and the tool result folds the evidence into the parent turn:
 * outcome, budget usage, the gate verdict, and the files changed.
 *
 * Recursion: a child runtime also carries the tool (with depth-1), so
 * sub-tasks can decompose further — bounded by `maxDepth` and, at every
 * level, by the child's own gate. A runtime with maxDepth <= 0 gets no tool,
 * so the tree always terminates. The child never inherits MCP/extra tools or
 * the context engine — it stays hermetic and focused on its sub-task.
 *
 * The gate is the contract, not the model's self-report: if the child's gate
 * stays red, the tool returns an ERROR so the parent must fix or revert the
 * child's changes before its own gate can pass.
 */

import type { Context, Event, Task, ULID, Workspace } from '@guppy/contracts';
import { now, ulid } from '@guppy/contracts';
import type { EventStore } from '@guppy/event-store';
import { createVerificationEngine } from '@guppy/verification-engine';
import type { WorkspaceManager } from '@guppy/workspace';
import type { ModelConfig } from './model.js';
import type { GuppyTool, ToolExecution } from './tools.js';

export const SUBAGENT_TOOL_NAME = 'subagent';

export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
export const DEFAULT_SUBAGENT_CHILD_MAX_TURNS = 6;
export const DEFAULT_SUBAGENT_VERIFICATION_TIMEOUT_MS = 300_000;
/** Cap on the report handed back to the parent (chars). */
const MAX_REPORT_CHARS = 12_000;

/**
 * Mutable bridge the runtime fills in per run() so the tool (created once in
 * initialize()) can emit through the parent's live event channel, read the
 * parent's task/context, and propagate the parent's abort signal to children.
 * A child runtime gets its own bridge, so nesting stays per-runtime.
 */
export interface SubagentBridge {
  /** The parent run's emit() — both the local trajectory array and the store. */
  emit: ((event: Event) => void) | null;
  signal: AbortSignal | null;
  task: Task | null;
  context: Context | null;
}

export interface SubagentToolEnv {
  eventStore: EventStore;
  workspaceManager: WorkspaceManager;
  model: ModelConfig;
  /** The shared workspace the parent (and therefore the child) works in. */
  workspace: Workspace;
  /** How many levels of children this tool may spawn (0 = no tool). */
  maxDepth: number;
  /** Default child turn budget; a call may lower it, never raise it. */
  childMaxTurns: number;
  /** Timeout for the child's verification gate (ms). */
  childVerificationTimeoutMs: number;
  /** Per-run bridge to the owning runtime. */
  bridge: SubagentBridge;
}

/** Minimal isolated context for a child: no files, memories, or skills. */
function childContext(taskId: ULID, sessionId: ULID): Context {
  return {
    taskId,
    sessionId,
    files: [],
    testResults: [],
    errors: [],
    memories: [],
    skills: [],
    tokensUsed: 0,
    maxTokens: 0,
    selectedAt: now(),
    selectionReasoning: 'subagent spawned by parent (isolated context)',
  };
}

function parseLevel(value: unknown, fallback: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) {
    return value as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0 && n <= 6) return n as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  }
  return fallback as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build the `subagent` tool. Returns null when `maxDepth <= 0` — the caller
 * (a runtime at its recursion floor) simply gets no tool.
 */
export function createSubagentTool(env: SubagentToolEnv): GuppyTool | null {
  if (env.maxDepth <= 0) return null;

  return {
    name: SUBAGENT_TOOL_NAME,
    definition: {
      type: 'function',
      function: {
        name: SUBAGENT_TOOL_NAME,
        description:
          'Spawn a child agent on a separable sub-task (e.g. investigate this failing test, implement this isolated module, write tests for this file, review this diff). The child gets its own context, turn budget, and runs the repo verification gate before returning. Use it ONLY when the sub-task is large enough to be worth a whole bounded agent loop; for small edits just do them yourself. The child\'s changes land in the workspace; if its gate fails you must fix or revert them.',
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'The sub-task for the child agent, fully self-contained (it cannot see this conversation).',
            },
            verification: {
              type: 'number',
              description: 'Verification level for the child\'s gate, 0-6 (default: the parent\'s level).',
            },
            max_turns: {
              type: 'number',
              description: `Child turn budget (default ${env.childMaxTurns}; cannot exceed it).`,
            },
          },
          required: ['task'],
        },
      },
    },
    async execute(args, workspaceId) {
      return runSubagent(env, args, workspaceId);
    },
  };
}

async function runSubagent(
  env: SubagentToolEnv,
  args: Record<string, unknown>,
  workspaceId: ULID,
): Promise<ToolExecution> {
  const taskDescription = typeof args['task'] === 'string' ? args['task'].trim() : '';
  if (!taskDescription) {
    return { output: '', error: 'subagent requires a string `task` (the fully self-contained sub-task)' };
  }

  const parentTask = env.bridge.task;
  const parentContext = env.bridge.context;
  if (!parentTask || !parentContext) {
    return { output: '', error: 'subagent called outside a parent run (no task context)' };
  }

  const childTaskId = ulid();
  const childSessionId = ulid();
  const level = parseLevel(args['verification'], parentTask.verificationLevel);
  const requestedTurns =
    typeof args['max_turns'] === 'number' && Number.isInteger(args['max_turns']) ? args['max_turns'] : undefined;
  const childTurns = Math.max(1, Math.min(requestedTurns ?? env.childMaxTurns, env.childMaxTurns));

  const childTask: Task = {
    id: childTaskId,
    description: taskDescription,
    repoPath: parentTask.repoPath,
    tags: [],
    verificationLevel: level,
    createdAt: now(),
    metadata: {
      parentTaskId: parentTask.id,
      parentSessionId: parentContext.sessionId,
      kind: 'subagent',
    },
  };
  const context = childContext(childTaskId, childSessionId);

  // Record the fork in the parent's trace (both the store and, via the
  // bridge, the parent trajectory). The contract's AgentForked payload was
  // built for exactly this.
  const forked: Event = {
    id: ulid(),
    timestamp: now(),
    type: 'AgentForked',
    taskId: parentTask.id,
    sessionId: parentContext.sessionId,
    payload: { childSessionId, childTaskId, parentContext },
  };
  env.bridge.emit?.(forked);

  // The child's own verification engine: same projectRoot, but a fresh
  // instance so its workspace binding can never clobber the parent's.
  const verificationEngine = createVerificationEngine({
    eventStore: env.eventStore,
    workspaceManager: env.workspaceManager,
    projectRoot: env.workspace.repoPath,
    timeout: env.childVerificationTimeoutMs,
  });
  verificationEngine.setWorkspace(workspaceId);

  // Lazy import breaks the module cycle (runtime.ts -> subagent.ts -> runtime.ts).
  const { createCoreRuntime } = await import('./runtime.js');
  const child = createCoreRuntime({
    eventStore: env.eventStore,
    workspaceManager: env.workspaceManager,
    model: env.model,
    maxTurns: childTurns,
    // Children never stream (quiet), never capture context payloads, and
    // never inherit MCP/extra tools — hermetic by construction.
    stream: false,
    ...(env.maxDepth > 1
      ? {
          subagent: {
            maxDepth: env.maxDepth - 1,
            childMaxTurns: env.childMaxTurns,
            childVerificationTimeoutMs: env.childVerificationTimeoutMs,
          },
        }
      : {}),
  });

  try {
    await child.initialize(env.workspace);
    const childResult = await child.run(childTask, context, env.bridge.signal ?? undefined);
    if (!childResult.ok) {
      return { output: '', error: `subagent failed: ${childResult.error.message}` };
    }
    const trajectory = childResult.value;

    if (trajectory.outcome === 'cancelled') {
      return { output: '', error: 'subagent was cancelled (parent abort propagated)' };
    }
    if (trajectory.outcome === 'failure' && trajectory.error) {
      return { output: '', error: `subagent failed: ${trajectory.error}` };
    }

    // The child's verification gate — the harness decides, not the child.
    const gate = await verificationEngine.verifyWithBudget(context, childTask, level);

    const filesChanged: Array<{ path: string; operation: 'create' | 'modify' | 'delete' }> = [];
    const seen = new Set<string>();
    for (const event of trajectory.events) {
      if (event.type !== 'FileChanged') continue;
      const p = event.payload as { path: string; operation: 'create' | 'modify' | 'delete' };
      if (!seen.has(p.path)) {
        seen.add(p.path);
        filesChanged.push({ path: p.path, operation: p.operation });
      }
    }

    const report = buildSubagentReport({
      taskDescription,
      childSessionId,
      trajectory,
      gate,
      filesChanged,
    });

    // Fold back into the parent trace: the merge verdict IS the gate.
    const merged: Event = {
      id: ulid(),
      timestamp: now(),
      type: 'AgentMerged',
      taskId: parentTask.id,
      sessionId: parentContext.sessionId,
      payload: {
        childSessionId,
        mergeResult: gate.passed ? 'clean' : 'failed',
        ...(gate.passed ? {} : { conflicts: gate.errors.map((e) => e.message).slice(0, 5) }),
        gate: {
          level: gate.level,
          passed: gate.passed,
          errors: gate.errors.map((e) => e.message).slice(0, 10),
          duration: gate.duration,
        },
        filesChanged,
        metrics: trajectory.metrics,
      },
    };
    env.bridge.emit?.(merged);

    if (!gate.passed) {
      const errors = gate.errors.slice(0, 3).map((e) => e.message).join(' | ').slice(0, 500);
      return {
        output: report,
        error: `subagent gate FAILED (level ${gate.level}): ${errors} — the child's changes are in the workspace and may have broken the build. Fix or revert them before finishing.`,
      };
    }

    return { output: report };
  } finally {
    await child.shutdown();
  }
}

function buildSubagentReport(params: {
  taskDescription: string;
  childSessionId: ULID;
  trajectory: { outcome: string; metrics: { tokensTotal: number; toolCalls: number; wallTimeMs: number }; finalAnswer?: string };
  gate: { level: number; passed: boolean; errors: Array<{ message: string }>; duration: number };
  filesChanged: Array<{ path: string; operation: string }>;
}): string {
  const { trajectory, gate, filesChanged } = params;
  const lines: string[] = [
    `Subagent completed (session ${params.childSessionId}):`,
    `Task: ${params.taskDescription}`,
    `Outcome: ${trajectory.outcome} · ${trajectory.metrics.toolCalls} tool calls · ${trajectory.metrics.tokensTotal} tokens · ${formatDuration(trajectory.metrics.wallTimeMs)}`,
    gate.passed
      ? `Gate: PASSED (level ${gate.level}, ${formatDuration(gate.duration)})`
      : `Gate: FAILED (level ${gate.level}, ${formatDuration(gate.duration)}): ${gate.errors
          .slice(0, 3)
          .map((e) => e.message)
          .join(' | ')}`,
    filesChanged.length > 0
      ? `Files changed: ${filesChanged.map((f) => `${f.path} (${f.operation})`).join(', ')}`
      : 'Files changed: none',
  ];
  const summary = trajectory.finalAnswer?.trim();
  if (summary) lines.push('', `Summary: ${summary}`);
  const report = lines.join('\n');
  return report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n…[truncated]` : report;
}

/** Tiny helper so callers can construct an empty bridge for testing. */
export function createSubagentBridge(): SubagentBridge {
  return { emit: null, signal: null, task: null, context: null };
}
