import { describe, it, expect } from 'vitest';
import {
  githubAuthorizeUrl,
  githubExchangeCode,
  GithubApi,
  type FetchLike,
  type FetchResponseLike,
} from './github.client';

function ok(json: unknown): FetchResponseLike {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}
function fail(status: number): FetchResponseLike {
  return { ok: false, status, json: async () => ({}), text: async () => 'err' };
}

describe('github.client', () => {
  it('builds an authorize URL with the expected params', () => {
    const url = githubAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'http://localhost:4000/connectors/github/callback',
      scope: 'repo read:user',
      state: 'st',
      oauthBase: 'https://gh.test',
    });
    expect(url).toContain('https://gh.test/login/oauth/authorize?');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('scope=repo+read%3Auser');
    expect(url).toContain('state=st');
  });

  it('exchanges a code for an access token', async () => {
    const fetchImpl: FetchLike = async (url) => {
      expect(url).toBe('https://gh.test/login/oauth/access_token');
      return ok({ access_token: 'gho_x', scope: 'repo,read:user' });
    };
    const r = await githubExchangeCode({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'c',
      redirectUri: 'http://localhost:4000/connectors/github/callback',
      opts: { oauthBase: 'https://gh.test', fetchImpl },
    });
    expect(r).toEqual({ accessToken: 'gho_x', scopes: 'repo,read:user' });
  });

  it('throws when the exchange returns no token', async () => {
    const fetchImpl: FetchLike = async () => ok({ error: 'bad_verification_code' });
    await expect(
      githubExchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'u', opts: { fetchImpl } }),
    ).rejects.toThrow(/no token/);
  });

  it('GithubApi reads user, repos, file (base64-decoded), and search', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/user')) return ok({ id: 7, login: 'octocat' });
      if (url.includes('/user/repos')) return ok([{ full_name: 'octocat/h', private: true, description: null }]);
      if (url.includes('/contents/')) return ok({ path: 'a.txt', content: Buffer.from('hello').toString('base64'), encoding: 'base64' });
      if (url.includes('/search/code')) return ok({ items: [{ repository: { full_name: 'octocat/h' }, path: 'x.ts' }] });
      return fail(404);
    };
    const gh = new GithubApi('tok', { apiBase: 'https://api.gh.test', fetchImpl });
    expect(await gh.getUser()).toEqual({ id: 7, login: 'octocat' });
    expect((await gh.listRepos()).repos[0]).toEqual({ fullName: 'octocat/h', private: true, description: null });
    expect((await gh.getFile('octocat', 'h', 'a.txt')).content).toBe('hello');
    expect((await gh.searchCode('q')).results).toEqual([{ repo: 'octocat/h', path: 'x.ts' }]);
  });

  it('GithubApi surfaces API errors', async () => {
    const gh = new GithubApi('tok', { apiBase: 'https://api.gh.test', fetchImpl: async () => fail(401) });
    await expect(gh.getUser()).rejects.toThrow(/failed \(401\)/);
  });

  it('getFile signals directories and too-large/unsupported files instead of returning empty', async () => {
    const dir = new GithubApi('t', { apiBase: 'https://api.gh.test', fetchImpl: async () => ok([{ name: 'a' }]) });
    await expect(dir.getFile('o', 'r', 'src')).rejects.toThrow(/is a directory/);
    const big = new GithubApi('t', {
      apiBase: 'https://api.gh.test',
      fetchImpl: async () => ok({ path: 'big.bin', encoding: 'none', content: '' }),
    });
    await expect(big.getFile('o', 'r', 'big.bin')).rejects.toThrow(/too large or unsupported/);
  });
});
