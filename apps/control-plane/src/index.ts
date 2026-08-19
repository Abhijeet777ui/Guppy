/**
 * Control Plane — Main exports
 */

export { SessionManager, createSessionManager } from './session-manager.js';
export {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  latestCheckpoint,
  deleteCheckpoint,
  type RunCheckpoint,
} from './checkpoint.js';
export { ContextEngine } from '@guppy/context-engine';
export { createVerificationEngine } from '@guppy/verification-engine';
export { createEventStore } from '@guppy/event-store';
export { createWorkspaceManager } from '@guppy/workspace';