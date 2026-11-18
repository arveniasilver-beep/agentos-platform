/**
 * API origin the SPA talks to. Baked at build time via NEXT_PUBLIC_API_BASE so the same static
 * bundle can target a dev API, a deployed API, or localhost from inside the desktop shell.
 */
export const API_BASE: string =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, '') ?? 'http://localhost:4000';

/**
 * Mobile Control Panel (TICKET-6). OFF by default: when false, the /m route renders a disabled stub and
 * the desktop web app is unaffected. Baked at build time. The backend device-Bearer path is separately
 * gated by the server's DEVICE_SYNC_ENABLED.
 */
export const MOBILE_CONTROL_PANEL_ENABLED: boolean =
  process.env.NEXT_PUBLIC_MOBILE_CONTROL_PANEL_ENABLED === 'true';

/**
 * Multi-turn follow-up (KEYSTONE). OFF by default: when false a finished task is one-shot (no reply box),
 * byte-identical to before. The server gates the actual endpoint separately via FOLLOWUP_TURNS_ENABLED.
 */
export const FOLLOWUP_TURNS_ENABLED: boolean =
  process.env.NEXT_PUBLIC_FOLLOWUP_TURNS_ENABLED === 'true';

