/**
 * Minimal GitHub OAuth + REST client. Pure (no Nest/DI) and fully injectable (fetchImpl + base URLs)
 * so it is unit-testable without hitting github.com. Hosts api.github.com / github.com are fixed
 * (not user-configurable), so there is no SSRF surface here.
 */
import { BRAND } from '@agentos/brand';

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

export interface GithubClientOptions {
  oauthBase?: string; // default https://github.com
  apiBase?: string; // default https://api.github.com
  fetchImpl?: FetchLike;
}

const DEFAULT_OAUTH_BASE = 'https://github.com';
const DEFAULT_API_BASE = 'https://api.github.com';

/** Build the GitHub authorize URL the user is redirected to. */
export function githubAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  oauthBase?: string;
}): string {
  const base = params.oauthBase ?? DEFAULT_OAUTH_BASE;
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    allow_signup: 'false',
  });
  return `${base}/login/oauth/authorize?${q.toString()}`;
}

/** Exchange the OAuth code for an access token. Returns the token + granted scopes. */
export async function githubExchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  opts?: GithubClientOptions;
}): Promise<{ accessToken: string; scopes: string }> {
  const base = params.opts?.oauthBase ?? DEFAULT_OAUTH_BASE;
  const fetchImpl = params.opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetchImpl(`${base}/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  if (!json.access_token) throw new Error(`GitHub token exchange returned no token${json.error ? `: ${json.error}` : ''}`);
  return { accessToken: json.access_token, scopes: json.scope ?? '' };
}

/** Authenticated GitHub REST client bound to one access token. */
export class GithubApi {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  constructor(
    private readonly token: string,
    opts: GithubClientOptions = {},
  ) {
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': BRAND.appName,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`GitHub API ${path} failed (${res.status}): ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  async getUser(): Promise<{ id: number; login: string }> {
    const u = (await this.get('/user')) as { id: number; login: string };
    return { id: u.id, login: u.login };
  }

  async listRepos(): Promise<{ repos: { fullName: string; private: boolean; description: string | null }[] }> {
    const arr = (await this.get('/user/repos?per_page=50&sort=updated')) as {
      full_name: string;
      private: boolean;
      description: string | null;
    }[];
    return {
      repos: arr.map((r) => ({ fullName: r.full_name, private: r.private, description: r.description })),
    };
  }

  async getFile(owner: string, repo: string, path: string): Promise<{ path: string; content: string }> {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    const raw = await this.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${enc}`);
    // A directory path returns a JSON array — signal that explicitly instead of an empty string.
    if (Array.isArray(raw)) throw new Error(`'${path}' is a directory, not a file`);
    const f = raw as { content?: string; encoding?: string; path?: string };
    if (f.encoding !== 'base64' || !f.content) {
      // encoding 'none' (file > 1MB) or a submodule/symlink entry — no inline content available.
      throw new Error(`'${path}' is too large or unsupported for inline reading`);
    }
    const content = Buffer.from(f.content, 'base64').toString('utf8');
    return { path: f.path ?? path, content: content.slice(0, 100_000) };
  }

  async searchCode(query: string): Promise<{ results: { repo: string; path: string }[] }> {
    const j = (await this.get(`/search/code?q=${encodeURIComponent(query)}&per_page=20`)) as {
      items?: { repository?: { full_name: string }; path: string }[];
    };
    return {
      results: (j.items ?? []).map((i) => ({ repo: i.repository?.full_name ?? '', path: i.path })),
    };
  }
}
