import { mkdir, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import { join, normalize, extname, dirname, sep } from 'node:path';

/**
 * AgentOS self-hosted hosting server (the "ours, on our VPS" alternative to Netlify). A tiny,
 * dependency-free service that:
 *   - accepts authenticated site uploads (POST /api/deploy) and stores them under DATA_DIR/<slug>/,
 *   - serves them publicly, routed by subdomain (<slug>.BASE_HOST) or path (/s/<slug>/...).
 * Pure helpers live here (unit-tested); server.ts only wires them to an HTTP listener.
 */
export interface HostingConfig {
  dataDir: string;
  /** Bearer token required for deploy/delete. Empty disables the write API (serve-only). */
  token: string;
  /** Apex host for subdomain routing, e.g. "sites.example.com". Empty → path-based only. */
  baseHost: string;
}

export interface DeployFile {
  path: string;
  /** base64-encoded file content. */
  contentBase64: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

export function contentType(p: string): string {
  return MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
}

/** A safe site slug: lowercase, [a-z0-9-], no leading/trailing dash, max 63 chars (DNS-label safe). */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** Resolve a request path inside DATA_DIR/<slug>, guarding against traversal. Returns null if it escapes. */
export function resolveWithin(dataDir: string, slug: string, rel: string): string | null {
  const root = join(dataDir, slug);
  const clean = rel.split('?')[0]!.split('#')[0]!;
  const decoded = (() => {
    try {
      return decodeURIComponent(clean);
    } catch {
      return clean;
    }
  })();
  const abs = normalize(join(root, decoded));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** From a Host header + URL path, work out which site and in-site path is requested. */
export function route(
  host: string | undefined,
  baseHost: string,
  urlPath: string,
): { slug: string; rel: string } | null {
  const h = (host ?? '').toLowerCase().split(':')[0]!;
  // Subdomain routing: <slug>.BASE_HOST
  if (baseHost && h.endsWith('.' + baseHost)) {
    const slug = h.slice(0, h.length - baseHost.length - 1);
    if (slug && slug !== 'www') return { slug, rel: urlPath || '/' };
  }
  // Path routing: /s/<slug>/...
  const m = /^\/s\/([^/]+)(\/.*)?$/.exec(urlPath);
  if (m) return { slug: m[1]!, rel: m[2] || '/' };
  return null;
}

/** Write a site's files under DATA_DIR/<slug>/ (replacing any previous deploy). */
export async function deploySite(cfg: HostingConfig, slug: string, files: DeployFile[]): Promise<{ url: string }> {
  const safe = sanitizeSlug(slug);
  if (!safe) throw new Error('invalid slug');
  if (files.length === 0) throw new Error('no files');
  const root = join(cfg.dataDir, safe);
  await rm(root, { recursive: true, force: true });
  for (const f of files) {
    const abs = resolveWithin(cfg.dataDir, safe, f.path);
    if (!abs) throw new Error(`file path escapes the site root: ${f.path}`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(f.contentBase64, 'base64'));
  }
  const url = cfg.baseHost ? `https://${safe}.${cfg.baseHost}/` : `/s/${safe}/`;
  return { url };
}

/** Find the file to serve for a (slug, rel), applying an index.html fallback for directories. */
export async function serveTarget(cfg: HostingConfig, slug: string, rel: string): Promise<{ path: string } | null> {
  const safe = sanitizeSlug(slug);
  let abs = resolveWithin(cfg.dataDir, safe, rel);
  if (!abs) return null;
  const s = await stat(abs).catch(() => null);
  if (s?.isDirectory()) {
    abs = join(abs, 'index.html');
  } else if (!s) {
    // SPA-friendly: unknown path with no extension → fall back to the site's index.html.
    if (!extname(rel)) abs = resolveWithin(cfg.dataDir, safe, 'index.html');
    if (!abs) return null;
  }
  const f = await stat(abs).catch(() => null);
  if (!f?.isFile()) return null;
  // Defense-in-depth: confirm the resolved file is genuinely inside the slug root even THROUGH
  // symlinks (resolveWithin is only lexical) — so a planted symlink can't be served from the public
  // GET handler. Mirrors the symlink-safe safeResolve used elsewhere.
  try {
    const [realFile, realRoot] = await Promise.all([realpath(abs), realpath(join(cfg.dataDir, sanitizeSlug(slug)))]);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return null;
  } catch {
    return null;
  }
  return { path: abs };
}

export async function readSiteFile(path: string): Promise<Buffer> {
  return readFile(path);
}
