/**
 * packages/brand — THE single source of product identity.
 *
 * Rename the product by editing THIS file only. Enforcement:
 *  - the brand-literal ESLint guard bans the name/slug as a string literal everywhere else;
 *  - the rename-guard test (brand.test.ts) scans the tree and fails if a literal sneaks in.
 *
 * This is the ONLY file in the repo permitted to contain the raw brand literals.
 */
export const BRAND = {
  /** Human-visible product name. */
  appName: 'AgentOS',
  /** Short name (tray, compact UI surfaces). */
  appNameShort: 'AgentOS',
  /** Desktop bundle id / Electron appUserModelId. */
  appId: 'com.agentos.desktop',
  /** Deep-link scheme: `agentos://...` (PKCE auth callback, etc.). */
  protocol: 'agentos',
  /** Privileged asset protocol used by the desktop renderer (kept generic). */
  assetScheme: 'app',
  /** Base domain for hosted artifacts. */
  storageDomain: 'agentos.example',
  /** Support contact address. */
  supportEmail: 'support@agentos.example',
  /** Copyright line. */
  copyright: '© AgentOS',
} as const;

export type Brand = typeof BRAND;

/** Keys every brand must define — used by the rename-guard test. */
export const BRAND_REQUIRED_KEYS = [
  'appName',
  'appNameShort',
  'appId',
  'protocol',
  'assetScheme',
  'storageDomain',
  'supportEmail',
  'copyright',
] as const satisfies ReadonlyArray<keyof Brand>;
