'use client';

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type SyncSnapshot,
  type TaskEventRow,
  type ProjectMemoryEntry,
  type BrowserSessionRow,
  type BrowserActionRow,
  type Workflow,
  type WorkflowRunRow,
} from '../../lib/api';

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-slate-500',
  planning: 'bg-sky-400',
  running: 'bg-sky-400',
  awaiting_approval: 'bg-amber-400',
  paused: 'bg-amber-400',
  verifying: 'bg-violet-400',
  completed: 'bg-emerald-400',
  failed: 'bg-rose-500',
  stopped: 'bg-slate-500',
};

export function StatusDot({ status }: { status: string }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[status] ?? 'bg-slate-500'}`} />;
}

export function Empty({ label }: { label: string }) {
  return <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">{label}</p>;
}

function BackBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <button onClick={onBack} className="text-sm text-emerald-400">‹ Back</button>
      <h2 className="truncate text-sm font-semibold">{title}</h2>
    </div>
  );
}

/** Task detail + timeline. SECURITY: renders only event TYPE + time — never the raw payload (prompts,
 * tool args, outputs), so nothing sensitive reaches the small screen. */
export function MobileTaskDetail({ workspaceId, taskId, onBack }: { workspaceId: string; taskId: string; onBack: () => void }) {
  const [title, setTitle] = useState('Task');
  const [status, setStatus] = useState('');
  const [events, setEvents] = useState<TaskEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const t = await api.getTask(workspaceId, taskId);
        setTitle(t.title || 'Task');
        setStatus(t.status);
        setEvents(await api.taskEvents(workspaceId, taskId));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Failed to load task');
      }
    })();
  }, [workspaceId, taskId]);

  return (
    <div>
      <BackBar title={title} onBack={onBack} />
      <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
        <StatusDot status={status} /> {status}
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      {events === null ? (
        <p className="text-sm text-slate-500">Loading timeline…</p>
      ) : events.length === 0 ? (
        <Empty label="No timeline events yet." />
      ) : (
        <ol className="space-y-1.5 border-l border-slate-800 pl-3">
          {events.map((e) => (
            <li key={e.seq} className="text-xs">
              <span className="text-slate-300">{e.type}</span>
              <span className="ml-2 text-slate-600">{new Date(e.createdAt).toLocaleTimeString()}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Approval queue + approve/deny (elevated requires the typed confirmation). */
export function MobileApprovals({ workspaceId, snap, onChanged }: { workspaceId: string; snap: SyncSnapshot | null; onChanged: () => void }) {
  const approvals = snap?.approvals ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function decide(a: SyncSnapshot['approvals'][number], decision: 'approve' | 'deny') {
    setBusy(a.approvalId);
    setError(null);
    try {
      await api.decideApproval(workspaceId, a.taskId, a.approvalId, decision, a.elevated ? confirm[a.approvalId] : undefined);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to decide');
    } finally {
      setBusy(null);
    }
  }

  if (approvals.length === 0) return <Empty label="No pending approvals." />;
  return (
    <ul className="space-y-2">
      {error && <li className="text-sm text-rose-400">{error}</li>}
      {approvals.map((a) => (
        <li key={a.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{a.action}</span>
            <span className={`shrink-0 text-xs ${a.risk === 'critical' ? 'text-rose-400' : a.risk === 'high' ? 'text-orange-400' : 'text-amber-400'}`}>
              {a.risk}{a.elevated ? ' · elevated' : ''}
            </span>
          </div>
          {a.elevated && (
            <input
              value={confirm[a.approvalId] ?? ''}
              onChange={(e) => setConfirm((c) => ({ ...c, [a.approvalId]: e.target.value }))}
              placeholder="Type CONFIRM-ELEVATED"
              className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
            />
          )}
          <div className="mt-2 flex gap-2">
            <button disabled={busy === a.approvalId} onClick={() => decide(a, 'approve')} className="flex-1 rounded bg-emerald-600 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              Approve
            </button>
            <button disabled={busy === a.approvalId} onClick={() => decide(a, 'deny')} className="flex-1 rounded bg-rose-600 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              Deny
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Automation run history (from the consolidated snapshot). */
export function MobileAutomations({ snap }: { workspaceId: string; snap: SyncSnapshot | null }) {
  const runs = snap?.automationRuns ?? [];
  if (runs.length === 0) return <Empty label="No automation runs yet." />;
  return (
    <ul className="space-y-2">
      {runs.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            <StatusDot status={r.status} />
            <span className="text-xs text-slate-400">{r.triggeredBy}</span>
          </span>
          <span className="text-xs text-slate-500">{r.status}{r.finishedAt ? ` · ${new Date(r.finishedAt).toLocaleTimeString()}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/** Project Memory — read-only on mobile (create/edit stays on desktop). */
export function MobileMemoryView({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const [items, setItems] = useState<ProjectMemoryEntry[] | null>(null);
  useEffect(() => {
    api.listMemory(workspaceId).then(setItems).catch(() => setItems([]));
  }, [workspaceId]);
  return (
    <div>
      <BackBar title="Project Memory" onBack={onBack} />
      {items === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <Empty label="No memory entries." />
      ) : (
        <ul className="space-y-2">
          {items.map((m) => (
            <li key={m.id} className="rounded-lg border border-slate-800 bg-slate-900 p-2 text-sm">
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{m.kind}</span>
              <p className="mt-1 whitespace-pre-wrap text-slate-200">{m.content}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Browser Operator trace — read-only on mobile. */
export function MobileBrowserTrace({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const [sessions, setSessions] = useState<BrowserSessionRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [actions, setActions] = useState<BrowserActionRow[] | null>(null);
  useEffect(() => {
    api.listBrowserSessions(workspaceId).then(setSessions).catch(() => setSessions([]));
  }, [workspaceId]);
  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    setActions(await api.listBrowserActions(workspaceId, id).catch(() => []));
  }
  return (
    <div>
      <BackBar title="Browser Trace" onBack={onBack} />
      {sessions === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : sessions.length === 0 ? (
        <Empty label="No browser sessions." />
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li key={s.id} className="rounded-lg border border-slate-800 bg-slate-900 p-2 text-sm">
              <button onClick={() => toggle(s.id)} className="flex w-full items-center justify-between gap-2 text-left">
                <span className="truncate text-xs">{s.lastAction ?? 'session'} · {s.lastUrl ?? ''}</span>
                <span className="shrink-0 text-xs text-slate-500">{s.actionCount} act</span>
              </button>
              {open === s.id && actions && (
                <ul className="mt-1 space-y-0.5 border-t border-slate-800 pt-1 text-[11px] text-slate-400">
                  {actions.map((a) => (
                    <li key={a.id} className="flex justify-between gap-2">
                      <span className="truncate">{a.action} {a.url ?? ''}</span>
                      <span className="shrink-0">{a.outcome}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Workflows (TICKET-8): real multi-step workflow + run view. Lists workflows; expands to show run
 * history + per-step progress; an awaiting-approval run can be approved/denied from mobile. */
export function MobileWorkflows({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listWorkflows(workspaceId).then(setItems).catch(() => setItems([]));
  }, [workspaceId]);

  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    setRuns(null);
    setRuns(await api.listWorkflowRuns(workspaceId, id).catch(() => []));
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
    <div>
      <BackBar title="Workflows" onBack={onBack} />
      {items === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <Empty label="No workflows yet. Create one on desktop." />
      ) : (
        <ul className="space-y-2">
          {items.map((w) => (
            <li key={w.id} className="rounded-lg border border-slate-800 bg-slate-900 p-2 text-sm">
              <button onClick={() => toggle(w.id)} className="flex w-full items-center justify-between gap-2 text-left">
                <span className="truncate font-medium">{w.name}</span>
                <span className="shrink-0 text-xs text-slate-500">{w.enabled ? 'enabled' : 'paused'}</span>
              </button>
              {open === w.id && (
                <ul className="mt-2 space-y-1 border-t border-slate-800 pt-2">
                  {runs?.map((r) => (
                    <li key={r.id} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2"><StatusDot status={r.status} /> {r.status} · {r.triggeredBy}</span>
                        <span className="text-slate-600">{r.stepStates.length} steps</span>
                      </div>
                      {r.status === 'awaiting_approval' && (
                        <div className="mt-1 flex gap-2">
                          <button disabled={busy} onClick={() => decide(r.id, 'approve', w.id)} className="flex-1 rounded bg-emerald-600 py-1 text-white disabled:opacity-50">Approve</button>
                          <button disabled={busy} onClick={() => decide(r.id, 'deny', w.id)} className="flex-1 rounded bg-rose-600 py-1 text-white disabled:opacity-50">Deny</button>
                        </div>
                      )}
                    </li>
                  ))}
                  {runs?.length === 0 && <li className="text-xs text-slate-500">No runs yet.</li>}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
