import { type FetchLike } from './google.client';

/**
 * Minimal Microsoft (Outlook / Microsoft 365) OAuth + Graph client (Mail + Calendar). Mirrors
 * google.client.ts: pure + injectable (fetchImpl + base URLs), fixed hosts (no SSRF surface).
 * Microsoft access tokens expire (~1h), so the service refreshes via the stored refresh_token
 * (offline_access scope) before building the API. Read-only scopes only.
 */
export interface MicrosoftClientOptions {
  authBase?: string; // default https://login.microsoftonline.com/common/oauth2/v2.0
  apiBase?: string; // default https://graph.microsoft.com/v1.0
  fetchImpl?: FetchLike;
}

const DEFAULT_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const DEFAULT_API = 'https://graph.microsoft.com/v1.0';

/** Read-only Outlook mail + calendar + profile. offline_access yields a refresh_token. */
export const MICROSOFT_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
].join(' ');

/** Build the Microsoft consent URL. */
export function microsoftAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  authBase?: string;
}): string {
  const base = params.authBase ?? DEFAULT_AUTH;
  const q = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    response_mode: 'query',
  });
  return `${base}/authorize?${q.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function tokenForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Exchange the auth code for tokens. */
export async function microsoftExchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  scope?: string;
  opts?: MicrosoftClientOptions;
  nowMs?: number;
}): Promise<{ accessToken: string; refreshToken: string; scopes: string; expiresAt: number }> {
  const base = params.opts?.authBase ?? DEFAULT_AUTH;
  const fetchImpl = params.opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchImpl(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: tokenForm({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      ...(params.scope ? { scope: params.scope } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token exchange failed (${res.status})`);
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token) throw new Error(`Microsoft token exchange returned no token${j.error ? `: ${j.error}` : ''}`);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? '',
    scopes: j.scope ?? '',
    expiresAt: (params.nowMs ?? Date.now()) + (j.expires_in ?? 3600) * 1000,
  };
}

/** Refresh an expired access token using the stored refresh_token. */
export async function microsoftRefresh(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scope?: string;
  opts?: MicrosoftClientOptions;
  nowMs?: number;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const base = params.opts?.authBase ?? DEFAULT_AUTH;
  const fetchImpl = params.opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchImpl(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: tokenForm({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      ...(params.scope ? { scope: params.scope } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token refresh failed (${res.status})`);
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token) throw new Error('Microsoft token refresh returned no token');
  return { accessToken: j.access_token, expiresAt: (params.nowMs ?? Date.now()) + (j.expires_in ?? 3600) * 1000 };
}

/** Authenticated Microsoft Graph client (Mail + Calendar + account) bound to one access token. */
export class MicrosoftApi {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  constructor(
    private readonly token: string,
    opts: MicrosoftClientOptions = {},
  ) {
    this.apiBase = opts.apiBase ?? DEFAULT_API;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async get(path: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...extraHeaders },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Microsoft Graph ${path} failed (${res.status}): ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  async getAccount(): Promise<{ id: string; label: string }> {
    const u = (await this.get('/me')) as { id?: string; mail?: string; userPrincipalName?: string };
    return { id: u.id ?? '', label: u.mail ?? u.userPrincipalName ?? 'Outlook account' };
  }

  /** Upcoming calendar events from `timeMin` over the next 30 days. */
  async listEvents(timeMinIso: string): Promise<{ events: { summary: string; start: string; end: string }[] }> {
    const start = new Date(timeMinIso);
    const startIso = Number.isNaN(start.getTime()) ? new Date().toISOString() : start.toISOString();
    const endIso = new Date(new Date(startIso).getTime() + 30 * 86400 * 1000).toISOString();
    const q = new URLSearchParams({
      startDateTime: startIso,
      endDateTime: endIso,
      $select: 'subject,start,end',
      $orderby: 'start/dateTime',
      $top: '10',
    });
    // Graph returns event times as a LOCAL wall-clock string with a separate timeZone field. Force UTC
    // via the Prefer header so the times are unambiguous, and mark them with 'Z' on output.
    const j = (await this.get(`/me/calendarView?${q.toString()}`, {
      Prefer: 'outlook.timezone="UTC"',
    })) as {
      value?: { subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }[];
    };
    const asUtc = (dt?: string): string =>
      dt && !/[zZ]$|[+-]\d\d:\d\d$/.test(dt) ? `${dt}Z` : (dt ?? '');
    return {
      events: (j.value ?? []).map((e) => ({
        summary: e.subject ?? '(no title)',
        start: asUtc(e.start?.dateTime),
        end: asUtc(e.end?.dateTime),
      })),
    };
  }

  /** Search Outlook mail (top matches with From/Subject/Date + preview). */
  async searchMail(query: string): Promise<{ messages: { id: string; from: string; subject: string; date: string; snippet: string }[] }> {
    // $search must be a quoted KQL string; it can't combine with $orderby (relevance-ordered). The text
    // is the user's own-mailbox query, so KQL operators in it (from:/AND/…) just refine their own
    // search — no cross-tenant risk. We strip quotes to keep the literal well-formed.
    const q = new URLSearchParams({
      $search: `"${query.replace(/"/g, '')}"`,
      $top: '5',
      $select: 'subject,from,receivedDateTime,bodyPreview',
    });
    // A malformed KQL string makes Graph 400. Degrade to an empty result rather than hard-failing the
    // tool on a stray special character.
    const j = (await this.get(`/me/messages?${q.toString()}`, { ConsistencyLevel: 'eventual' }).catch(() => ({}))) as {
      value?: {
        id?: string;
        subject?: string;
        from?: { emailAddress?: { address?: string; name?: string } };
        receivedDateTime?: string;
        bodyPreview?: string;
      }[];
    };
    return {
      messages: (j.value ?? []).map((m) => ({
        id: m.id ?? '',
        // Empty address (Graph returns '' for some system messages) → fall back to the display name.
        from: (m.from?.emailAddress?.address || m.from?.emailAddress?.name) ?? '',
        subject: m.subject ?? '',
        date: m.receivedDateTime ?? '',
        snippet: m.bodyPreview ?? '',
      })),
    };
  }
}
