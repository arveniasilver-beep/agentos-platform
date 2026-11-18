/**
 * Minimal Google OAuth + REST client (Calendar + Drive). Pure + injectable (fetchImpl + base URLs) so
 * it is unit-testable without hitting Google. Hosts are fixed (no SSRF surface). Google access tokens
 * expire (~1h), so the service refreshes via the stored refresh_token before building the API.
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface GoogleClientOptions {
  authBase?: string; // default https://accounts.google.com
  tokenBase?: string; // default https://oauth2.googleapis.com
  apiBase?: string; // default https://www.googleapis.com
  fetchImpl?: FetchLike;
}

const DEFAULT_AUTH = 'https://accounts.google.com';
const DEFAULT_TOKEN = 'https://oauth2.googleapis.com';
const DEFAULT_API = 'https://www.googleapis.com';

/** Read-only Calendar + Drive + Gmail + email so the agent can list events, search files, read mail. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

/** Build the Google consent URL (offline access + consent prompt so a refresh_token is issued). */
export function googleAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  authBase?: string;
}): string {
  const base = params.authBase ?? DEFAULT_AUTH;
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.scope,
    state: params.state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${base}/o/oauth2/v2/auth?${q.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
}

function tokenForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Exchange the auth code for tokens (form-encoded, JSON response). */
export async function googleExchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  opts?: GoogleClientOptions;
  nowMs?: number;
}): Promise<{ accessToken: string; refreshToken: string; scopes: string; expiresAt: number }> {
  const base = params.opts?.tokenBase ?? DEFAULT_TOKEN;
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
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token) throw new Error(`Google token exchange returned no token${j.error ? `: ${j.error}` : ''}`);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? '',
    scopes: j.scope ?? '',
    expiresAt: (params.nowMs ?? Date.now()) + (j.expires_in ?? 3600) * 1000,
  };
}

/** Refresh an expired access token using the stored refresh_token. */
export async function googleRefresh(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  opts?: GoogleClientOptions;
  nowMs?: number;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const base = params.opts?.tokenBase ?? DEFAULT_TOKEN;
  const fetchImpl = params.opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchImpl(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: tokenForm({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token) throw new Error('Google token refresh returned no token');
  return { accessToken: j.access_token, expiresAt: (params.nowMs ?? Date.now()) + (j.expires_in ?? 3600) * 1000 };
}

/** Authenticated Google REST client (Calendar + Drive + account) bound to one access token. */
export class GoogleApi {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  constructor(
    private readonly token: string,
    opts: GoogleClientOptions = {},
  ) {
    this.apiBase = opts.apiBase ?? DEFAULT_API;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Google API ${path} failed (${res.status}): ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  async getAccount(): Promise<{ id: string; label: string }> {
    const u = (await this.get('/oauth2/v2/userinfo')) as { id?: string; email?: string };
    return { id: u.id ?? '', label: u.email ?? 'Google account' };
  }

  /** Upcoming events from the primary calendar (RFC3339 timeMin = now). */
  async listEvents(timeMinIso: string): Promise<{ events: { summary: string; start: string; end: string }[] }> {
    const q = new URLSearchParams({
      maxResults: '10',
      orderBy: 'startTime',
      singleEvents: 'true',
      timeMin: timeMinIso,
    });
    const j = (await this.get(`/calendar/v3/calendars/primary/events?${q.toString()}`)) as {
      items?: { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
    };
    return {
      events: (j.items ?? []).map((e) => ({
        summary: e.summary ?? '(no title)',
        start: e.start?.dateTime ?? e.start?.date ?? '',
        end: e.end?.dateTime ?? e.end?.date ?? '',
      })),
    };
  }

  /** Search Gmail (returns the top matches with From/Subject/Date + snippet). Capped to keep the
   * N+1 metadata fetches bounded. */
  async searchGmail(query: string): Promise<{ messages: { id: string; from: string; subject: string; date: string; snippet: string }[] }> {
    const list = (await this.get(
      `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`,
    )) as { messages?: { id: string }[] };
    const ids = (list.messages ?? []).slice(0, 5).map((m) => m.id);
    // Per-item resilience: one deleted/failed message must not void the whole search (allSettled).
    const settled = await Promise.allSettled(
      ids.map(async (id) => {
        const m = (await this.get(
          `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        )) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
        const h = (name: string): string =>
          m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? '';
        return { id, from: h('from'), subject: h('subject'), date: h('date'), snippet: m.snippet ?? '' };
      }),
    );
    const messages = settled
      .filter((r): r is PromiseFulfilledResult<{ id: string; from: string; subject: string; date: string; snippet: string }> => r.status === 'fulfilled')
      .map((r) => r.value);
    return { messages };
  }

  /** Search Drive files by name/content. */
  async searchDrive(query: string): Promise<{ files: { id: string; name: string; mimeType: string; link: string }[] }> {
    const q = new URLSearchParams({
      q: `fullText contains '${query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
      pageSize: '20',
      fields: 'files(id,name,mimeType,webViewLink)',
    });
    const j = (await this.get(`/drive/v3/files?${q.toString()}`)) as {
      files?: { id: string; name: string; mimeType: string; webViewLink?: string }[];
    };
    return {
      files: (j.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, link: f.webViewLink ?? '' })),
    };
  }
}
