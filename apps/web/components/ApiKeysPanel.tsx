'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type ApiKeyInfo } from '../lib/api';

/** Manage programmatic API keys. The plaintext token is shown once, on creation. */
export function ApiKeysPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listApiKeys(workspaceId).then(setKeys).catch((e) =>
      setError(e instanceof ApiError ? e.message : 'Failed to load keys'),
    );
  }
  useEffect(refresh, [workspaceId]);

  async function create() {
    setBusy(true);
    setError(null);
    setFresh(null);
    try {
      const res = await api.createApiKey(workspaceId, label.trim() || undefined);
      setFresh(res.token);
      setLabel('');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create key');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKeyInfo) {
    setError(null);
    try {
      await api.revokeApiKey(workspaceId, k.id);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not revoke key');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">API keys</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-400">
          Use a key with <code className="text-emerald-300">Authorization: Bearer …</code> against{' '}
          <code className="text-emerald-300">/v1/tasks</code>.
        </p>

        <div className="mb-3 flex gap-2">
          <input
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
            placeholder="Label (optional, e.g. CI)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            onClick={create}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
        {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}
        {fresh && (
          <div className="mb-4 rounded-lg border border-amber-800 bg-amber-950/30 p-3">
            <p className="mb-1 text-xs text-amber-300">Copy this token now — it won't be shown again:</p>
            <code className="block select-all break-all rounded bg-slate-950 px-2 py-1 text-xs text-emerald-300">
              {fresh}
            </code>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {keys === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : keys.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              No keys yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {keys.map((k) => (
                <li
                  key={k.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-200">
                      {k.label ?? 'key'} <span className="font-mono text-xs text-slate-500">··{k.publicId.slice(-6)}</span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {k.revokedAt ? 'revoked' : k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : 'never used'}
                    </div>
                  </div>
                  {!k.revokedAt && (
                    <button onClick={() => revoke(k)} className="shrink-0 text-xs text-rose-400 hover:text-rose-300">
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
