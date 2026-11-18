import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeSlug,
  route,
  resolveWithin,
  deploySite,
  serveTarget,
  readSiteFile,
  contentType,
  type HostingConfig,
} from './app';

describe('hosting-server app', () => {
  let dataDir: string;
  let cfg: HostingConfig;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-srv-'));
    cfg = { dataDir, token: 'secret', baseHost: 'sites.example.com' };
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('sanitizes slugs to DNS-safe labels', () => {
    expect(sanitizeSlug('My Cool Site!')).toBe('my-cool-site');
    expect(sanitizeSlug('--a__b--')).toBe('a--b');
    expect(sanitizeSlug('x'.repeat(100)).length).toBe(63);
  });

  it('routes by subdomain and by /s/<slug>/ path', () => {
    expect(route('proj1.sites.example.com', 'sites.example.com', '/about')).toEqual({ slug: 'proj1', rel: '/about' });
    expect(route('sites.example.com', 'sites.example.com', '/s/proj2/x.css')).toEqual({ slug: 'proj2', rel: '/x.css' });
    expect(route('www.sites.example.com', 'sites.example.com', '/')).toBeNull();
    expect(route('sites.example.com', 'sites.example.com', '/nope')).toBeNull();
  });

  it('refuses path traversal out of the site root', () => {
    expect(resolveWithin(dataDir, 'p', '../../etc/passwd')).toBeNull();
    expect(resolveWithin(dataDir, 'p', '/index.html')).not.toBeNull();
  });

  it('deploys files then serves them (with index.html fallback)', async () => {
    const { url } = await deploySite(cfg, 'My Site', [
      { path: 'index.html', contentBase64: b64('<h1>home</h1>') },
      { path: 'assets/app.css', contentBase64: b64('body{}') },
    ]);
    expect(url).toBe('https://my-site.sites.example.com/');

    // Directory → index.html
    const home = await serveTarget(cfg, 'my-site', '/');
    expect(home).not.toBeNull();
    expect((await readSiteFile(home!.path)).toString()).toBe('<h1>home</h1>');
    expect(contentType(home!.path)).toContain('text/html');

    // Nested asset
    const css = await serveTarget(cfg, 'my-site', '/assets/app.css');
    expect((await readSiteFile(css!.path)).toString()).toBe('body{}');

    // Unknown extensionless path → SPA fallback to index.html
    const spa = await serveTarget(cfg, 'my-site', '/some/route');
    expect((await readSiteFile(spa!.path)).toString()).toBe('<h1>home</h1>');

    // Missing asset (has extension) → not found
    expect(await serveTarget(cfg, 'my-site', '/missing.js')).toBeNull();
  });

  it('re-deploying replaces the previous site contents', async () => {
    await deploySite(cfg, 's', [{ path: 'index.html', contentBase64: b64('v1') }, { path: 'old.txt', contentBase64: b64('x') }]);
    await deploySite(cfg, 's', [{ path: 'index.html', contentBase64: b64('v2') }]);
    expect((await readSiteFile((await serveTarget(cfg, 's', '/'))!.path)).toString()).toBe('v2');
    expect(await serveTarget(cfg, 's', '/old.txt')).toBeNull(); // gone
  });

  it('path-mode (no baseHost) returns a /s/<slug>/ url', async () => {
    const pathCfg: HostingConfig = { dataDir, token: 't', baseHost: '' };
    const { url } = await deploySite(pathCfg, 'p', [{ path: 'index.html', contentBase64: b64('hi') }]);
    expect(url).toBe('/s/p/');
  });

  it('rejects an empty deploy', async () => {
    await expect(deploySite(cfg, 's', [])).rejects.toThrow(/no files/);
  });
});
