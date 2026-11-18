import { randomBytes } from 'node:crypto';

/** Generate a fresh, unguessable base64 CSP nonce (128 bits of entropy). */
export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Derive the `connect-src` entries the renderer needs to reach an API origin: the HTTP origin for
 * REST + Socket.IO polling, and the matching ws(s):// origin for the WebSocket upgrade.
 */
export function apiConnectSources(apiOrigin: string): string[] {
  const http = apiOrigin.replace(/\/$/, '');
  const ws = http.replace(/^http/, 'ws');
  return [http, ws];
}

/**
 * Build the Content-Security-Policy for the desktop renderer.
 *
 * Hardened by design (fixes the teardown-flagged Manus weaknesses):
 *  - no `unsafe-inline`/`unsafe-eval` for scripts — only same-origin + the per-request nonce;
 *  - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`;
 *  - `connect-src` limited to our app origin plus explicitly-allowed API origins.
 *
 * Phase 6 tightens `script-src` to add `'strict-dynamic'` once the renderer is E2E-verified.
 */
export function buildCspHeader(nonce: string, connectSrc: string[] = []): string {
  const connect = ["'self'", ...connectSrc].join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    // No native form posts in the SPA — pin form targets to our own origin so an injected <form> can't
    // exfiltrate to an external URL (connect-src already blocks fetch/XHR/WS exfil).
    "form-action 'self'",
  ].join('; ');
}
