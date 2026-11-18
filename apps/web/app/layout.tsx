import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BRAND } from '@agentos/brand';
import { THEME_BOOTSTRAP } from '../lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: BRAND.appName,
  description: `${BRAND.appName} — production-grade AI agent operating platform`,
  // TICKET-6: PWA manifest so the mobile control panel is installable on Android (TWA/Capacitor-ready).
  manifest: '/manifest.webmanifest',
};

// TICKET-6: mobile viewport (was absent) so /m renders correctly on small screens. Additive — desktop
// layouts are fixed-width and unaffected.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before paint to avoid a light/dark flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
