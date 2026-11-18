'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Workflow, type WorkflowRunRow } from '../lib/api';

const SAMPLE = JSON.stringify(
  {
    start: 'summarize',
    trigger: { type: 'manual' },
    steps: [
      { id: 'summarize', type: 'task', prompt: "Summarize today's activity.", onSuccess: 'review', onFailure: 'fail' },
      { id: 'review', type: 'approval', name: 'Human review', onSuccess: 'end', onFailure: 'fail' },
    ],
  },
  null,
  2,
);

const STATUS_COLOR: Record<string, string> = { running: 'text-sky-400', awaiting_approval: 'text-amber-400', completed: 'text-emerald-400', failed: 'text-rose-400', pending: 'text-slate-400', skipped: 'text-slate-500' };

/** Workflow Builder (TICKET-8): define multi-step workflows (JSON DSL), run them, watch run history +
 * per-step progress, and approve/deny a halted approval step. */
export function WorkflowsPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [defText, setDefText] = useState(SAMPLE);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listWorkflows(workspaceId).then(setItems).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load workflows'));
  }
  useEffect(refresh, [workspaceId]);

  async function showRuns(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    setRuns(null);
    setRuns(await api.listWorkflowRuns(workspaceId, id).catch(() => []));
  }

  async function create() {
    setError(null);
    setNotice(null);
    let definition: unknown;
    try {
      definition = JSON.parse(defText);
    } catch {
      return setError('Definition is not valid JSON.');
    }
    setBusy(true);
    try {
      const res = await api.createWorkflow(workspaceId, { name: name.trim() || 'Workflow', definition });
      setName('');
      if (res.webhookToken) setNotice(`Webhook secret (shown once): ${res.webhookToken}`);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create workflow');
    } finally {
      setBusy(false);
    }
  }

  async function decide(runId: string, decision: 'approve' | 'deny', workflowId: string) {
    setBusy(true);
    try {
      await api.decideWorkflowApproval(workspaceId, runId, decision);
      setRuns(await api.listWorkflowRuns(workspaceId, workflowId).catch(() => []));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col space-y-4 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Workflows</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
        <p className="text-xs text-slate-500">Multi-step workflows: task / condition / approval steps with branching. Triggers: manual, schedule (cron), or webhook (a secret is issued once).</p>

        <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Workflow name" className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm" />
          <textarea value={defText} onChange={(e) => setDefText(e.target.value)} rows={8} spellCheck={false} className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs" />
          <button onClick={create} disabled={busy} className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Create workflow'}</button>
          {error && <p className="text-sm text-rose-400">{error}</p>}
          {notice && <p className="break-all text-xs text-amber-400">{notice}</p>}
        </div>

        <ul className="space-y-2">
          {items?.map((w) => (
            <li key={w.id} className="rounded-lg border border-slate-800 bg-slate-950 p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{w.name} <span className="text-xs text-slate-500">v{w.version}{w.cronExpression ? ` · ${w.cronExpression}` : ''}</span></span>
                <span className="flex shrink-0 gap-2 text-xs">
                  <button onClick={() => api.runWorkflow(workspaceId, w.id).then(() => showRuns(w.id))} className="text-emerald-400">Run</button>
                  <button onClick={() => showRuns(w.id)} className="text-slate-400">Runs</button>
                  <button onClick={() => api.deleteWorkflow(workspaceId, w.id).then(refresh)} className="text-rose-400">Delete</button>
                </span>
              </div>
              {open === w.id && (
                <ul className="mt-2 space-y-1 border-t border-slate-800 pt-2 text-xs">
                  {runs?.map((r) => (
                    <li key={r.id}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={STATUS_COLOR[r.status] ?? 'text-slate-400'}>{r.status} · {r.triggeredBy} · {r.stepStates.length} steps</span>
                        {r.status === 'awaiting_approval' && (
                          <span className="flex gap-1">
                            <button disabled={busy} onClick={() => decide(r.id, 'approve', w.id)} className="rounded bg-emerald-600 px-2 text-white">Approve</button>
                            <button disabled={busy} onClick={() => decide(r.id, 'deny', w.id)} className="rounded bg-rose-600 px-2 text-white">Deny</button>
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                  {runs?.length === 0 && <li className="text-slate-500">No runs yet.</li>}
                </ul>
              )}
            </li>
          ))}
          {items?.length === 0 && <li className="text-sm text-slate-500">No workflows yet.</li>}
        </ul>
      </div>
    </div>
  );
}
