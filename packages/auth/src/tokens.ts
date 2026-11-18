import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Generate an opaque, URL-safe token (default 256 bits). Used for sessions, one-time codes, API keys. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hash of a token — store this, never the plaintext token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison (avoids timing side channels on token/hash checks). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
