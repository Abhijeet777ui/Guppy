/**
 * Model catalog — a thin, lazy facade over the pi-ai built-in model registry.
 *
 * Guppy's core runtime speaks only OpenAI-compatible `/chat/completions`, so
 * this package marks which catalog entries are directly usable (`api ===
 * 'openai-completions'`) and exposes the rest (anthropic-messages,
 * google-generative-ai, openai-responses, …) as informational metadata that
 * needs a different client. pi-ai types are intentionally confined to this
 * adapter package; they never leak into `@guppy/core`.
 */

import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';

export interface CatalogProvider {
  id: string;
  name: string;
  /** Provider base URL; undefined for dynamic providers without a static one. */
  baseUrl: string | undefined;
  modelCount: number;
  coreCompatibleCount: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  inputKinds: readonly ('text' | 'image')[];
  inputCost: number;
  outputCost: number;
  /** True when the core runtime can drive this model directly. */
  coreCompatible: boolean;
  thinkingLevels: readonly ModelThinkingLevel[];
}

export interface ListModelsOptions {
  /** Restrict to a single provider id (e.g. 'groq', 'openrouter'). */
  provider?: string;
  /** Case-insensitive substring match on model id and name. */
  query?: string;
  /** Only return models the core runtime can drive directly. */
  coreCompatibleOnly?: boolean;
  /** Max results to return (default: no limit). */
  limit?: number;
}

/** The API ids Guppy's OpenAI-compatible client can drive. */
const CORE_COMPATIBLE_APIS = new Set<string>(['openai-completions']);

export function isCoreCompatible(model: Model<Api>): boolean {
  return CORE_COMPATIBLE_APIS.has(model.api);
}

let registry: ReturnType<typeof builtinModels> | null = null;

/** Lazily construct the registry (its generated catalog is large). */
function models(): ReturnType<typeof builtinModels> {
  registry ??= builtinModels();
  return registry;
}

function toCatalogModel(model: Model<Api>, providerId: string): CatalogModel {
  return {
    id: model.id,
    name: model.name || model.id,
    provider: providerId,
    baseUrl: model.baseUrl,
    api: model.api,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    inputKinds: model.input,
    inputCost: model.cost.input,
    outputCost: model.cost.output,
    coreCompatible: isCoreCompatible(model),
    thinkingLevels: model.reasoning ? getSupportedThinkingLevels(model) : [],
  };
}

export function listProviders(): CatalogProvider[] {
  return models()
    .getProviders()
    .map((p) => {
      const all = p.getModels();
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        modelCount: all.length,
        coreCompatibleCount: all.filter(isCoreCompatible).length,
      };
    })
    .filter((p) => p.modelCount > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function listModels(options: ListModelsOptions = {}): CatalogModel[] {
  const providers = options.provider
    ? models().getProviders().filter((p) => p.id === options.provider)
    : models().getProviders();
  const needle = options.query?.trim().toLowerCase();

  const out: CatalogModel[] = [];
  for (const p of providers) {
    for (const model of p.getModels()) {
      const compatible = isCoreCompatible(model);
      if (options.coreCompatibleOnly && !compatible) continue;
      if (
        needle &&
        !model.id.toLowerCase().includes(needle) &&
        !model.name.toLowerCase().includes(needle)
      ) {
        continue;
      }
      out.push(toCatalogModel(model, p.id));
      if (options.limit !== undefined && out.length >= options.limit) return out;
    }
  }
  return out;
}

/**
 * Raw registry lookup. pi-ai's `Model` type leaks here on purpose — this is
 * the adapter package. When `provider` is omitted the id is matched globally,
 * preferring the first core-compatible hit (so an unambiguous id like
 * `qwen/qwen3.6-27b` resolves without knowing the provider).
 */
export function findModel(provider: string | undefined, id: string): Model<Api> | undefined {
  if (provider) {
    return models().getProvider(provider)?.getModels().find((m) => m.id === id);
  }
  for (const p of models().getProviders()) {
    const hit = p.getModels().find((m) => m.id === id);
    if (hit && isCoreCompatible(hit)) return hit;
  }
  for (const p of models().getProviders()) {
    const hit = p.getModels().find((m) => m.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Guppy-safe catalog metadata for a single model, or undefined. */
export function describeModel(provider: string | undefined, id: string): CatalogModel | undefined {
  if (provider) {
    const hit = models().getProvider(provider)?.getModels().find((m) => m.id === id);
    return hit ? toCatalogModel(hit, provider) : undefined;
  }
  const hit = findModel(undefined, id);
  return hit ? toCatalogModel(hit, hit.provider) : undefined;
}
