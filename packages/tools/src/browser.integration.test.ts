import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession, createBrowserTools } from './browser-tools';
import { ToolRegistryExecutor } from './runtime';

// Probe whether Chromium can launch in this environment; skip cleanly if not (mirrors the
// Redis/Postgres-gated suites). CI installs Chromium so this runs there.
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

const HTML =
  'data:text/html,<html><head><title>AgentOS%20Test</title></head>' +
  '<body><h1>Hello%20Browser</h1><p>the%20marker%20is%20XYZ123</p>' +
  '<button id="go">Go</button></body></html>';

describe('browser tools (headless Chromium)', () => {
  it('navigates, reads page text, and screenshots through the tool registry', async () => {
    if (!(await chromiumAvailable())) {
      console.warn('browser integration: Chromium unavailable, skipping');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'aos-browser-'));
    const session = new BrowserSession({ headless: true, artifactDir: dir });
    const tools = new ToolRegistryExecutor(createBrowserTools(session));

    try {
      // The registry exposes the browser tools with their risk levels.
      const names = tools.list().map((t) => t.name).sort();
      expect(names).toEqual([
        'browser_click',
        'browser_download',
        'browser_navigate',
        'browser_read',
        'browser_screenshot',
        'browser_type',
        'browser_upload',
      ]);

      const nav = await tools.execute('browser_navigate', { url: HTML });
      expect(nav.ok).toBe(true);
      expect((nav.output as { title: string }).title).toBe('AgentOS Test');

      const read = await tools.execute('browser_read', {});
      expect(read.ok).toBe(true);
      const out = read.output as { text: string; title: string };
      expect(out.text).toContain('Hello Browser');
      expect(out.text).toContain('XYZ123');

      const shot = await tools.execute('browser_screenshot', {});
      expect(shot.ok).toBe(true);
      expect((shot.output as { path?: string }).path).toBeTruthy();
      const files = await readdir(dir);
      expect(files.some((f) => f.endsWith('.png'))).toBe(true);
    } finally {
      await session.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('uploads a sandbox file into a file input and downloads a file as an artifact', async () => {
    if (!(await chromiumAvailable())) {
      console.warn('browser upload/download: Chromium unavailable, skipping');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'aos-browser-io-'));
    await writeFile(join(dir, 'attachment.txt'), 'payload-to-upload');
    const session = new BrowserSession({ headless: true, artifactDir: dir });
    const tools = new ToolRegistryExecutor(createBrowserTools(session));
    const page =
      'data:text/html,<html><head><title>IO</title></head><body>' +
      '<input id="f" type="file" />' +
      '<a id="dl" download="report.txt" href="data:text/plain,downloaded-bytes">Download</a>' +
      '</body></html>';
    try {
      expect((await tools.execute('browser_navigate', { url: page })).ok).toBe(true);

      // Upload a sandbox file; a path escaping the sandbox is refused.
      const up = await tools.execute('browser_upload', { selector: '#f', path: 'attachment.txt' });
      expect(up.ok).toBe(true);
      expect((up.output as { uploaded: string }).uploaded).toBe('attachment.txt');
      const escape = await tools.execute('browser_upload', { selector: '#f', path: '../../etc/hosts' });
      expect(escape.ok).toBe(false);

      // Download a file → saved under downloads/ as a task artifact.
      const dl = await tools.execute('browser_download', { selector: '#dl' });
      expect(dl.ok).toBe(true);
      const out = dl.output as { path: string; bytes: number; filename: string };
      expect(out.path).toBe('downloads/report.txt');
      expect(out.bytes).toBeGreaterThan(0);
      const downloaded = await readFile(join(dir, out.path), 'utf8');
      expect(downloaded).toBe('downloaded-bytes');
    } finally {
      await session.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
