/**
 * @guppy/models — model catalog + selection.
 *
 * The pi-ai-facing adapter: browse the built-in model registry and map a
 * selection into Guppy's own `ModelConfig`, including per-provider
 * thinking/reasoning passthrough. pi-ai types are confined to this package.
 */

export type {
  CatalogProvider,
  CatalogModel,
  ListModelsOptions,
} from './catalog.js';
export type { LiveModelsResult } from './live-models.js';
export { fetchLiveModels } from './live-models.js';
export {
  isCoreCompatible,
  listProviders,
  listModels,
  findModel,
  describeModel,
} from './catalog.js';
export type { ThinkingFormat, ThinkingLevel } from './thinking.js';
export { detectThinkingFormat, buildThinkingBody, THINKING_LEVELS } from './thinking.js';
export type { ModelSelection } from './config.js';
export { toModelConfig, selectModel } from './config.js';
export type {
  ProviderPreset,
  DefaultModel,
  UserConfig,
  RuntimeFlags,
  ResolvedRuntime,
} from './user-config.js';
export {
  defaultConfigPath,
  loadUserConfig,
  saveUserConfig,
  maskKey,
  resolveRuntimeOptions,
  hasAnyApiKey,
  isNoKeyProvider,
} from './user-config.js';
