'use client';

import { useEffect, useState } from 'react';
import { CAPABILITY_META, TASK_CAPABILITIES, type TaskCapability } from '@agentos/protocol';
import { api, ApiError, type Playbook } from '../lib/api';
import { extractVariables, substituteVariables } from '../lib/playbook-vars';

/**
 * Playbooks (Manus-style reusable task templates): save a prompt + optional capability/effort once,
 * then re-run it on demand. Running creates a fresh task from the template and closes the panel.
 */
export function PlaybooksPanel({
  workspaceId,
  onClose,
  onRan,
}: {
  workspaceId: string;
  onClose: () => void;
  onRan: () => void;
}) {
  const [playbooks, setPlaybooks] = useState<Playbook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // save (create form)
  const [runningId, setRunningId] = useState<string | null>(null); // the playbook currently launching
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [capability, setCapability] = useState<TaskCapability>('general');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('high');
  // When a playbook prompt has {{variables}}, collect their values before running.
  const [fill, setFill] = useState<{ p: Playbook; vars: string[]; values: Record<string, string> } | null>(null);

  function refresh() {
    api.listPlaybooks(workspaceId).then(setPlaybooks).catch(() => setPlaybooks([]));
  }
  useEffect(refresh, [workspaceId]);

  async function save() {
    if (name.trim().length < 1 || prompt.trim().length < 1) return;
    setBusy(true);
    setError(null);
    try {
      await api.createPlaybook(workspaceId, {
        name: name.trim(),
        prompt: prompt.trim(),
        ...(capability !== 'general' ? { capability } : {}),
        ...(effort !== 'high' ? { effort } : {}),
      });
      setName('');
      setPrompt('');
      setCapability('general');
      setEffort('high');
      setCreating(false);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the playbook');
    } finally {
      setBusy(false);
    }
  }

  // A parameterized playbook ({{var}}) opens the fill form first; a plain one runs immediately.
  function run(p: Playbook) {
    const vars = extractVariables(p.prompt);
    if (vars.length > 0) {
      setError(null);
      setFill({ p, vars, values: {} });
      return;
    }
    void doRun(p, p.prompt);
  }

  async function doRun(p: Playbook, finalPrompt: string) {
    setRunningId(p.id);
    setError(null);
    try {
      const title = finalPrompt.length > 60 ? `${finalPrompt.slice(0, 57)}…` : finalPrompt;
      await api.createTask(workspaceId, {
        title,
        prompt: finalPrompt,
        ...(p.capability ? { capability: p.capability } : {}),
        ...(p.effort ? { effort: p.effort as 'low' | 'medium' | 'high' | 'max' } : {}),
      });
      setFill(null);
      onRan();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not run the playbook');
      setRunningId(null);
    }
  }

  async function remove(p: Playbook) {
    try {
      await api.deletePlaybook(workspaceId, p.id);
      refresh();
    } catch (e) {
      // Surface a failed delete instead of silently refreshing back to the prior state.
      setError(e instanceof ApiError ? e.message : 'Could not delete the playbook');
    }
  }

  const field =
    'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Playbooks</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-400">Reusable task templates — save a prompt once, run it any time.</p>

        {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

        {fill && (
          <div className="mb-4 flex flex-col gap-2 rounded-xl border border-emerald-800 bg-emerald-950/20 p-3">
            <p className="text-sm font-medium text-slate-200">
              Fill in “{fill.p.name}”
            </p>
            {fill.vars.map((v) => (
              <label key={v} className="flex flex-col gap-1 text-xs text-slate-400">
                <span className="font-mono text-emerald-300">{`{{${v}}}`}</span>
                <input
                  className={field}
                  value={fill.values[v] ?? ''}
                  onChange={(e) => setFill((f) => (f ? { ...f, values: { ...f.values, [v]: e.target.value } } : f))}
                  placeholder={`Value for ${v}`}
                />
              </label>
            ))}
            <div className="flex justify-end gap-2">
              <button onClick={() => setFill(null)} className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200">
                Cancel
              </button>
              <button
                onClick={() => doRun(fill.p, substituteVariables(fill.p.prompt, fill.values))}
                disabled={runningId !== null || fill.vars.some((v) => !(fill.values[v] ?? '').trim())}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {runningId === fill.p.id ? 'Running…' : 'Run'}
              </button>
            </div>
          </div>
        )}

        {playbooks === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : playbooks.length === 0 ? (
          <p className="mb-4 rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
            No playbooks yet. Create one below.
          </p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {playbooks.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-200">{p.name}</span>
                    {p.capability && (
                      <span className="rounded-full border border-indigo-700 bg-indigo-600/20 px-1.5 py-0.5 text-[10px] capitalize text-indigo-300">
                        {p.capability}
                      </span>
                    )}
                    {extractVariables(p.prompt).length > 0 && (
                      <span className="rounded-full border border-amber-700 bg-amber-600/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                        {extractVariables(p.prompt).length} fill-in
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-slate-500">{p.prompt}</p>
                </div>
                <button
                  onClick={() => run(p)}
                  disabled={runningId !== null}
                  className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {runningId === p.id ? 'Running…' : 'Run'}
                </button>
                <button onClick={() => remove(p)} className="shrink-0 text-xs text-slate-500 hover:text-rose-400">
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {creating ? (
          <div className="flex flex-col gap-2 rounded-xl border border-slate-800 p-3">
            <input className={field} placeholder="Playbook name" value={name} onChange={(e) => setName(e.target.value)} />
            <textarea className={`${field} resize-none`} rows={3} placeholder="Prompt template… use {{variable}} for values you fill in at run time" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="flex gap-2">
              <select value={capability} onChange={(e) => setCapability(e.target.value as TaskCapability)} className={field}>
                {TASK_CAPABILITIES.map((id) => (
                  <option key={id} value={id}>
                    {CAPABILITY_META[id].label}
                  </option>
                ))}
              </select>
              <select value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)} className={field}>
                <option value="low">Effort: Low</option>
                <option value="medium">Effort: Medium</option>
                <option value="high">Effort: High</option>
                <option value="max">Effort: Max</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200">
                Cancel
              </button>
              <button onClick={save} disabled={busy || !name.trim() || !prompt.trim()} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? 'Saving…' : 'Save playbook'}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-400 hover:text-slate-200">
            + New playbook
          </button>
        )}
      </div>
    </div>
  );
}
