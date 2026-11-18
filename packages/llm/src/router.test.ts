import { describe, it, expect } from 'vitest';
import { validateRouteConfig, selectProfile, type ModelRouteConfig } from './router';

const base = (over: Record<string, unknown> = {}) => ({
  profiles: { fast: { provider: 'anthropic', model: 'm-fast' }, smart: { provider: 'anthropic', model: 'm-smart' } },
  routes: [{ effortAtLeast: 'high', profile: 'smart' }],
  fallback: ['fast'],
  default: 'fast',
  ...over,
});

describe('model router (TICKET-10)', () => {
  it('validateRouteConfig accepts a well-formed config + rejects bad shapes/refs', () => {
    expect(validateRouteConfig(base()).ok).toBe(true);
    expect(validateRouteConfig({ profiles: {}, routes: [], fallback: [] }).ok).toBe(false); // no profiles
    expect(validateRouteConfig({ profiles: { a: { provider: 'anthropic' } }, routes: [{ profile: 'ghost' }], fallback: [] }).ok).toBe(false); // unknown route ref
    expect(validateRouteConfig({ profiles: { a: { provider: 'anthropic' } }, routes: [], fallback: ['ghost'] }).ok).toBe(false); // unknown fallback ref
    expect(validateRouteConfig({ profiles: { a: { provider: 'deepseek' } }, routes: [], fallback: [] }).ok).toBe(false); // bad provider
  });

  it('selectProfile routes by effort and builds the fallback chain (chosen first)', () => {
    const c = validateRouteConfig(base()).config as ModelRouteConfig;
    expect(selectProfile(c, { effort: 'high' }).profile).toBe('smart'); // meets effortAtLeast
    expect(selectProfile(c, { effort: 'max' }).profile).toBe('smart');
    expect(selectProfile(c, { effort: 'low' }).profile).toBe('fast'); // below threshold -> default
    expect(selectProfile(c, {}).profile).toBe('fast'); // no effort -> default
    const chain = selectProfile(c, { effort: 'high' }).chain;
    expect(chain[0]).toBe('smart');
    expect(chain).toContain('fast'); // fallback appended, deduped
  });

  it('selectProfile routes by capability', () => {
    const c = validateRouteConfig(base({ routes: [{ capability: 'vision', profile: 'smart' }] })).config as ModelRouteConfig;
    expect(selectProfile(c, { capability: 'vision' }).profile).toBe('smart');
    expect(selectProfile(c, { capability: 'text' }).profile).toBe('fast'); // no match -> default
  });
});
