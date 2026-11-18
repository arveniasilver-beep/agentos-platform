import { type DeployFile } from './netlify.client';

type FetchLike = typeof fetch;

/**
 * Client for AgentOS's OWN self-hosted hosting server (services/hosting-server, running on the user's
 * VPS). POSTs the site (base64 files) to its token-protected /api/deploy and returns the public URL.
 * The host is the user-configured endpoint; the bearer token is the server's deploy token.
 */
export class SelfHostedClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async deploy(endpoint: string, token: string, slug: string, files: DeployFile[]): Promise<{ url: string }> {
    if (files.length === 0) throw new Error('nothing to deploy (no files)');
    const base = endpoint.replace(/\/+$/, '');
    const body = JSON.stringify({
      slug,
      files: files.map((f) => ({ path: f.path, contentBase64: f.content.toString('base64') })),
    });
    const res = await this.fetchImpl(`${base}/api/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Self-hosted deploy failed (${res.status}): ${t.slice(0, 200)}`);
    }
    const j = (await res.json()) as { url?: string };
    // The server returns a site-root path ("/s/<slug>/") or an absolute subdomain URL; make it absolute.
    const u = j.url ?? `/s/${slug}/`;
    return { url: u.startsWith('http') ? u : `${base}${u}` };
  }
}
