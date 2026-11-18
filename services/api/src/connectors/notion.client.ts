/**
 * Minimal Notion OAuth + REST client. Pure + injectable (fetchImpl) so it is unit-testable without
 * hitting api.notion.com. The host is fixed (no SSRF surface). Mirrors github.client.ts so the
 * connector service can treat providers uniformly.
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

export interface NotionClientOptions {
  apiBase?: string; // default https://api.notion.com
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';

/** Build the Notion authorize URL the user is redirected to (owner=user, code response). */
export function notionAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  apiBase?: string;
}): string {
  const base = params.apiBase ?? DEFAULT_BASE;
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    owner: 'user',
    state: params.state,
  });
  return `${base}/v1/oauth/authorize?${q.toString()}`;
}

/** Exchange the code for an access token. Notion uses HTTP Basic auth (client_id:client_secret). */
export async function notionExchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  opts?: NotionClientOptions;
}): Promise<{ accessToken: string; scopes: string; workspaceName: string; workspaceId: string }> {
  const base = params.opts?.apiBase ?? DEFAULT_BASE;
  const fetchImpl = params.opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');
  const res = await fetchImpl(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Basic ${basic}` },
    body: JSON.stringify({ grant_type: 'authorization_code', code: params.code, redirect_uri: params.redirectUri }),
  });
  if (!res.ok) throw new Error(`Notion token exchange failed (${res.status})`);
  const json = (await res.json()) as {
    access_token?: string;
    workspace_name?: string;
    workspace_id?: string;
    error?: string;
  };
  if (!json.access_token) throw new Error(`Notion token exchange returned no token${json.error ? `: ${json.error}` : ''}`);
  return {
    accessToken: json.access_token,
    scopes: '',
    workspaceName: json.workspace_name ?? 'Notion workspace',
    workspaceId: json.workspace_id ?? '',
  };
}

/** Authenticated Notion REST client bound to one access token. */
export class NotionApi {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  constructor(
    private readonly token: string,
    opts: NotionClientOptions = {},
  ) {
    this.base = opts.apiBase ?? DEFAULT_BASE;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'notion-version': NOTION_VERSION,
      'content-type': 'application/json',
    };
  }

  /** Full-text search across pages/databases the integration can access. */
  async search(query: string): Promise<{ results: { id: string; title: string; url: string; type: string }[] }> {
    const res = await this.fetchImpl(`${this.base}/v1/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query, page_size: 20 }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Notion search failed (${res.status}): ${t.slice(0, 200)}`);
    }
    const j = (await res.json()) as { results?: NotionObject[] };
    return { results: (j.results ?? []).map(toResult) };
  }

  /** Fetch a page's properties (titles, etc.). */
  async getPage(id: string): Promise<{ id: string; title: string; url: string }> {
    const res = await this.fetchImpl(`${this.base}/v1/pages/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Notion getPage failed (${res.status}): ${t.slice(0, 200)}`);
    }
    const o = (await res.json()) as NotionObject;
    const r = toResult(o);
    return { id: r.id, title: r.title, url: r.url };
  }

  /** Identify the connected workspace (account label) for the Connection row. */
  async getAccount(): Promise<{ id: string; label: string }> {
    const res = await this.fetchImpl(`${this.base}/v1/users/me`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Notion getAccount failed (${res.status})`);
    const u = (await res.json()) as { id?: string; name?: string; bot?: { owner?: { user?: { name?: string } } } };
    return { id: u.id ?? '', label: u.name ?? u.bot?.owner?.user?.name ?? 'Notion' };
  }
}

interface NotionObject {
  id: string;
  object?: string;
  url?: string;
  properties?: Record<string, { type?: string; title?: { plain_text?: string }[] }>;
  title?: { plain_text?: string }[];
}

/** Pull a human title out of a Notion page/database object (title prop or top-level title). */
function toResult(o: NotionObject): { id: string; title: string; url: string; type: string } {
  let title = '';
  if (Array.isArray(o.title)) title = o.title.map((t) => t.plain_text ?? '').join('');
  if (!title && o.properties) {
    for (const p of Object.values(o.properties)) {
      if (p.type === 'title' && Array.isArray(p.title)) {
        title = p.title.map((t) => t.plain_text ?? '').join('');
        break;
      }
    }
  }
  return { id: o.id, title: title || '(untitled)', url: o.url ?? '', type: o.object ?? 'page' };
}
