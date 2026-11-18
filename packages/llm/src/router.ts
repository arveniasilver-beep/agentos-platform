import type { LlmEffort, ChatProviderConfig } from './types';

// Model Router (TICKET-10) — deterministic, capability/effort-based selection across a workspace's named
// provider PROFILES (e.g. cheap / reasoning / vision), with an explicit FALLBACK chain. Pure module — no
// network, no DB, no zod (leaf lib) — so the routing decision is fully unit-testable. The chosen profile's
// ChatProviderConfig is built by the existing LlmProviderFactory (same SSRF guard + key handling).

export interface ModelRouteRule {
  capability?: string;
  effortAtLeast?: LlmEffort;
  profile: string;
}
export interface ModelRouteConfig {
  profiles: Record<string, ChatProviderConfig>;
  routes: ModelRouteRule[];
  fallback: string[];
  default?: string;
}
export interface RouteRequest {
  effort?: LlmEffort;
  capability?: string;
}

const EFFORT_RANK: Record<LlmEffort, number> = { low: 0, medium: 1, high: 2, max: 3 };
const EFFORTS: LlmEffort[] = ['low', 'medium', 'high', 'max'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate a raw route config (plain TS, no zod): shape + every referenced profile must exist. */
export function validateRouteConfig(raw: unknown): { ok: boolean; errors: string[]; config?: ModelRouteConfig } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['config must be an object'] };
  if (!isRecord(raw.profiles)) return { ok: false, errors: ['profiles must be an object'] };

  const profileEntries = Object.entries(raw.profiles);
  if (profileEntries.length === 0) errors.push('at least one profile is required');
  for (const [name, p] of profileEntries) {
    if (!isRecord(p)) { errors.push(`profile ${name}: must be an object`); continue; }
    if (p.provider !== 'anthropic' && p.provider !== 'openai') errors.push(`profile ${name}: provider must be 'anthropic' or 'openai'`);
  }
  const names = new Set(profileEntries.map(([n]) => n));

  const routesRaw = raw.routes ?? [];
  if (!Array.isArray(routesRaw)) return { ok: false, errors: [...errors, 'routes must be an array'] };
  const routes: ModelRouteRule[] = [];
  routesRaw.forEach((rr, idx) => {
    if (!isRecord(rr)) { errors.push(`route ${idx}: must be an object`); return; }
    if (typeof rr.profile !== 'string' || rr.profile.length === 0) { errors.push(`route ${idx}: profile is required`); return; }
    if (rr.effortAtLeast !== undefined && !EFFORTS.includes(rr.effortAtLeast as LlmEffort)) errors.push(`route ${idx}: invalid effortAtLeast`);
    if (rr.capability !== undefined && typeof rr.capability !== 'string') errors.push(`route ${idx}: capability must be a string`);
    if (!names.has(rr.profile)) errors.push(`route ${idx}: references unknown profile '${rr.profile}'`);
    routes.push({
      profile: rr.profile,
      ...(typeof rr.capability === 'string' ? { capability: rr.capability } : {}),
      ...(typeof rr.effortAtLeast === 'string' ? { effortAtLeast: rr.effortAtLeast as LlmEffort } : {}),
    });
  });

  const fallbackRaw = raw.fallback ?? [];
  if (!Array.isArray(fallbackRaw) || !fallbackRaw.every((x) => typeof x === 'string')) return { ok: false, errors: [...errors, 'fallback must be an array of strings'] };
  const fallback = fallbackRaw as string[];
  for (const f of fallback) if (!names.has(f)) errors.push(`fallback references unknown profile '${f}'`);

  const def = raw.default;
  if (def !== undefined && typeof def !== 'string') errors.push('default must be a string');
  if (typeof def === 'string' && !names.has(def)) errors.push(`default references unknown profile '${def}'`);

  if (errors.length > 0) return { ok: false, errors };
  const config: ModelRouteConfig = {
    profiles: raw.profiles as Record<string, ChatProviderConfig>,
    routes,
    fallback,
    ...(typeof def === 'string' ? { default: def } : {}),
  };
  return { ok: true, errors: [], config };
}

/**
 * Select the profile for a request + the ordered fallback chain to try on failure. Deterministic: the
 * first matching route rule wins (matches when its capability — if set — equals req.capability AND
 * req.effort meets effortAtLeast — if set). No match falls to `default`, else the first declared profile.
 * The chain is [chosen, ...fallback, default] deduped, restricted to existing profiles.
 */
export function selectProfile(cfg: ModelRouteConfig, req: RouteRequest): { profile: string; chain: string[] } {
  const names = Object.keys(cfg.profiles);
  const first = names[0];
  if (first === undefined) throw new Error('selectProfile: route config has no profiles');
  const reqRank = req.effort ? EFFORT_RANK[req.effort] : EFFORT_RANK.medium;
  let chosen: string | undefined;
  for (const r of cfg.routes) {
    if (r.capability && r.capability !== req.capability) continue;
    if (r.effortAtLeast !== undefined && reqRank < EFFORT_RANK[r.effortAtLeast]) continue;
    if (cfg.profiles[r.profile]) { chosen = r.profile; break; }
  }
  const profile: string = chosen ?? (cfg.default && cfg.profiles[cfg.default] ? cfg.default : first);
  const ordered: string[] = [];
  for (const n of [profile, ...cfg.fallback, ...(cfg.default ? [cfg.default] : [])]) {
    if (cfg.profiles[n] && !ordered.includes(n)) ordered.push(n);
  }
  return { profile, chain: ordered };
}
