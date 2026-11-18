'use client';

import { MOBILE_CONTROL_PANEL_ENABLED } from '../../lib/config';
import { MobileShell } from '../../components/mobile/MobileShell';

/**
 * Mobile Control Panel route (TICKET-6). PWA/mobile-control foundation — a first-class, installable
 * mobile surface that consumes the same workspace APIs (device Bearer + cookie). The native Android
 * app (TWA / Capacitor / Kotlin) is a future ticket; the backend/auth model is already native-ready.
 * Flag-gated: when NEXT_PUBLIC_MOBILE_CONTROL_PANEL_ENABLED is off, this renders a disabled stub and the
 * desktop web app is untouched.
 */
export default function MobilePage() {
  if (!MOBILE_CONTROL_PANEL_ENABLED) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 p-6 text-center text-slate-300">
        <h1 className="text-lg font-semibold">AgentOS Mobile</h1>
        <p className="text-sm text-slate-500">
          The mobile control panel is not enabled in this build. Set
          <code className="mx-1 rounded bg-slate-800 px-1">NEXT_PUBLIC_MOBILE_CONTROL_PANEL_ENABLED=true</code>
          to enable it.
        </p>
      </main>
    );
  }
  return <MobileShell />;
}
