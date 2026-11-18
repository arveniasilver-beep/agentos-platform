import { describe, it, expect } from 'vitest';
import { computeCostUsd, OPUS_4_8_PRICING } from './cost';

describe('computeCostUsd (Opus 4.8)', () => {
  it('prices 1M input + 1M output at $30', () => {
    const cost = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      OPUS_4_8_PRICING,
    );
    expect(cost).toBeCloseTo(30, 6);
  });

  it('prices cache reads at ~0.1x input ($0.50/1M)', () => {
    const cost = computeCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      OPUS_4_8_PRICING,
    );
    expect(cost).toBeCloseTo(0.5, 6);
  });

  it('is zero for no usage', () => {
    expect(
      computeCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, OPUS_4_8_PRICING),
    ).toBe(0);
  });
});
