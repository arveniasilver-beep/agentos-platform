import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostingTools, type PublishSite } from './index';

describe('hosting (publish_site) tool', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'host-'));
    mkdirSync(join(root, 'site', 'assets'), { recursive: true });
    writeFileSync(join(root, 'site', 'index.html'), '<h1>hi</h1>');
    writeFileSync(join(root, 'site', 'assets', 'app.css'), 'body{}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const tool = (publishSite: PublishSite) => createHostingTools({ root, publishSite })[0]!;

  it('is high-risk + approval-gated (publishing is a public, outward action)', () => {
    const t = tool(async () => ({ url: 'x' }));
    expect(t.definition.riskLevel).toBe('high');
    expect(t.definition.approvalRequired).toBe(true);
  });

  it('collects the folder + derives a slug, and returns the published URL', async () => {
    let received: { path: string }[] = [];
    let receivedSlug = '';
    const t = tool(async ({ slug, files }) => {
      received = files;
      receivedSlug = slug;
      return { url: 'https://my-site.netlify.app' };
    });
    const res = (await t.run({ dir: 'site' })) as { url: string; files: number };
    expect(res.url).toBe('https://my-site.netlify.app');
    expect(res.files).toBe(2);
    expect(receivedSlug).toBe('site'); // slug from the folder name
    expect(received.map((f) => f.path).sort()).toEqual(['assets/app.css', 'index.html']);
  });

  it('refuses a path escaping the sandbox, a missing dir, and a folder without index.html', async () => {
    const t = tool(async () => ({ url: 'x' }));
    await expect(t.run({ dir: '../etc' })).rejects.toThrow(/escapes|no such directory/);
    await expect(t.run({ dir: 'nope' })).rejects.toThrow(/no such directory/);
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'empty', 'about.html'), 'x');
    await expect(t.run({ dir: 'empty' })).rejects.toThrow(/index\.html/);
  });
});
