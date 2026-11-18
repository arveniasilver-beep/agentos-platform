'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SessionUser, type SyncSnapshot } from '../../lib/api';
import { clearDeviceToken } from '../../lib/device-auth';
import { cacheSnapshot, readCachedSnapshot, clearSnapshotCache } from '../../lib/mobile-cache';
import {
  MobileTaskDetail,
  MobileApprovals,
  MobileAutomations,
  MobileMemoryView,
  MobileBrowserTrace,
  MobileWorkflows,
  StatusDot,
  Empty,
} from './MobileScreens';

type Tab = 'tasks' | 'approvals' | 'artifacts' | 'automations' | 'more';
const TABS: Array<[Tab, string, string]> = [
  ['tasks', '🗒️', 'Tasks'],
  ['approvals', '✅', 'Approvals'],
  ['artifacts', '📦', 'Artifacts'],
  ['automations', '⚡', 'Runs'],
  ['more', '⋯', 'More'],
];

/** Mobile control panel shell (TICKET-6): bottom-nav, snapshot-driven, fail-closed on revoked/401. */
export function MobileShell() {
  const [phase, setPhase] = useState<'loading' | 'reauth' | 'ready'>('loading');
  const [, setUser] = useState<SessionUser | null>(null);
  const [wsId, setWsId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('tasks');
  const [snap, setSnap] = useState<SyncSnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [staleMs, setStaleMs] = useState<number | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [moreView, setMoreView] = useState<'menu' | 'memory' | 'browser' | 'workflows'>('menu');

  const failClosed = useCallback(() => {
    clearDeviceToken();
    clearSnapshotCache();
    setSnap(null);
    setPhase('reauth');
  }, []);

  const refresh = useCallback(
    async (workspaceId: string) => {
      try {
        const s = await api.syncSnapshot(workspaceId);
        setSnap(s);
        setOffline(false);
        setStaleMs(null);
        cacheSnapshot(workspaceId, s);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          failClosed();
          return;
        }
        const cached = readCachedSnapshot(workspaceId);
        if (cached) {
          setSnap(cached.snap);
          setStaleMs(cached.ageMs);
        }
        setOffline(true);
      }
    },
    [failClosed],
  );

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setUser(me);
        const ws = await api.listWorkspaces();
        const id = ws[0]?.id ?? '';
        setWsId(id);
        if (id) await refresh(id);
        setPhase('ready');
      } catch {
        failClosed();
      }
    })();
  }, [refresh, failClosed]);

  // Light polling so a decision made on desktop appears here (and vice-versa).
  useEffect(() => {
    if (phase !== 'ready' || !wsId) return;
    const t = setInterval(() => void refresh(wsId), 15_000);
    return () => clearInterval(t);
  }, [phase, wsId, refresh]);

  if (phase === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  }
  if (phase === 'reauth') {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-lg font-semibold text-slate-200">Session ended</h1>
        <p className="text-sm text-slate-500">Your device session is missing, expired, or was revoked. Sign in again to continue.</p>
        <a href="/" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white">Go to sign in</a>
      </main>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <span className="text-sm font-semibold">AgentOS</span>
        <span className="flex items-center gap-2 text-xs text-slate-500">
          {snap && snap.unreadNotifications > 0 && <span className="rounded-full bg-rose-600 px-1.5 text-white">{snap.unreadNotifications}</span>}
          <button onClick={() => void refresh(wsId)} className="text-slate-400">↻</button>
        </span>
      </header>

      {offline && (
        <div className="bg-amber-900/60 px-4 py-1.5 text-center text-xs text-amber-200">
          Offline — showing cached data{staleMs != null ? ` (${Math.round(staleMs / 1000)}s old)` : ''}. Reconnecting…
        </div>
      )}

      <main className="flex-1 overflow-y-auto px-4 py-3 pb-24">
        {selectedTask ? (
          <MobileTaskDetail workspaceId={wsId} taskId={selectedTask} onBack={() => setSelectedTask(null)} />
        ) : tab === 'tasks' ? (
          <TasksTab snap={snap} onOpen={setSelectedTask} />
        ) : tab === 'approvals' ? (
          <MobileApprovals workspaceId={wsId} snap={snap} onChanged={() => void refresh(wsId)} />
        ) : tab === 'artifacts' ? (
          <ArtifactsTab snap={snap} />
        ) : tab === 'automations' ? (
          <MobileAutomations workspaceId={wsId} snap={snap} />
        ) : moreView === 'memory' ? (
          <MobileMemoryView workspaceId={wsId} onBack={() => setMoreView('menu')} />
        ) : moreView === 'browser' ? (
          <MobileBrowserTrace workspaceId={wsId} onBack={() => setMoreView('menu')} />
        ) : moreView === 'workflows' ? (
          <MobileWorkflows workspaceId={wsId} onBack={() => setMoreView('menu')} />
        ) : (
          <MoreMenu onPick={setMoreView} />
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-md items-center justify-around border-t border-slate-800 bg-slate-950/95 py-2 backdrop-blur">
        {TABS.map(([id, icon, label]) => (
          <button
            key={id}
            onClick={() => {
              setSelectedTask(null);
              setMoreView('menu');
              setTab(id);
            }}
            className={`flex flex-col items-center gap-0.5 px-3 text-[11px] ${tab === id && !selectedTask ? 'text-emerald-400' : 'text-slate-500'}`}
          >
            <span className="text-base">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function TasksTab({ snap, onOpen }: { snap: SyncSnapshot | null; onOpen: (id: string) => void }) {
  const tasks = snap?.tasks ?? [];
  if (tasks.length === 0) return <Empty label="No recent tasks." />;
  return (
    <ul className="space-y-2">
      {tasks.map((t) => (
        <li key={t.id}>
          <button onClick={() => onOpen(t.id)} className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-left">
            <span className="flex min-w-0 items-center gap-2">
              <StatusDot status={t.status} />
              <span className="truncate text-sm">{t.title || 'Untitled'}</span>
            </span>
            <span className="shrink-0 text-xs text-slate-500">{t.status}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ArtifactsTab({ snap }: { snap: SyncSnapshot | null }) {
  const arts = snap?.artifacts ?? [];
  if (arts.length === 0) return <Empty label="No artifacts yet." />;
  return (
    <ul className="space-y-2">
      {arts.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
          <span className="min-w-0">
            <span className="block truncate text-sm">{a.name}</span>
            <span className="text-xs text-slate-500">{a.kind}</span>
          </span>
          <span className="shrink-0 text-xs text-slate-600">{new Date(a.createdAt).toLocaleDateString()}</span>
        </li>
      ))}
    </ul>
  );
}

function MoreMenu({ onPick }: { onPick: (v: 'memory' | 'browser' | 'workflows') => void }) {
  const items: Array<['memory' | 'browser' | 'workflows', string, string]> = [
    ['memory', '🧠', 'Project Memory'],
    ['browser', '🌐', 'Browser Trace'],
    ['workflows', '🔀', 'Workflows'],
  ];
  return (
    <ul className="space-y-2">
      {items.map(([id, icon, label]) => (
        <li key={id}>
          <button onClick={() => onPick(id)} className="flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-3 text-left text-sm">
            <span>{icon}</span>
            {label}
          </button>
        </li>
      ))}
      <li>
        <a href="/" className="block rounded-lg border border-slate-800 bg-slate-900 px-3 py-3 text-sm text-slate-400">Open full desktop app →</a>
      </li>
    </ul>
  );
}
