import { createHash } from 'node:crypto';

/**
 * Minimal Netlify deploy client (static sites), using the file-digest deploy flow so we never need a
 * zip dependency: announce each file's SHA1, then upload only the files Netlify says it's missing.
 * Pure + injectable (fetchImpl + baseUrl) so it unit-tests with no network. The host is fixed
 * (api.netlify.com) → no SSRF surface.
 */
export interface DeployFile {
  /** Site-root-relative path, e.g. "index.html" or "assets/app.css". */
  path: string;
  content: Buffer;
}

export interface DeployResult {
  siteId: string;
  url: string;
}

type FetchLike = typeof fetch;

const NETLIFY_API = 'https://api.netlify.com/api/v1';

export class NetlifyClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl: string = NETLIFY_API,
  ) {}

  private async json<T>(token: string, path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Netlify ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** Normalize to a leading-slash, forward-slash digest key (what Netlify expects). */
  private key(p: string): string {
    return '/' + p.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  /**
   * Deploy a set of files to Netlify. Reuses `siteId` when given (stable URL across re-publishes),
   * otherwise creates a new site. Returns the site id (persist it) and the live https URL.
   */
  async deploy(token: string, siteId: string | null, files: DeployFile[]): Promise<DeployResult> {
    if (files.length === 0) throw new Error('nothing to deploy (no files)');

    // Create the site on first publish.
    let id = siteId;
    let url = '';
    if (!id) {
      const site = await this.json<{ id: string; ssl_url?: string; url?: string }>(token, '/sites', {
        method: 'POST',
        body: '{}',
      });
      id = site.id;
      url = site.ssl_url ?? site.url ?? '';
    }

    // Announce the digest: { "/index.html": "<sha1>", ... }.
    const shaByKey = new Map<string, string>();
    const fileByKey = new Map<string, Buffer>();
    const digest: Record<string, string> = {};
    for (const f of files) {
      const k = this.key(f.path);
      const sha1 = createHash('sha1').update(f.content).digest('hex');
      digest[k] = sha1;
      shaByKey.set(k, sha1);
      fileByKey.set(k, f.content);
    }

    const deploy = await this.json<{ id: string; required?: string[]; ssl_url?: string }>(
      token,
      `/sites/${id}/deploys`,
      { method: 'POST', body: JSON.stringify({ files: digest }) },
    );

    // Upload only the files Netlify is missing (matched by SHA1).
    const required = new Set(deploy.required ?? []);
    for (const [k, sha1] of shaByKey) {
      if (!required.has(sha1)) continue;
      const content = fileByKey.get(k)!;
      const res = await this.fetchImpl(`${this.baseUrl}/deploys/${deploy.id}/files${k}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: content as unknown as RequestInit['body'],
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Netlify file upload ${k} failed (${res.status}): ${body.slice(0, 200)}`);
      }
    }

    // Resolve the production URL (creation may not have returned it when reusing a site).
    if (!url) {
      const site = await this.json<{ ssl_url?: string; url?: string }>(token, `/sites/${id}`);
      url = site.ssl_url ?? site.url ?? '';
    }
    // Never report a "successful" publish with a blank, unusable URL — surface it as an error so the
    // agent/user sees a real failure instead of a green publish with no link.
    if (!url) throw new Error('Netlify did not return a site URL (the deploy may not be ready yet)');
    // NOTE: Netlify processes the deploy asynchronously (uploading→processing→ready); the URL can take
    // a few seconds to reflect the new content. We return as soon as files are uploaded (no poll).
    return { siteId: id, url };
  }
}
