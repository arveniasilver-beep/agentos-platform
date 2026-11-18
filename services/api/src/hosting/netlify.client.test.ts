import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { NetlifyClient } from './netlify.client';

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockFetch(handlers: Record<string, (call: Call) => { status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = { url: String(url), method, ...(body !== undefined ? { body } : {}) };
    calls.push(call);
    // Match the most specific (longest) handler key contained in the URL+method, so e.g.
    // "POST /sites/site_1/deploys" doesn't get captured by the shorter "POST /sites".
    const key = Object.keys(handlers)
      .sort((a, b) => b.length - a.length)
      .find((k) => `${method} ${url}`.includes(k));
    const out = key ? handlers[key]!(call) : { status: 404, text: 'no handler' };
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.json ?? {},
      text: async () => out.text ?? JSON.stringify(out.json ?? {}),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('NetlifyClient', () => {
  it('creates a site, announces the digest, uploads only required files, returns the URL', async () => {
    const indexSha = createHash('sha1').update(Buffer.from('<h1>hi</h1>')).digest('hex');
    const cssSha = createHash('sha1').update(Buffer.from('body{}')).digest('hex');

    const { impl, calls } = mockFetch({
      'POST https://api.netlify.com/api/v1/sites': () => ({
        json: { id: 'site_1', ssl_url: 'https://my-site.netlify.app' },
      }),
      'POST https://api.netlify.com/api/v1/sites/site_1/deploys': () => ({
        // Netlify says it only needs index.html (css already known).
        json: { id: 'dep_1', required: [indexSha] },
      }),
      'PUT https://api.netlify.com/api/v1/deploys/dep_1/files/': () => ({ json: { id: 'f' } }),
    });

    const client = new NetlifyClient(impl);
    const res = await client.deploy('tok', null, [
      { path: 'index.html', content: Buffer.from('<h1>hi</h1>') },
      { path: 'styles.css', content: Buffer.from('body{}') },
    ]);

    expect(res).toEqual({ siteId: 'site_1', url: 'https://my-site.netlify.app' });
    // Digest body announced both files with correct SHA1s.
    const deployCall = calls.find((c) => c.url.endsWith('/sites/site_1/deploys'))!;
    expect(JSON.parse(deployCall.body!)).toEqual({ files: { '/index.html': indexSha, '/styles.css': cssSha } });
    // Only the required file (index.html) was PUT — styles.css was skipped.
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain('/deploys/dep_1/files/index.html');
  });

  it('reuses an existing siteId (no site creation) and resolves the URL', async () => {
    const { impl, calls } = mockFetch({
      'POST https://api.netlify.com/api/v1/sites/site_9/deploys': () => ({ json: { id: 'dep_9', required: [] } }),
      'GET https://api.netlify.com/api/v1/sites/site_9': () => ({ json: { ssl_url: 'https://nine.netlify.app' } }),
    });
    const client = new NetlifyClient(impl);
    const res = await client.deploy('tok', 'site_9', [{ path: 'index.html', content: Buffer.from('x') }]);
    expect(res.siteId).toBe('site_9');
    expect(res.url).toBe('https://nine.netlify.app');
    // No POST /sites (site creation) happened.
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/sites'))).toBe(false);
  });

  it('throws with no files', async () => {
    const { impl } = mockFetch({});
    await expect(new NetlifyClient(impl).deploy('tok', null, [])).rejects.toThrow(/nothing to deploy/);
  });
});
