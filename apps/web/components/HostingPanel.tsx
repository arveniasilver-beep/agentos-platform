'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

type Backend = 'netlify' | 'selfhosted';

/**
 * Hosting settings: pick a backend and store its deploy token so the agent's `publish_site` tool can
 * deploy a generated website to a public URL.
 *   - Netlify: third-party, just a personal access token.
 *   - My server (self-hosted): AgentOS's own server on your VPS — token + the server's URL.
 */
export function HostingPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [status, setStatus] = useState<{ configured: boolean; lastFour: string | null } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [backend, setBackend] = useState<Backend>('netlify');
  const [token, setToken] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    setLoadFailed(false);
    api
      .getHosting(workspaceId)
      .then(setStatus)
      .catch(() => setLoadFailed(true));
  }
  useEffect(refresh, [workspaceId]);

  async function save() {
    if (token.trim().length < 10) return;
    if (backend === 'selfhosted' && !endpoint.trim()) {
      setError('Enter your server URL (e.g. http://203.0.113.10)');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setHosting(workspaceId, {
        token: token.trim(),
        backend,
        ...(backend === 'selfhosted' ? { endpoint: endpoint.trim() } : {}),
      });
      setToken('');
      setEndpoint('');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the token');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    try {
      await api.clearHosting(workspaceId);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the token');
    }
  }

  const field =
    'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Hosting</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-400">
          Add a deploy target and the agent can publish a website it builds to a public URL with the{' '}
          <code>publish_site</code> tool (it asks for approval before publishing).
        </p>

        {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

        {status === null && !loadFailed ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : loadFailed ? (
          <p className="rounded-xl border border-rose-800 bg-rose-950/30 p-3 text-sm text-rose-300">
            Couldn’t load — <button onClick={refresh} className="underline">retry</button>.
          </p>
        ) : status?.configured ? (
          <div className="flex items-center justify-between rounded-xl border border-emerald-800 bg-emerald-950/20 p-3">
            <span className="text-sm text-slate-300">Connected — token ••••{status.lastFour ?? '----'}</span>
            <button onClick={clear} className="text-xs text-slate-500 hover:text-rose-400">
              Remove
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-slate-800 p-3">
            <div className="flex gap-2">
              {(['netlify', 'selfhosted'] as Backend[]).map((b) => (
                <button
                  key={b}
                  onClick={() => setBackend(b)}
                  className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${backend === b ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  {b === 'netlify' ? 'Netlify' : 'My server (VPS)'}
                </button>
              ))}
            </div>
            {backend === 'selfhosted' && (
              <input
                className={`${field} font-mono`}
                placeholder="Server URL — e.g. http://203.0.113.10"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            )}
            <input
              className={field}
              type="password"
              placeholder={backend === 'netlify' ? 'Netlify personal access token' : 'Deploy token (from the server setup)'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <div className="flex justify-end">
              <button
                onClick={save}
                disabled={busy || token.trim().length < 10}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {backend === 'netlify' ? (
              <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-500">
                <li>Create a free account at app.netlify.com.</li>
                <li>User settings → Applications → Personal access tokens → New access token.</li>
                <li>Paste it above → sites publish to a <code>*.netlify.app</code> URL.</li>
              </ol>
            ) : (
              <p className="text-xs text-slate-500">
                Use the server URL + deploy token printed when you set up the hosting server on your VPS.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
