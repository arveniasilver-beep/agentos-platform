import { describe, it, expect } from 'vitest';
import {
  googleAuthorizeUrl,
  googleExchangeCode,
  googleRefresh,
  GoogleApi,
  type FetchLike,
} from './google.client';

describe('Google client', () => {
  it('builds the consent URL with offline access + consent prompt', () => {
    const url = googleAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://a/cb', scope: 'sc', state: 'st', authBase: 'https://acc' });
    expect(url).toContain('https://acc/o/oauth2/v2/auth?');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('state=st');
  });

  it('exchanges the code (form-encoded) and returns tokens + expiry', async () => {
    let body = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      body = init?.body ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', refresh_token: 'rt', scope: 's', expires_in: 3600 }),
        text: async () => '',
      };
    };
    const r = await googleExchangeCode({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'code',
      redirectUri: 'https://a/cb',
      opts: { tokenBase: 'https://tok', fetchImpl },
      nowMs: 1_000,
    });
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=code');
    expect(r.accessToken).toBe('at');
    expect(r.refreshToken).toBe('rt');
    expect(r.expiresAt).toBe(1_000 + 3600 * 1000);
  });

  it('refreshes an access token with grant_type=refresh_token', async () => {
    let body = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      body = init?.body ?? '';
      return { ok: true, status: 200, json: async () => ({ access_token: 'new', expires_in: 3600 }), text: async () => '' };
    };
    const r = await googleRefresh({ clientId: 'c', clientSecret: 's', refreshToken: 'rt', opts: { tokenBase: 'https://tok', fetchImpl }, nowMs: 0 });
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rt');
    expect(r.accessToken).toBe('new');
  });

  it('lists calendar events and searches drive', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/calendar/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ summary: 'Standup', start: { dateTime: '2026-06-20T09:00:00Z' }, end: { dateTime: '2026-06-20T09:15:00Z' } }] }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: [{ id: 'f1', name: 'Plan.docx', mimeType: 'application/doc', webViewLink: 'https://d/f1' }] }),
        text: async () => '',
      };
    };
    const api = new GoogleApi('at', { apiBase: 'https://api', fetchImpl });
    expect(await api.listEvents('2026-06-20T00:00:00Z')).toEqual({
      events: [{ summary: 'Standup', start: '2026-06-20T09:00:00Z', end: '2026-06-20T09:15:00Z' }],
    });
    expect(await api.searchDrive('plan')).toEqual({
      files: [{ id: 'f1', name: 'Plan.docx', mimeType: 'application/doc', link: 'https://d/f1' }],
    });
  });

  it('searches Gmail (list + per-message metadata)', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/messages?q=')) {
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1' }] }), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          snippet: 'Your invoice is ready',
          payload: { headers: [{ name: 'From', value: 'billing@x' }, { name: 'Subject', value: 'Invoice #9' }, { name: 'Date', value: 'Fri' }] },
        }),
        text: async () => '',
      };
    };
    const api = new GoogleApi('at', { apiBase: 'https://api', fetchImpl });
    expect(await api.searchGmail('invoice')).toEqual({
      messages: [{ id: 'm1', from: 'billing@x', subject: 'Invoice #9', date: 'Fri', snippet: 'Your invoice is ready' }],
    });
  });
});
