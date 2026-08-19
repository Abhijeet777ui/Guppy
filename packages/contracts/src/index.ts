/**
 * Guppy Contracts — Shared types, interfaces, and event schemas
 * This is the single source of truth for all cross-package communication.
 */

// ============================================================================
// Base Types
// ============================================================================

export type ULID = string & { readonly __brand: unique symbol };
export type Timestamp = number & { readonly __brand: unique symbol };

export function ulid(): ULID {
  return crypto.randomUUID() as ULID;
}

export function now(): Timestamp {
  return Date.now() as Timestamp;
}

// ============================================================================
// Task & Workspace
// ============================================================================

export interface Task {
  id: ULID;
  description: string;
  repoPath: string;
  tags: string[];
  verificationLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  createdAt: Timestamp;
  metadata: Record<string, unknown>;
}

export interface Workspace {
  id: ULID;
  repoPath: string;
  worktreePath?: string;
  containerId?: string;
  snapshotId?: string;
  createdAt: Timestamp;
}

// ============================================================================
// Context & Memory
// ============================================================================

export interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
  hash: string;
}

export interface TestResult {
  id: ULID;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  output?: string;
  file?: string;
  line?: number;
}

export interface ErrorInfo {
  id: ULID;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  column?: number;
  type: 'syntax' | 'type' | 'runtime' | 'test' | 'verification';
}

export interface Memory {
  id: ULID;
  type: 'trajectory' | 'fix' | 'pattern' | 'skill' | 'decision';
  summary: string;
  detail: unknown;
  tags: string[];
  relevance: number;
  createdAt: Timestamp;
  taskId?: ULID;
}

export interface Skill {
  id: ULID;
  name: string;
  description: string;
  prompt: string;
  code?: string;
  tests?: string;
  tags: string[];
  version: number;
}

export interface Context {
  taskId: ULID;
  sessionId: ULID;
  files: FileContent[];
  testResults: TestResult[];
  errors: ErrorInfo[];
  memories: Memory[];
  skills: Skill[];
  tokensUsed: number;
  maxTokens: number;
  selectedAt: Timestamp;
  selectionReasoning: string;
}

// ============================================================================
// Agent Runtime Interface
// ============================================================================

export interface AgentRuntime {
  initialize(workspace: Workspace): Promise<void>;
  run(task: Task, context: Context, signal?: AbortSignal): Promise<Result<Trajectory, Error>>;
  resume(checkpoint: Checkpoint): Promise<Result<Trajectory, Error>>;
  shutdown(): Promise<void>;
}

export interface Trajectory {
  id: ULID;
  taskId: ULID;
  sessionId: ULID;
  events: Event[];
  outcome: 'success' | 'failure' | 'partial' | 'cancelled' | 'running';
  /**
   * Human-readable error when the runtime itself failed (e.g. the model client
   * threw after exhausting its retries). Absent when the trajectory ran to
   * completion, even if `outcome` is 'failure'.
   */
  error?: string;
  /**
   * The model's final prose answer, recorded when the loop finished with no
   * remaining tool calls. Absent when the run exhausted its turn budget or
   * the runtime itself failed.
   */
  finalAnswer?: string;
  finalState?: Context;
  metrics: TrajectoryMetrics;
  startedAt: Timestamp;
  completedAt?: Timestamp;
}

export interface TrajectoryMetrics {
  passes: number;
  failures: number;
  tokensTotal: number;
  tokensByModel: Record<string, number>;
  wallTimeMs: number;
  toolCalls: number;
  checkpoints: number;
  contextSelections: number;
  verificationEscalations: number;
  /** How many times the runtime compressed the conversation history (long runs). */
  compressions?: number;
}

// ============================================================================
// Event System
// ============================================================================

export type EventType =
  | 'TaskStarted'
  | 'ContextSelected'
  | 'ModelCalled'
  | 'ModelStreamed'
  | 'FinalAnswer'
  | 'ContextCompressed'
  | 'ToolCalled'
  | 'ToolReturned'
  | 'FileChanged'
  | 'TestStarted'
  | 'TestPassed'
  | 'TestFailed'
  | 'TypecheckPassed'
  | 'TypecheckFailed'
  | 'LintPassed'
  | 'LintFailed'
  | 'VerificationEscalated'
  | 'CheckpointCreated'
  | 'AgentForked'
  | 'AgentMerged'
  | 'PlanProduced'
  | 'PlanRevised'
  | 'PlanApproved'
  | 'TrajectoryCompleted';

export interface BaseEvent {
  id: ULID;
  timestamp: Timestamp;
  type: EventType;
  taskId: ULID;
  sessionId: ULID;
  payload: unknown;
}

export interface TaskStartedEvent extends BaseEvent {
  type: 'TaskStarted';
  payload: { task: Task };
}

export interface ContextSelectedEvent extends BaseEvent {
  type: 'ContextSelected';
  payload: {
    included: string[];
    excluded: string[];
    tokens: number;
    reasoning: string;
  };
}

export interface ModelCalledEvent extends BaseEvent {
  type: 'ModelCalled';
  payload: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    callId: ULID;
  };
}

export interface ModelStreamedEvent extends BaseEvent {
  type: 'ModelStreamed';
  payload: {
    model: string;
    /** Accumulated assistant text so far (grows as the model streams). */
    text: string;
    callId: ULID;
  };
}

export interface FinalAnswerEvent extends BaseEvent {
  type: 'FinalAnswer';
  payload: {
    /** The model's final prose answer (recorded when the loop ends with no tool calls). */
    text: string;
  };
}

export interface ContextCompressedEvent extends BaseEvent {
  type: 'ContextCompressed';
  payload: {
    /** Model turns replaced by the recap. */
    turnsCompressed: number;
    messagesBefore: number;
    messagesAfter: number;
    /** Estimated history tokens before/after (chars/4 heuristic). */
    tokensBefore: number;
    tokensAfter: number;
    /** How the recap body was produced (deterministic default; 'llm' when the optional summarizer ran). */
    summarySource?: 'deterministic' | 'llm';
    /** Tokens consumed by the optional LLM summarizer call (0 when deterministic). */
    summaryTokens?: number;
  };
}

export interface ToolCalledEvent extends BaseEvent {
  type: 'ToolCalled';
  payload: {
    tool: string;
    args: unknown;
    modelCallId: ULID;
  };
}

export interface ToolReturnedEvent extends BaseEvent {
  type: 'ToolReturned';
  payload: {
    tool: string;
    result: unknown;
    error?: string;
    duration: number;
  };
}

export interface FileChangedEvent extends BaseEvent {
  type: 'FileChanged';
  payload: {
    path: string;
    operation: 'create' | 'modify' | 'delete';
    diff?: string;
  };
}

export interface TestEvent extends BaseEvent {
  type: 'TestStarted' | 'TestPassed' | 'TestFailed';
  payload: TestResult;
}

export interface TypecheckEvent extends BaseEvent {
  type: 'TypecheckPassed' | 'TypecheckFailed';
  payload: {
    errors: Array<{ file: string; message: string; line: number }>;
    duration: number;
  };
}

export interface LintEvent extends BaseEvent {
  type: 'LintPassed' | 'LintFailed';
  payload: {
    errors: Array<{ file: string; message: string; line: number }>;
    duration: number;
  };
}

export interface VerificationEscalatedEvent extends BaseEvent {
  type: 'VerificationEscalated';
  payload: {
    fromLevel: number;
    toLevel: number;
    reason: string;
  };
}

export interface CheckpointCreatedEvent extends BaseEvent {
  type: 'CheckpointCreated';
  payload: {
    checkpointId: ULID;
    snapshotId: string;
    reason: 'periodic' | 'manual' | 'pre_tool' | 'post_verification';
  };
}

export interface AgentForkedEvent extends BaseEvent {
  type: 'AgentForked';
  payload: {
    childSessionId: ULID;
    childTaskId: ULID;
    parentContext: Context;
  };
}

export interface AgentMergedEvent extends BaseEvent {
  type: 'AgentMerged';
  payload: {
    childSessionId: ULID;
    mergeResult: 'clean' | 'conflict' | 'failed';
    conflicts?: string[];
  };
}

export interface PlanProducedEvent extends BaseEvent {
  type: 'PlanProduced';
  payload: {
    /** The model's read-only plan (the full markdown reply). */
    plan: string;
  };
}

export interface PlanRevisedEvent extends BaseEvent {
  type: 'PlanRevised';
  payload: {
    /** The plan being revised away from (the model-produced plan). */
    previous: string;
    /** The human's revised plan. */
    revised: string;
    /** Line diff from `previous` to `revised` (`-` removed, `+` added, `  ` context). */
    diff: string;
  };
}

export interface PlanApprovedEvent extends BaseEvent {
  type: 'PlanApproved';
  payload: {
    /** The plan the user approved for execution. */
    plan: string;
  };
}

export interface TrajectoryCompletedEvent extends BaseEvent {
  type: 'TrajectoryCompleted';
  payload: {
    outcome: Trajectory['outcome'];
    metrics: TrajectoryMetrics;
    /**
     * Whether the most recent verification/test signal was a pass. Lets
     * reports distinguish "ran out of turns while green" (partial + true)
     * from "ran out of turns still red" (partial + false).
     */
    lastGatePassed?: boolean;
    /** Set when the runtime itself failed (model client error, etc.). */
    error?: string;
    /** The model's final prose answer, when one was produced. */
    finalAnswer?: string;
  };
}

export type Event =
  | TaskStartedEvent
  | ContextSelectedEvent
  | ModelCalledEvent
  | ModelStreamedEvent
  | FinalAnswerEvent
  | ContextCompressedEvent
  | ToolCalledEvent
  | ToolReturnedEvent
  | FileChangedEvent
  | TestEvent
  | TypecheckEvent
  | LintEvent
  | VerificationEscalatedEvent
  | CheckpointCreatedEvent
  | AgentForkedEvent
  | AgentMergedEvent
  | PlanProducedEvent
  | PlanRevisedEvent
  | PlanApprovedEvent
  | TrajectoryCompletedEvent;

// ============================================================================
// Checkpoint & Snapshot
// ============================================================================

export interface Checkpoint {
  id: ULID;
  taskId: ULID;
  sessionId: ULID;
  trajectoryId: ULID;
  eventIndex: number;
  snapshotId: string;
  context: Context;
  createdAt: Timestamp;
  reason: 'periodic' | 'manual' | 'pre_tool' | 'post_verification';
}

export interface Snapshot {
  id: ULID;
  workspaceId: ULID;
  containerSnapshotId?: string;
  fsSnapshotPath: string;
  createdAt: Timestamp;
  size: number;
}

// ============================================================================
// Verification
// ============================================================================

export type VerificationLevel =
  | 0  // Syntax only
  | 1  // Type checking
  | 2  // Lint / static analysis
  | 3  // Unit tests
  | 4  // Property tests
  | 5  // Integration tests
  | 6; // Formal verification

export interface VerificationResult {
  level: VerificationLevel;
  passed: boolean;
  errors: VerificationError[];
  duration: number;
  details: Record<string, unknown>;
}

export interface VerificationError {
  level: VerificationLevel;
  file: string;
  message: string;
  line?: number;
  column?: number;
  rule?: string;
}

// ============================================================================
// Utility Types
// ============================================================================

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}