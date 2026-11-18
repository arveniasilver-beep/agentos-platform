import { describe, it, expect, beforeAll } from 'vitest';
import { OpenAiCompatProvider } from '@agentos/llm';
import { LlmProviderFactory } from './llm-provider.factory';
import type { SecretsService } from '../secrets/secrets.service';

// COST-PRICING: an OpenAI-compatible brain (DeepSeek et al.) used to meter at $0 unless the user typed
// pricing, because the factory passed no pricing. The fix falls back to the model registry. These tests
// lock the WIRING (the factory resolves pricing as user -> registry -> none). The openai branch never
// touches secrets, so a bare stub is enough; a loopback baseUrl + ALLOW_LOCAL_BRAIN_URL avoids any DNS.

const stubSecrets = {} as unknown as SecretsService;

function build(model: string | undefined, extra: Record<string, unknown> = {}) {
  const factory = new LlmProviderFactory(stubSecrets);
  return factory.buildConsultable('ws', {
    provider: 'openai',
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:8000',
    ...(model ? { model } : {}),
    ...extra,
  } as never);
}

// Read the provider's resolved pricing (private field — test-only access to assert the wiring).
const pricingOf = (p: unknown) => (p as unknown as { pricing: { inputPerMTok: number; outputPerMTok: number } }).pricing;

describe('LlmProviderFactory — OpenAI-compat registry pricing fallback (COST-PRICING)', () => {
  beforeAll(() => {
    process.env.ALLOW_LOCAL_BRAIN_URL = 'true'; // loopback baseUrl allowed -> no SSRF/DNS in the test
  });

  it('a known model with NO user pricing falls back to registry pricing (DeepSeek meters non-zero)', async () => {
    const p = await build('deepseek-v4-flash');
    expect(p).toBeInstanceOf(OpenAiCompatProvider);
    expect(pricingOf(p)).toEqual({ inputPerMTok: 0.14, outputPerMTok: 0.28 });
  });

  it('user-supplied pricing OVERRIDES the registry', async () => {
    const p = await build('deepseek-v4-flash', { inputPerMTok: 1, outputPerMTok: 2 });
    expect(pricingOf(p)).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
  });

  it('an unknown / self-hosted model with no registry row stays $0 (we do not invent a price)', async () => {
    const p = await build('some-self-hosted-7b');
    expect(pricingOf(p)).toEqual({ inputPerMTok: 0, outputPerMTok: 0 }); // provider default when no pricing passed
  });
});
