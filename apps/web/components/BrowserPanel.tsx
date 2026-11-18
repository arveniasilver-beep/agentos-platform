'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type BrowserSessionRow, type BrowserActionRow } from '../lib/api';

const STATUS_COLOR: Record<string, string> = {
  idle: 'text-slate-400',
  acting: 'text-sky-400',
  awaiting_approval: 'text-amber-400',
  takeover: 'text-violet-400',
  closed: 'text-slate-500',
  error: 'text-rose-400',
};
const RISK_COLOR: Record<string, string> = {
  low: 'bg-slate-800 text-slate-300',
  medium: 'bg-sky-900 text-sky-300',
  high: 'bg-amber-900 text-amber-300',
  critical: 'bg-rose-900 text-rose-300',
};
const OUTCOME_COLOR: Record<string, string> = {
  ok: 'text-emerald-400',
  denied: 'text-rose-400',
  error: 'text-rose-400',
  awaiting_approval: 'text-amber-400',
  pending: 'text-slate-400',
};

/** Read-only Browser Operator trace (TICKET-1): durable sessions + their redacted action timeline. */
export function BrowserPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [items, setItems] = useState<BrowserSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [actions, setActions] = useState<BrowserActionRow[] | null>(null);

  useEffect(() => {
    api
      .listBrowserSessions(workspaceId)
      .then(setItems)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load browser sessions'));
  }, [workspaceId]);

  async function toggle(s: BrowserSessionRow) {
    if (open === s.id) {
      setOpen(null);
      return;
    }
    setOpen(s.id);
    setActions(null);
    setActions(await api.listBrowserActions(workspaceId, s.id).catch(() => []));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col space-y-4 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Browser Operator — Trace</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
        <p className="text-xs text-slate-500">
          Durable, workspace-isolated record of agent browser actions. URLs are sanitized (no query secrets);
          cookies/tokens are never stored. Write/payment actions require approval.
        </p>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <ul className="space-y-2">
          {items?.map((s) => (
            <li key={s.id} className="rounded-md border border-slate-700 p-2 text-sm">
              <button onClick={() => toggle(s)} className="flex w-full items-center justify-between gap-2 text-left">
                <span className="flex items-center gap-2">
                  <span className={STATUS_COLOR[s.status] ?? 'text-slate-400'}>●</span>
                  <span className="font-medium">{s.lastAction ?? 'session'}</span>
                  <span className="truncate text-xs text-slate-500">{s.lastUrl ?? ''}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-500">
                  {s.actionCount} act · {s.approvalCount} appr · {s.deniedCount} denied{s.takeover ? ' · takeover' : ''}
                </span>
              </button>
              {open === s.id && (
                <ul className="mt-2 space-y-1 border-t border-slate-800 pt-2">
                  {actions?.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 ${RISK_COLOR[a.risk] ?? RISK_COLOR.low}`}>{a.risk}</span>
                        <span className="font-medium">{a.action}</span>
                        <span className="truncate text-slate-500">{a.url ?? a.target ?? ''}</span>
                      </span>
                      <span className={OUTCOME_COLOR[a.outcome] ?? 'text-slate-400'}>{a.outcome}</span>
                    </li>
                  ))}
                  {actions?.length === 0 && <li className="text-xs text-slate-500">No actions recorded.</li>}
                </ul>
              )}
            </li>
          ))}
          {items?.length === 0 && <li className="text-sm text-slate-500">No browser sessions yet.</li>}
        </ul>
      </div>
    </div>
  );
}
