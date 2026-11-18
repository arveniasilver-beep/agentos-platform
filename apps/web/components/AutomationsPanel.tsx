'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Automation, type AutomationRun } from '../lib/api';

const RUN_STATUS_COLOR: Record<AutomationRun['status'], string> = {
  pending: 'text-slate-400',
  running: 'text-sky-400',
  awaiting_approval: 'text-amber-400',
  completed: 'text-emerald-400',
  failed: 'text-rose-400',
  skipped: 'text-slate-500',
};

/** Manage a workspace's scheduled automations (cron-driven self-running tasks). */
export function AutomationsPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [items, setItems] = useState<Automation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [busy, setBusy] = useState(false);
  // Durable AutomationRun history (TICKET-AUTOMATION): which automation's runs are expanded + the rows.
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);

  async function showRuns(a: Automation) {
    if (openRuns === a.id) {
      setOpenRuns(null);
      return;
    }
    setOpenRuns(a.id);
    setRuns(null);
    setRuns(await api.listAutomationRuns(workspaceId, a.id).catch(() => []));
  }

  function refresh() {
    api.listAutomations(workspaceId).then(setItems).catch((e) =>
      setError(e instanceof ApiError ? e.message : 'Failed to load automations'),
    );
  }
  useEffect(refresh, [workspaceId]);

  // Live run-status poll: while a run list is open, refresh it every 3s so a fire's pending -> running ->
  // completed transition appears without a manual re-open. Keyed on openRuns (NOT showRuns, which toggles),
  // so it re-arms when switching automations and is cleared on close/unmount.
  useEffect(() => {
    if (!openRuns) return;
    const id = setInterval(() => {
      api.listAutomationRuns(workspaceId, openRuns).then(setRuns).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [openRuns, workspaceId]);

  async function create() {
    if (!name.trim() || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAutomation(workspaceId, { name: name.trim(), prompt: prompt.trim(), cronExpression: cron.trim() });
      setName('');
      setPrompt('');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create automation');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(a: Automation) {
    await api.setAutomationEnabled(workspaceId, a.id, !a.enabled).catch(() => undefined);
    refresh();
  }
  async function run(a: Automation) {
    await api.runAutomation(workspaceId, a.id).catch(() => undefined);
    refresh();
  }
  async function remove(a: Automation) {
    await api.deleteAutomation(workspaceId, a.id).catch(() => undefined);
    refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Automations</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <div className="mb-5 rounded-xl border border-slate-800 bg-slate-950 p-4">
          <div className="grid grid-cols-2 gap-2">
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
              placeholder="Name (e.g. Daily digest)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-emerald-500"
              placeholder="Cron: 0 9 * * *"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
          </div>
          <textarea
            className="mt-2 w-full resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
            rows={2}
            placeholder="Prompt to run on schedule…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-500">min hour day month weekday</span>
            <button
              onClick={create}
              disabled={busy || !name.trim() || !prompt.trim()}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add automation'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {items === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              No automations yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((a) => (
                <li key={a.id} className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-200">{a.name}</span>
                        <span className="font-mono text-xs text-slate-500">{a.cronExpression}</span>
                        {!a.enabled && <span className="text-xs text-slate-600">(paused)</span>}
                      </div>
                      <p className="truncate text-xs text-slate-500">{a.prompt}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs">
                      <button onClick={() => run(a)} className="text-emerald-400 hover:text-emerald-300">
                        Run
                      </button>
                      <button onClick={() => showRuns(a)} className="text-slate-400 hover:text-slate-200">
                        {openRuns === a.id ? 'Hide runs' : 'Runs'}
                      </button>
                      <button onClick={() => toggle(a)} className="text-slate-400 hover:text-slate-200">
                        {a.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button onClick={() => remove(a)} className="text-rose-400 hover:text-rose-300">
                        Delete
                      </button>
                    </div>
                  </div>
                  {openRuns === a.id && (
                    <div className="mt-2 border-t border-slate-800 pt-2">
                      {runs === null ? (
                        <p className="text-xs text-slate-500">Loading runs…</p>
                      ) : runs.length === 0 ? (
                        <p className="text-xs text-slate-600">No runs yet (run history requires AUTOMATION_RUNS_ENABLED).</p>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {runs.map((r) => (
                            <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                              <span className="flex items-center gap-2">
                                <span className={RUN_STATUS_COLOR[r.status]}>{r.status}</span>
                                <span className="text-slate-600">{r.triggeredBy}{r.attempt > 0 ? ` ·retry#${r.attempt}` : ''}</span>
                                {(r.skipReason || r.failureReason) && (
                                  <span className="truncate text-slate-600">— {r.skipReason || r.failureReason}</span>
                                )}
                              </span>
                              <span className="flex shrink-0 items-center gap-2 text-slate-600">
                                <span>{new Date(r.createdAt).toLocaleString()}</span>
                                {r.taskId && (
                                  <a href={`/tasks/${r.taskId}`} className="text-sky-400 hover:text-sky-300">task →</a>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
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
