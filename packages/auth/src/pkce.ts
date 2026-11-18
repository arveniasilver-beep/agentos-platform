import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * PKCE (RFC 7636) for the desktop deep-link login. The shell creates a verifier, sends only the
 * S256 challenge to the auth server, then exchanges the one-time code over HTTPS with the verifier.
 * This closes the plaintext-token-in-deep-link interception risk the Manus teardown flagged.
 */

/** Random high-entropy code verifier (43 chars, base64url). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** S256 challenge = base64url(sha256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Verify a verifier matches a challenge (constant time). */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = codeChallengeS256(verifier);
  if (computed.length !== challenge.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

/** CSRF state / nonce for the auth redirect. */
export function generateState(): string {
  return randomBytes(16).toString('base64url');
}
