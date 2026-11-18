import { describe, it, expect } from 'vitest';
import { RoutingProvider, type RouteDecision } from './routing-provider';
import { validateRouteConfig, type ModelRouteConfig } from './router';
import type { LlmProvider, LlmResponse } from './types';

function stub(model: string, opts: { fail?: boolean } = {}): LlmProvider {
  return {
    model,
    async complete(): Promise<LlmResponse> {
      if (opts.fail) throw new Error(`${model} is down`);
      return { text: `ok:${model}`, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, model };
    },
    async countTokens() {
      return 1;
    },
  };
}

const cfg = validateRouteConfig({
  profiles: { fast: { provider: 'anthropic' }, smart: { provider: 'anthropic' } },
  routes: [{ effortAtLeast: 'high', profile: 'smart' }],
  fallback: ['fast'],
  default: 'fast',
}).config as ModelRouteConfig;

describe('RoutingProvider (TICKET-10)', () => {
  it('routes each request by effort to the selected profile', async () => {
    const rp = new RoutingProvider(cfg, { fast: stub('m-fast'), smart: stub('m-smart') });
    expect((await rp.complete({ messages: [], effort: 'high' })).model).toBe('m-smart');
    expect((await rp.complete({ messages: [], effort: 'low' })).model).toBe('m-fast');
    expect(rp.model).toBe('m-fast'); // default selection
  });

  it('falls back through the chain when the chosen provider throws', async () => {
    const decisions: RouteDecision[] = [];
    const rp = new RoutingProvider(cfg, { fast: stub('m-fast'), smart: stub('m-smart', { fail: true }) }, (d) => decisions.push(d));
    const resp = await rp.complete({ messages: [], effort: 'high' }); // smart fails -> fast answers
    expect(resp.model).toBe('m-fast');
    expect(decisions[0]?.selected).toBe('smart');
    expect(decisions[0]?.answered).toBe('fast');
    expect(decisions[0]?.fellBack).toBe(true);
    expect(decisions[0]?.attempted).toEqual(['smart', 'fast']);
  });

  it('throws when every provider in the chain fails', async () => {
    const rp = new RoutingProvider(cfg, { fast: stub('m-fast', { fail: true }), smart: stub('m-smart', { fail: true }) });
    await expect(rp.complete({ messages: [], effort: 'high' })).rejects.toThrow(/down/);
  });
});
