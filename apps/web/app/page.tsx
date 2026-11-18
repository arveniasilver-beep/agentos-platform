'use client';

import { useEffect, useState } from 'react';
import { api, type SessionUser } from '../lib/api';
import { AuthPanel } from '../components/AuthPanel';
import { WorkspaceView } from '../components/WorkspaceView';

export default function HomePage() {
  // undefined = still checking the session; null = signed out; object = signed in.
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then((u) => setUser(u))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-500">
        Loading…
      </main>
    );
  }

  if (user === null) {
    return (
      <main className="min-h-screen bg-slate-950">
        <AuthPanel onAuthed={setUser} />
      </main>
    );
  }

  return <WorkspaceView user={user} onSignedOut={() => setUser(null)} />;
}
