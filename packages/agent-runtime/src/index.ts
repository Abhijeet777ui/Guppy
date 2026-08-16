/**
 * Guppy Agent Runtime — adapters implementing the AgentRuntime contract.
 *
 * - PrimeDaemonRuntime: primary. Drives prime-agent headlessly
 *   (`--mode json`); Prime owns the LLM loop, Guppy wraps it.
 * - PiAgentRuntime: reference / A/B baseline. In-process pi-agent-core
 *   loop for ablation experiments.
 * - PrimeTranscriptParser: pure parser for Prime's JSONL stream,
 *   unit-testable against recorded transcripts.
 */

export * from './prime-daemon-runtime.js';
export * from './pi-agent-runtime.js';
export * from './transcript-parser.js';

/** Selectable runtime backends for `guppy run --runtime <kind>`. */
export type RuntimeKind = 'prime' | 'pi';
