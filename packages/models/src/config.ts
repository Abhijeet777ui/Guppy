/**
 * Catalog → `ModelConfig` mapping.
 *
 * The single place a model selection becomes Guppy's own runtime config.
 * `ModelConfig` stays the source of truth; pi-ai types never cross into
 * `@guppy/core`, and the core client never learns about providers.
 */

import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelConfig } from '@guppy/core';
import { findModel } from './catalog.js';
import { buildThinkingBody } from './thinking.js';

export interface ModelSelection {
  /** Model id as it appears in the catalog (e.g. 'qwen/qwen3.6-27b'). */
  model: string;
  /** Provider id (e.g. 'groq'); optional when the id is unambiguous. */
  provider?: string;
  /** Override the catalog base URL. */
  baseUrl?: string;
  /** Explicit API key (else resolved from the provider env var). */
  apiKey?: string;
  /** Max completion tokens (unset = endpoint default). */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Reasoning level; only applies when the model supports reasoning. */
  thinkingLevel?: ModelThinkingLevel;
  /** Client-side requests/minute pacing. */
  requestsPerMinute?: number;
}

/**
 * Build a Guppy `ModelConfig` from a raw catalog model plus optional
 * overrides. Provider id, model id, and base URL come from the catalog; the
 * rest are only set when explicitly requested (catalog `maxTokens` is display
 * metadata, not a request default, since some entries report the context
 * window rather than a sane output cap).
 */
export function toModelConfig(
  model: Model<Api>,
  selection: Omit<ModelSelection, 'model' | 'provider'> = {},
): ModelConfig {
  const extraBody =
    selection.thinkingLevel !== undefined
      ? buildThinkingBody(model, selection.thinkingLevel)
      : undefined;
  return {
    provider: model.provider,
    model: model.id,
    baseUrl: selection.baseUrl ?? model.baseUrl,
    ...(selection.apiKey !== undefined ? { apiKey: selection.apiKey } : {}),
    ...(selection.maxTokens !== undefined ? { maxTokens: selection.maxTokens } : {}),
    ...(selection.temperature !== undefined ? { temperature: selection.temperature } : {}),
    ...(selection.requestsPerMinute !== undefined
      ? { requestsPerMinute: selection.requestsPerMinute }
      : {}),
    ...(extraBody !== undefined ? { extraBody } : {}),
  };
}

/**
 * Resolve a selection to a `ModelConfig`, or undefined when the model id can't
 * be found in the catalog.
 */
export function selectModel(selection: ModelSelection): ModelConfig | undefined {
  const model = findModel(selection.provider, selection.model);
  if (!model) return undefined;
  return toModelConfig(model, selection);
}
