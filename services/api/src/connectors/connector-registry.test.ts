import { describe, it, expect } from 'vitest';
import { validateManifest, actionAllowed, getManifest, BUILTIN_MANIFESTS } from './connector-registry';

describe('connector registry (TICKET-9)', () => {
  it('built-in manifests are well-formed', () => {
    for (const m of Object.values(BUILTIN_MANIFESTS)) expect(validateManifest(m).ok).toBe(true);
    expect(getManifest('github')?.actions.some((a) => a.id === 'github_list_repos')).toBe(true);
    expect(getManifest('unknown')).toBeUndefined();
  });

  it('validateManifest rejects malformed + duplicate action ids', () => {
    expect(validateManifest({ provider: 'X bad', actions: [] }).ok).toBe(false); // bad provider regex
    const dup: unknown = { provider: 'p', actions: [{ id: 'a' }, { id: 'a' }] };
    const r = validateManifest(dup);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /duplicate action/.test(e))).toBe(true);
  });

  it('actionAllowed enforces required scopes (the capability boundary)', () => {
    const m = getManifest('github')!;
    expect(actionAllowed(m, 'github_list_repos', ['repo', 'read:user']).ok).toBe(true);
    const denied = actionAllowed(m, 'github_list_repos', ['read:user']); // missing 'repo'
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/missing required scope/);
    expect(actionAllowed(m, 'github_unknown_action', ['repo']).ok).toBe(false);
  });

  it('a no-scope action (notion) is allowed once connected', () => {
    const m = getManifest('notion')!;
    expect(actionAllowed(m, 'notion_search', []).ok).toBe(true);
  });
});
