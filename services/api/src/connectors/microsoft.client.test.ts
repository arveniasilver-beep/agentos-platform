import { describe, it, expect } from 'vitest';
import {
  microsoftAuthorizeUrl,
  microsoftExchangeCode,
  MicrosoftApi,
  MICROSOFT_SCOPES,
  type MicrosoftClientOptions,
} from './microsoft.client';
import type { FetchLike } from './google.client';

function mockFetch(routes: Record<string, unknown>): { impl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : null;
    return {
      ok: body != null,
      status: body != null ? 200 : 404,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { impl, calls };
}

describe('microsoft.client', () => {
  it('builds a consent URL with the read-only scopes + offline_access', () => {
    const url = microsoftAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'https://app/cb',
      scope: MICROSOFT_SCOPES,
      state: 'st',
    });
    expect(url).toContain('login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('response_type=code');
    expect(decodeURIComponent(url)).toContain('offline_access');
    expect(decodeURIComponent(url)).toContain('Mail.Read');
    expect(url).toContain('state=st');
  });

  it('exchanges the code for access + refresh tokens', async () => {
    const { impl } = mockFetch({
      '/token': { access_token: 'AT', refresh_token: 'RT', scope: 'Mail.Read', expires_in: 3600 },
    });
    const opts: MicrosoftClientOptions = { fetchImpl: impl };
    const ex = await microsoftExchangeCode({
      clientId: 'c',
      clientSecret: 's',
      code: 'code',
      redirectUri: 'https://app/cb',
      opts,
      nowMs: 1_000,
    });
    expect(ex.accessToken).toBe('AT');
    expect(ex.refreshToken).toBe('RT');
    expect(ex.expiresAt).toBe(1_000 + 3600 * 1000);
  });

  it('getAccount + searchMail + listEvents parse Graph responses', async () => {
    const { impl } = mockFetch({
      '/me/messages': {
        value: [
          {
            id: 'm1',
            subject: 'Invoice',
            from: { emailAddress: { address: 'a@b.com', name: 'A B' } },
            receivedDateTime: '2026-06-21T10:00:00Z',
            bodyPreview: 'your invoice',
          },
        ],
      },
      '/me/calendarView': {
        value: [{ subject: 'Standup', start: { dateTime: '2026-06-22T09:00:00' }, end: { dateTime: '2026-06-22T09:15:00' } }],
      },
      '/me': { id: 'u1', mail: 'me@outlook.com' },
    });
    const api = new MicrosoftApi('AT', { fetchImpl: impl });

    expect(await api.getAccount()).toEqual({ id: 'u1', label: 'me@outlook.com' });

    const mail = await api.searchMail('invoice');
    expect(mail.messages[0]).toEqual({
      id: 'm1',
      from: 'a@b.com',
      subject: 'Invoice',
      date: '2026-06-21T10:00:00Z',
      snippet: 'your invoice',
    });

    // Graph returns local wall-clock without offset; we force UTC (Prefer header) and mark it with 'Z'.
    const cal = await api.listEvents('2026-06-21T00:00:00Z');
    expect(cal.events[0]).toEqual({ summary: 'Standup', start: '2026-06-22T09:00:00Z', end: '2026-06-22T09:15:00Z' });
  });

  it('throws a clear error on a failed Graph call', async () => {
    const { impl } = mockFetch({}); // every route 404
    const api = new MicrosoftApi('AT', { fetchImpl: impl });
    await expect(api.getAccount()).rejects.toThrow(/Microsoft Graph/);
  });
});
