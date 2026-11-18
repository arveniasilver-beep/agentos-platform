# AgentOS — Android App Strategy

> **Status (TICKET-6):** this ticket ships a **PWA / mobile-control foundation**, not a native app.
> A first-class **native Android application is the ultimate product goal** and a **future ticket**.
> The backend, API, and auth model are deliberately designed to be **native-Android-ready** today.

## What TICKET-6 delivers

A mobile-first, installable **control panel** at the `/m` route of the existing Next.js web app
(`apps/web/app/m`). It lets a user, from a phone, **track tasks, view a task timeline, see the approval
queue and approve/deny, view artifacts, watch automation-run history, read project memory and the
browser trace**, and stay **consistent with desktop/web** — all over the same workspace REST APIs.

It is gated by `NEXT_PUBLIC_MOBILE_CONTROL_PANEL_ENABLED` (default false); when off, the desktop web app
is untouched. It is **not** "just a responsive web page" — it is the deliberate first layer of the
Android product, built so the native shell drops on top without backend rework.

## Why PWA-first now (not native yet)

The repo currently has **no native Android toolchain** (no Gradle, Kotlin, React Native, Flutter, or
Capacitor), and this environment cannot build/emulate Android. Adding a native project now would be
premature and unbuildable. The web app is already a **static-export SPA** that also runs "inside the
desktop shell over `app://`" — the same wrap-the-web-bundle model an Android shell will use. So the
fastest path to real value, with the native future fully open, is a PWA-first control panel.

## Native Android future path (options + recommendation)

| Option | What it is | Effort | Notes |
|---|---|---|---|
| **TWA (Trusted Web Activity)** | Wrap the installable PWA (`/m`) in an Android shell | Low | Reuses the PWA 1:1; needs Play asset-links; closest to "ship the PWA as an app" |
| **Capacitor** | Embed the web bundle + native plugin bridge (secure storage, push) | Low–Med | Best when we need native APIs (Keystore, push, file access) around the same UI |
| **React Native / Flutter** | Re-implement the UI natively, call the same REST APIs | High | Only if we need fully-native UX/perf; backend unchanged |
| **Native Kotlin/Compose** | Native UI on the same REST APIs | High | Maximum control; most work |

**Recommended path:** start with **TWA/Capacitor** wrapping the `/m` PWA (reuses this ticket's UI and
the device-Bearer auth), and graduate specific screens to native (Kotlin/Compose or RN) only where the
UX demands it. No backend change is required for any option — they all consume the existing
`/workspaces/:id/...` REST APIs + `/sync/snapshot` with a device Bearer token.

## Auth & token storage (security)

- **Web / PWA-in-browser:** authenticates with the **httpOnly session cookie**. No bearer token is
  stored client-side; JS cannot read the cookie.
- **Native shell (future):** provides a **device Bearer token** (registered via `/auth/devices`, gated
  by `DEVICE_SYNC_ENABLED`) through a **token-provider abstraction** (`apps/web/lib/device-auth.ts`).
  The token MUST come from **Android Keystore / Secure Storage** — it is **never** written to
  localStorage/sessionStorage or the DOM.
- **Offline cache** (`apps/web/lib/mobile-cache.ts`) stores **only** the already-minimal, secret-free
  sync snapshot, with a TTL, and is **cleared on 401 / revoked / logout**. No token, cookie, prompt,
  secret, or API key ever enters the cache, the UI, or the audit log.
- **Revoked devices fail closed:** `AuthGuard` rejects a revoked device token; the mobile UI shows a
  safe re-auth state.

## Out of scope (future tickets)

Play Store submission · final APK / signed release · production push-notification setup ·
full offline-first sync · billing · a large redesign · the native Android project itself.
