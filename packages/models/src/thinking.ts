/**
 * Reasoning/thinking passthrough for OpenAI-compatible models.
 *
 * Guppy's client is a thin OpenAI `/chat/completions` shim with no notion of
 * per-provider thinking toggles. This module derives the exact request-body
 * fields pi-ai would emit for a model + thinking level (mirroring its
 * `openai-completions` buildParams), so a catalog selection can opt into
 * reasoning without teaching `@guppy/core` about providers. The result is
 * handed to the client via `ModelConfig.extraBody`.
 */

import { clampThinkingLevel } from '@earendil-works/pi-ai';
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';

export type ThinkingFormat =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'qwen'
  | 'together'
  | 'zai'
  | 'ant-ling'
  | 'string-thinking';

/**
 * Resolve the request-body shape for a model's reasoning toggle. Mirrors
 * pi-ai's `getCompat`: an explicit `model.compat.thinkingFormat` wins, then
 * provider/baseUrl auto-detection. Formats pi-ai supports but this shim does
 * not (chat-template variants, baseten) fall through to the `openai` shape.
 */
export function detectThinkingFormat(model: Model<Api>): ThinkingFormat {
  const explicit = (model as { compat?: { thinkingFormat?: string } }).compat?.thinkingFormat;
  if (explicit) return explicit as ThinkingFormat;
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  if (provider === 'openrouter' || baseUrl.includes('openrouter.ai')) return 'openrouter';
  if (provider === 'deepseek' || baseUrl.includes('deepseek.com')) return 'deepseek';
  if (
    provider === 'zai' ||
    provider === 'zai-coding-cn' ||
    baseUrl.includes('api.z.ai') ||
    baseUrl.includes('open.bigmodel.cn')
  ) {
    return 'zai';
  }
  if (
    provider === 'together' ||
    baseUrl.includes('api.together.ai') ||
    baseUrl.includes('api.together.xyz')
  ) {
    return 'together';
  }
  if (provider === 'ant-ling' || baseUrl.includes('api.ant-ling.com')) return 'ant-ling';
  return 'openai';
}

/**
 * Build the extra request-body fields that enable reasoning at `level` for a
 * model. Returns `{}` when the model can't reason or `level` is 'off'. The
 * level is clamped to what the model supports first (pi-ai semantics), and
 * `thinkingLevelMap` overrides the sent value when the model declares one.
 */
export function buildThinkingBody(
  model: Model<Api>,
  level: ModelThinkingLevel,
): Record<string, unknown> {
  if (!model.reasoning) return {};
  const clamped = clampThinkingLevel(model, level);
  if (clamped === 'off') return {};
  const mapped = model.thinkingLevelMap?.[clamped];
  const effort = typeof mapped === 'string' ? mapped : clamped;

  switch (detectThinkingFormat(model)) {
    case 'openrouter':
      return { reasoning: { effort } };
    case 'deepseek':
      return { thinking: { type: 'enabled' }, reasoning_effort: effort };
    case 'qwen':
      return { enable_thinking: true, reasoning_effort: effort };
    case 'together':
      return { reasoning: { enabled: true }, reasoning_effort: effort };
    case 'zai':
      return { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: effort };
    case 'string-thinking':
      return { thinking: effort };
    case 'ant-ling':
      return { reasoning: { effort } };
    default:
      return { reasoning_effort: effort };
  }
}
