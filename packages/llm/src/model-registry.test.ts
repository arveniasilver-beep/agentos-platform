import { describe, it, expect } from 'vitest';
import { MODEL_REGISTRY, getModel, listModels, modelDeprecation, deprecationWarning } from './model-registry';

describe('model registry (multi-model common brain)', () => {
  it('catalogues multiple families, not just one provider', () => {
    const families = new Set(MODEL_REGISTRY.map((m) => m.family));
    expect(families.has('anthropic')).toBe(true);
    expect(families.has('deepseek')).toBe(true);
    expect(families.has('mimo')).toBe(true); // MiMo is first-class, via OpenAI-compatible vLLM
    expect(families.has('qwen')).toBe(true);
    // every entry maps to a concrete provider impl
    for (const m of MODEL_REGISTRY) expect(['anthropic', 'openai']).toContain(m.provider);
  });

  it('MiMo / Qwen are self-hosted (require a baseUrl); DeepSeek is public', () => {
    expect(getModel('mimo-vl')?.requiresBaseUrl).toBe(true);
    expect(getModel('mimo-vl')?.capabilities.vision).toBe(true); // vision peer
    expect(getModel('qwen2.5-72b-instruct')?.requiresBaseUrl).toBe(true);
    expect(getModel('deepseek-v4-flash')?.defaultBaseUrl).toBe('https://api.deepseek.com');
    expect(listModels('deepseek').length).toBeGreaterThanOrEqual(3);
  });

  it('deprecation is model-AGNOSTIC: any catalogued deprecation surfaces a faithful replacement', () => {
    expect(modelDeprecation('deepseek-chat')).toMatchObject({ deprecated: true, on: '2026-07-24', replacement: 'deepseek-v4-flash' });
    expect(modelDeprecation('deepseek-reasoner').deprecated).toBe(true);
    expect(modelDeprecation('deepseek-v4-flash').deprecated).toBe(false); // current id is fine
    expect(modelDeprecation('mimo-vl').deprecated).toBe(false);
    expect(modelDeprecation('some-custom-local-model').deprecated).toBe(false); // unknown != deprecated
    expect(deprecationWarning('deepseek-chat')).toMatch(/deprecated as of 2026-07-24.*deepseek-v4-flash/);
    expect(deprecationWarning('deepseek-v4-flash')).toBeNull();
  });

  it('carries pricing for known public models (the COST-PRICING fallback source) and none for self-hosted', () => {
    // The factory falls back to THIS data when the user gives no pricing, so a DeepSeek run meters real cost.
    expect(getModel('deepseek-v4-flash')?.pricing).toEqual({ inputPerMTok: 0.14, outputPerMTok: 0.28 });
    // Legacy ids carry pricing too — a workspace still on 'deepseek-chat' must NOT meter $0 (real user bug).
    expect(getModel('deepseek-chat')?.pricing).toEqual({ inputPerMTok: 0.14, outputPerMTok: 0.28 });
    expect(getModel('deepseek-reasoner')?.pricing).toEqual({ inputPerMTok: 0.14, outputPerMTok: 0.28 });
    // Self-hosted / unknown have no price (we don't invent one) -> they still meter $0 by design.
    expect(getModel('mimo-vl')?.pricing).toBeUndefined();
    expect(getModel('qwen2.5-72b-instruct')?.pricing).toBeUndefined();
    expect(getModel('some-self-hosted-7b')).toBeUndefined(); // unknown id -> no entry, no pricing
  });
});
