import type { LlmUsage } from './types';

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

/** Claude Opus 4.8 pricing (USD per 1M tokens). Cache read ~0.1x input, 5-min cache write ~1.25x input. */
export const OPUS_4_8_PRICING: ModelPricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 6.25,
};

export function computeCostUsd(usage: LlmUsage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok +
      usage.cacheWriteTokens * pricing.cacheWritePerMTok) /
    1_000_000
  );
}
