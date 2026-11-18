import { loadServerEnv } from '@agentos/config';

/** Session cookie name (generic, brand-neutral). */
export const SESSION_COOKIE = 'sid';

/**
 * Cookie options. `secure` is driven by the environment: true in production (HTTPS-only, so the
 * session token is never sent over plaintext HTTP), false in dev for local http. httpOnly blocks
 * JS access; sameSite=lax limits cross-site sending.
 */
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: loadServerEnv().NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 7, // 7 days, in seconds
};
