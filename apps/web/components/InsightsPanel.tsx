'use client';

import { useEffect, useState } from 'react';
import { api, type AuditEntry, type UsageSummary } from '../lib/api';

/** Cost/token metering + tamper-evident audit trail for the workspace. */
export function InsightsPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [audit, setAudit] = useState<{ entries: AuditEntry[]; chainValid: boolean } | null>(null);
  const [auditDenied, setAuditDenied] = useState(false);

  useEffect(() => {
    api.getUsage(workspaceId).then(setUsage).catch(() => setUsage(null));
    api
      .getAudit(workspaceId)
      .then(setAudit)
      .catch(() => setAuditDenied(true));
  }, [workspaceId]);

  const t = usage?.totals;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Insights</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <div className="mb-5 grid grid-cols-3 gap-3">
          <Stat label="Total cost" value={t ? `$${t.costUsd.toFixed(4)}` : '—'} />
          <Stat label="Tasks" value={t ? String(t.taskCount) : '—'} />
          <Stat
            label="Tokens (in / out)"
            value={t ? `${fmt(t.inputTokens)} / ${fmt(t.outputTokens)}` : '—'}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent tasks</h3>
          {usage && usage.recentTasks.length > 0 ? (
            <table className="mb-6 w-full text-sm">
              <tbody>
                {usage.recentTasks.map((task) => (
                  <tr key={task.id} className="border-b border-slate-800/60">
                    <td className="truncate py-1.5 pr-2 text-slate-200">{task.title}</td>
                    <td className="py-1.5 pr-2 text-xs text-slate-500">{task.status}</td>
                    <td className="py-1.5 text-right font-mono text-xs text-emerald-400">
                      ${task.costUsd.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mb-6 text-sm text-slate-500">No tasks yet.</p>
          )}

          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Audit log</h3>
            {audit && (
              <span
                className={`text-xs ${audit.chainValid ? 'text-emerald-400' : 'text-rose-400'}`}
                title="Hash-chained tamper-evidence"
              >
                {audit.chainValid ? '● chain valid' : '● chain BROKEN'}
              </span>
            )}
          </div>
          {auditDenied ? (
            <p className="text-sm text-slate-500">Audit log requires an admin role.</p>
          ) : audit && audit.entries.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {[...audit.entries].reverse().slice(0, 30).map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 text-slate-300">
                  <span className="font-mono text-xs text-slate-400">{e.action}</span>
                  <span className="text-xs text-slate-600">{new Date(e.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No audit entries.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
