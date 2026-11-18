import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ToolRegistryExecutor } from './runtime';
import { createHttpFetchTool } from './http-tool';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end('hello from server');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('http_fetch', () => {
  // allowPrivateHosts lets this test hit the local mock server; production tools omit it.
  it('GETs a URL and returns the text body', async () => {
    const exec = new ToolRegistryExecutor([createHttpFetchTool({ allowPrivateHosts: true })]);
    const r = await exec.execute('http_fetch', { url: baseUrl });
    expect(r.ok).toBe(true);
    const out = r.output as { status: number; contentType: string | null; body: string };
    expect(out.status).toBe(200);
    expect(out.body).toBe('hello from server');
    expect(out.contentType).toContain('text/plain');
  });

  it('rejects a non-URL input', async () => {
    const exec = new ToolRegistryExecutor([createHttpFetchTool({ allowPrivateHosts: true })]);
    const r = await exec.execute('http_fetch', { url: 'not a url' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid input');
  });

  it('SSRF guard (default): refuses loopback, cloud metadata, and localhost', async () => {
    const exec = new ToolRegistryExecutor([createHttpFetchTool()]);
    for (const url of [
      baseUrl, // 127.0.0.1 — blocked when the guard is on
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:4000/',
      'http://10.0.0.1/',
    ]) {
      const r = await exec.execute('http_fetch', { url });
      expect(r.ok).toBe(false);
    }
  });
});
