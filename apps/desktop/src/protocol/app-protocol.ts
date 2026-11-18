import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { BRAND } from '@agentos/brand';
import { generateNonce, buildCspHeader } from '../security/csp';

/** Privileged asset scheme (e.g. `app://`) — NOT file://, NOT a localhost HTTP server. */
export const APP_SCHEME = BRAND.assetScheme;
const APP_HOST = 'local';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Build an app://local/... URL for the renderer to load. */
export function buildAppUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${APP_SCHEME}://${APP_HOST}${p}`;
}

/** Must be called BEFORE app `ready`. Marks the asset scheme standard + secure. */
export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Resolve a request path to a file inside webRoot, blocking path traversal. */
export function resolveFile(webRoot: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding — refuse rather than throw in the protocol handler
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const candidate = normalize(join(webRoot, rel));
  const rootWithSep = webRoot.endsWith(sep) ? webRoot : webRoot + sep;
  if (candidate !== webRoot && !candidate.startsWith(rootWithSep)) {
    return null; // traversal attempt — refuse
  }
  if (existsSync(candidate)) return candidate;
  // SPA fallback for extension-less client routes
  if (!extname(candidate)) {
    const indexHtml = normalize(join(webRoot, 'index.html'));
    if (existsSync(indexHtml)) return indexHtml;
  }
  return null;
}

/** Register the app:// handler that serves the static web export with a strict per-request CSP. */
export function registerAppProtocol(webRoot: string, connectSrc: string[] = []): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const filePath = resolveFile(webRoot, url.pathname);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const nonce = generateNonce();
    const csp = buildCspHeader(nonce, connectSrc);

    if (ext === '.html') {
      let html = await readFile(filePath, 'utf8');
      // Nonce every <script> so the strict CSP admits the app's own bootstrap scripts.
      html = html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': contentType, 'Content-Security-Policy': csp },
      });
    }

    const data = await readFile(filePath);
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Security-Policy': csp },
    });
  });
}
