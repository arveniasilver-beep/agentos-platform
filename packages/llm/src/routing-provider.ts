import type { LlmProvider, LlmRequest, LlmResponse } from './types';
import { selectProfile, type ModelRouteConfig, type RouteRequest } from './router';

export interface RouteDecision {
  /** the profile selected for this request (before any fallback) */
  selected: string;
  /** the profile that actually answered */
  answered: string;
  model: string;
  attempted: string[];
  fellBack: boolean;
}

/**
 * An LlmProvider that ROUTES each request to one of several pre-built provider profiles (by effort/
 * capability) and FALLS BACK through an ordered chain if the chosen provider throws. Providers are built
 * up front by the factory (so the OpenAI-compat SSRF guard runs at build time / fails fast); this wrapper
 * is pure dispatch. Implements LlmProvider, so the agent engine consumes it with zero changes.
 */
export class RoutingProvider implements LlmProvider {
  constructor(
    private readonly cfg: ModelRouteConfig,
    private readonly providers: Record<string, LlmProvider>,
    private readonly onDecision?: (d: RouteDecision) => void,
  ) {
    if (Object.keys(providers).length === 0) throw new Error('RoutingProvider: no providers built');
  }

  private must(name: string): LlmProvider {
    const p = this.providers[name];
    if (!p) throw new Error(`RoutingProvider: profile '${name}' was not built`);
    return p;
  }

  private pick(req: RouteRequest): { profile: string; chain: string[] } {
    const r = selectProfile(this.cfg, req);
    // restrict to profiles we actually built (defensive: a referenced-but-unbuilt profile is skipped)
    const chain = r.chain.filter((n) => this.providers[n]);
    const built = Object.keys(this.providers);
    const firstChain = chain[0] ?? built[0] ?? '';
    return { profile: this.providers[r.profile] ? r.profile : firstChain, chain: chain.length ? chain : built };
  }

  get model(): string {
    return this.must(this.pick({}).profile).model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { profile, chain } = this.pick({ effort: req.effort, capability: req.capability });
    const attempted: string[] = [];
    let lastErr: unknown;
    for (const name of chain) {
      attempted.push(name);
      try {
        const resp = await this.must(name).complete(req);
        this.onDecision?.({ selected: profile, answered: name, model: resp.model, attempted, fellBack: name !== profile });
        return resp;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('model router: all providers failed');
  }

  countTokens(req: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): Promise<number> {
    return this.must(this.pick({}).profile).countTokens(req);
  }
}
