'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type InboundConfig } from '../lib/api';
import { API_BASE } from '../lib/config';

/**
 * Mail-to-task settings: shows the workspace's inbound webhook URL (point an email service at it),
 * lets an admin enable/disable, restrict to allowed senders, and rotate the token.
 */
export function InboundEmailPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [cfg, setCfg] = useState<InboundConfig | null>(null);
  const [senders, setSenders] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .getInbound(workspaceId)
      .then((c) => {
        setCfg(c);
        setSenders(c.allowedSenders.join(', '));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load'));
  }, [workspaceId]);

  const webhookUrl = cfg ? `${API_BASE}/inbound-email/${cfg.token}` : '';

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const allowedSenders = senders
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const c = await api.updateInbound(workspaceId, {
        enabled: cfg.enabled,
        allowedSenders,
        taskRiskCeiling: cfg.taskRiskCeiling,
      });
      setCfg(c);
      setSenders(c.allowedSenders.join(', '));
      setNotice('Saved.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!window.confirm('Rotate the token? The current webhook URL stops working.')) return;
    const c = await api.regenerateInbound(workspaceId).catch(() => null);
    if (c) {
      setCfg(c);
      setNotice('Token rotated — update your email service.');
    }
  }

  const field =
    'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="mt-10 w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Mail to task</h2>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Point an inbound-email service (Postmark / SendGrid / Mailgun …) at the webhook below; each
          email it forwards becomes a task. The webhook URL’s token is the real secret — keep it
          private and rotate it if leaked. The allowed-senders list is a convenience filter only (the
          From header can be spoofed), and email tasks run at a low risk ceiling by default.
        </p>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-900 bg-rose-950/30 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-sm text-emerald-300">
            {notice}
          </div>
        )}

        {!cfg ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-1 text-xs text-slate-400">Webhook URL (POST parsed email here)</p>
              <div className="flex items-center gap-2">
                <input readOnly value={webhookUrl} className={`font-mono text-xs ${field}`} />
                <button
                  onClick={() => navigator.clipboard?.writeText(webhookUrl)}
                  className="shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Copy
                </button>
                <button onClick={regenerate} className="shrink-0 text-xs text-slate-500 hover:text-rose-400">
                  Rotate
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={cfg.enabled}
                onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
              />
              Enabled
            </label>

            <label className="text-xs text-slate-400">
              Allowed senders — convenience filter (comma-separated; empty = accept any — not recommended)
              <textarea
                className={`mt-1 resize-none ${field}`}
                rows={2}
                value={senders}
                onChange={(e) => setSenders(e.target.value)}
                placeholder="you@company.com, teammate@company.com"
              />
            </label>

            <label className="text-xs text-slate-400">
              Risk ceiling for email tasks
              <select
                className={`mt-1 ${field}`}
                value={cfg.taskRiskCeiling}
                onChange={(e) =>
                  setCfg({ ...cfg, taskRiskCeiling: e.target.value as InboundConfig['taskRiskCeiling'] })
                }
              >
                <option value="low">Low (safest — risky tools need approval)</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical (only critical tools pause)</option>
              </select>
            </label>

            <div className="flex justify-end">
              <button
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
