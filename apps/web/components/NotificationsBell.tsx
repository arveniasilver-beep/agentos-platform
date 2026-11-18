'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type NotificationView } from '../lib/api';

/**
 * Header notification bell: polls the unread count, and on click shows the recent notifications
 * (approval-needed / task-done) with mark-as-read. Best-effort — failures are silent.
 */
export function NotificationsBell({ workspaceId }: { workspaceId: string }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationView[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api
      .getNotifications(workspaceId)
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch(() => undefined);
  }, [workspaceId]);

  // Poll the count every 30s (and once on mount / workspace change).
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function markAll() {
    const r = await api.markNotificationsRead(workspaceId).catch(() => null);
    if (r) {
      setUnread(r.unread);
      setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })));
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) refresh();
        }}
        className="relative text-slate-400 hover:text-slate-200"
        title="Notifications"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -right-2 -top-1 rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-slate-800 bg-slate-950 p-2 shadow-xl">
          <div className="mb-1 flex items-center justify-between px-2 py-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-emerald-400 hover:text-emerald-300">
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-slate-500">No notifications.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={`rounded-lg px-2 py-2 text-sm ${n.readAt ? 'text-slate-400' : 'bg-slate-900/60 text-slate-200'}`}
                >
                  <div className="flex items-center gap-2">
                    <span>{n.kind === 'approval_request' ? '⏳' : n.title.includes('failed') ? '✗' : '✓'}</span>
                    <span className="font-medium">{n.title}</span>
                  </div>
                  {n.body && <p className="mt-0.5 truncate text-xs text-slate-500">{n.body}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
