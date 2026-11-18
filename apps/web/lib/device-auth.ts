// Device auth token provider (TICKET-6) — a deliberate abstraction so the token source is pluggable.
//
// SECURITY: the web/PWA path authenticates with the httpOnly session COOKIE — there is NO bearer token
// stored client-side at all (JS can't read the cookie, and we never write a token to localStorage).
// A future native Android shell (TWA / Capacitor / Kotlin) injects a provider whose getToken() reads
// from Android Keystore / Secure Storage. The token therefore never touches localStorage or the DOM.

export interface DeviceTokenProvider {
  /** Return the current device bearer token, or null to fall back to cookie auth. In-memory only. */
  getToken(): string | null;
}

// Default provider: cookie mode (no bearer). Replaced at runtime by a native shell, never persisted.
let provider: DeviceTokenProvider = { getToken: () => null };

/** Inject a secure-storage-backed provider (native shell). The token stays in the provider's closure —
 * we never copy it to localStorage/sessionStorage. */
export function setDeviceTokenProvider(p: DeviceTokenProvider): void {
  provider = p;
}

/** Read the bearer token for the current request (or null => cookie auth). */
export function getDeviceToken(): string | null {
  return provider.getToken();
}

/** Drop the provider (logout / 401 / revoked) so subsequent calls fall back to cookie / fail closed. */
export function clearDeviceToken(): void {
  provider = { getToken: () => null };
}
