'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type LocalFolder } from '../lib/api';

/**
 * "My Computer" (Manus-style): approve host folders the agent may work in. Reads are allowed in any
 * approved folder; writes only in folders marked Writable (and every write is approval-gated). Only
 * active when the server runs with ENABLE_LOCAL_FS (a local/desktop deployment).
 */
export function MyComputerPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<LocalFolder[]>([]);
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  function refresh() {
    setLoadFailed(false);
    api
      .getLocalFolders(workspaceId)
      .then((r) => {
        setEnabled(r.enabled);
        setFolders(r.folders);
      })
      // A fetch failure is NOT the same as "feature disabled" — don't tell the user to change server
      // config when the real problem is a dropped request.
      .catch(() => setLoadFailed(true));
  }
  useEffect(refresh, [workspaceId]);

  async function add() {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addLocalFolder(workspaceId, {
        label: label.trim() || path.trim(),
        path: path.trim(),
        writable,
      });
      setLabel('');
      setPath('');
      setWritable(false);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the folder');
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: LocalFolder) {
    try {
      await api.deleteLocalFolder(workspaceId, f.id);
      refresh();
    } catch (e) {
      // Surface a failed remove instead of silently refreshing the folder back into the list.
      setError(e instanceof ApiError ? e.message : 'Could not remove the folder');
    }
  }

  const field =
    'rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">My Computer</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-400">
          Approve folders on this computer the agent may work in. Reads are allowed; writes need the
          Writable flag and are always approval-gated.
        </p>

        {enabled === null && !loadFailed && <p className="mb-4 text-sm text-slate-500">Loading…</p>}
        {loadFailed && (
          <p className="mb-4 rounded-xl border border-rose-800 bg-rose-950/30 p-3 text-sm text-rose-300">
            Couldn’t load — <button onClick={refresh} className="underline">retry</button>.
          </p>
        )}
        {enabled === false && (
          <p className="mb-4 rounded-xl border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300">
            Local folder access is disabled on this server. Start the API with <code>ENABLE_LOCAL_FS=true</code>{' '}
            (a local/desktop deployment) to use My Computer.
          </p>
        )}
        {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

        {folders.length > 0 && (
          <ul className="mb-4 flex flex-col gap-2">
            {folders.map((f) => (
              <li key={f.id} className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-200">{f.label}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${f.writable ? 'bg-amber-600/20 text-amber-300' : 'bg-slate-700/40 text-slate-400'}`}>
                      {f.writable ? 'read + write' : 'read-only'}
                    </span>
                  </div>
                  <p className="truncate font-mono text-xs text-slate-500">{f.path}</p>
                </div>
                <button onClick={() => remove(f)} className="shrink-0 text-xs text-slate-500 hover:text-rose-400">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {enabled && (
          <div className="flex flex-col gap-2 rounded-xl border border-slate-800 p-3">
            <input className={field} placeholder="Label (e.g. Project)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input className={`${field} font-mono`} placeholder="Absolute path (e.g. C:\\Users\\me\\project)" value={path} onChange={(e) => setPath(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-slate-400">
              <input type="checkbox" checked={writable} onChange={(e) => setWritable(e.target.checked)} />
              Allow the agent to WRITE in this folder (writes still ask for approval)
            </label>
            <div className="flex justify-end">
              <button onClick={add} disabled={busy || !path.trim()} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? 'Adding…' : 'Approve folder'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
