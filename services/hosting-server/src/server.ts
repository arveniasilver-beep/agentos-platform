import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  deploySite,
  serveTarget,
  readSiteFile,
  contentType,
  route,
  type HostingConfig,
  type DeployFile,
} from './app';

const cfg: HostingConfig = {
  dataDir: process.env.HOSTING_DATA_DIR ?? '/data/sites',
  token: process.env.HOSTING_DEPLOY_TOKEN ?? '',
  baseHost: (process.env.HOSTING_BASE_HOST ?? '').toLowerCase(),
};
const PORT = Number(process.env.PORT ?? 8080);
// Upload cap on the ENCODED JSON body. The publish tool admits ≤25 MB of RAW files; base64 inflates
// by ~33% plus JSON overhead, so the encoded body needs headroom above 25·4/3 ≈ 33 MB.
const MAX_BODY = 40 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY) throw new Error('payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage): boolean {
  if (!cfg.token) return false;
  const presented = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${cfg.token}`);
  // Constant-time compare so response timing doesn't leak how many leading bytes of the token match.
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (url === '/healthz') return send(res, 200, 'ok');

  // ---- Write API (authenticated) ----
  if (url === '/api/deploy' && method === 'POST') {
    if (!authorized(req)) return send(res, 401, 'unauthorized');
    let payload: { slug?: string; files?: DeployFile[] };
    try {
      payload = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return send(res, 400, 'invalid JSON');
    }
    if (!payload.slug || !Array.isArray(payload.files)) return send(res, 400, 'slug and files are required');
    try {
      const { url: liveUrl } = await deploySite(cfg, payload.slug, payload.files);
      return send(res, 200, JSON.stringify({ url: liveUrl }), 'application/json; charset=utf-8');
    } catch (e) {
      return send(res, 400, e instanceof Error ? e.message : 'deploy failed');
    }
  }

  // ---- Public serving (subdomain or /s/<slug>/...) ----
  if (method === 'GET' || method === 'HEAD') {
    const r = route(req.headers.host, cfg.baseHost, url.split('?')[0]!);
    if (!r) return send(res, 404, 'not found');
    const target = await serveTarget(cfg, r.slug, r.rel);
    if (!target) return send(res, 404, 'not found');
    const buf = await readSiteFile(target.path).catch(() => null);
    if (!buf) return send(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': contentType(target.path),
      'content-length': String(buf.length),
      'cache-control': 'public, max-age=60',
    });
    res.end(method === 'HEAD' ? undefined : buf);
    return;
  }

  send(res, 405, 'method not allowed');
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) send(res, 500, 'internal error');
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`AgentOS hosting server on :${PORT} (data=${cfg.dataDir}, baseHost=${cfg.baseHost || '(path mode)'})`);
});
