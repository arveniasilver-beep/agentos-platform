import { describe, it, expect } from 'vitest';
import { notionAuthorizeUrl, notionExchangeCode, NotionApi, type FetchLike } from './notion.client';

describe('Notion client', () => {
  it('builds the authorize URL with owner=user + code response', () => {
    const url = notionAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://app/cb', state: 'st', apiBase: 'https://n' });
    expect(url).toContain('https://n/v1/oauth/authorize?');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('response_type=code');
    expect(url).toContain('owner=user');
    expect(url).toContain('state=st');
  });

  it('exchanges the code with HTTP Basic auth and returns token + workspace', async () => {
    let seen: { url: string; auth?: string; body: unknown } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, auth: init?.headers?.authorization, body: JSON.parse(init?.body ?? '{}') };
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok', workspace_name: 'My WS', workspace_id: 'ws1' }),
        text: async () => '',
      };
    };
    const r = await notionExchangeCode({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'code',
      redirectUri: 'https://app/cb',
      opts: { apiBase: 'https://n', fetchImpl },
    });
    expect(seen!.url).toBe('https://n/v1/oauth/token');
    expect(seen!.auth).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
    expect(seen!.body).toEqual({ grant_type: 'authorization_code', code: 'code', redirect_uri: 'https://app/cb' });
    expect(r).toEqual({ accessToken: 'tok', scopes: '', workspaceName: 'My WS', workspaceId: 'ws1' });
  });

  it('search returns titled results (title prop extraction)', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: 'p1', object: 'page', url: 'https://notion/p1', properties: { Name: { type: 'title', title: [{ plain_text: 'Roadmap' }] } } },
          { id: 'd1', object: 'database', url: 'https://notion/d1', title: [{ plain_text: 'Tasks DB' }] },
        ],
      }),
      text: async () => '',
    });
    const api = new NotionApi('tok', { apiBase: 'https://n', fetchImpl });
    const r = await api.search('road');
    expect(r.results).toEqual([
      { id: 'p1', title: 'Roadmap', url: 'https://notion/p1', type: 'page' },
      { id: 'd1', title: 'Tasks DB', url: 'https://notion/d1', type: 'database' },
    ]);
  });

  it('getPage throws a clear error on a non-ok status', async () => {
    const api = new NotionApi('tok', { apiBase: 'https://n', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'nf' }) });
    await expect(api.getPage('x')).rejects.toThrow(/getPage failed \(404\)/);
  });
});
