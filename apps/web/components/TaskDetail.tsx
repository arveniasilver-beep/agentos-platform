'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '@agentos/protocol';
import { api, type Artifact, type ArtifactMeta, type Task, type TaskSubtask, type TaskMessage } from '../lib/api';
import { FOLLOWUP_TURNS_ENABLED } from '../lib/config';
import { FileDiff, asFsWriteOutput } from './FileDiff';
import { openTaskStream, type TaskStream } from '../lib/stream';
import {
  emptyTaskView,
  applyEvent,
  resolveApproval,
  type TaskView,
  type ToolCallView,
} from '../lib/task-view';

const RISK_COLORS: Record<string, string> = {
  low: 'text-emerald-400',
  medium: 'text-amber-400',
  high: 'text-orange-400',
  critical: 'text-rose-400',
};

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'cancelled']);

export function TaskDetail({
  workspaceId,
  task,
  onBack,
}: {
  workspaceId: string;
  task: Task;
  onBack: () => void;
}) {
  const [view, setView] = useState<TaskView>(emptyTaskView());
  const [connected, setConnected] = useState(false);
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [durable, setDurable] = useState<ArtifactMeta[]>([]);
  // Reconcile the durable (DB-backed, versioned) artifacts with the ephemeral sandbox file list: a saved
  // deliverable gets an inline "Durable v{n}" badge on its file row instead of being listed twice. A durable
  // artifact with NO matching sandbox file (e.g. the sandbox was torn down) is still shown separately.
  const durableMatch = useMemo(() => {
    const byName = new Map<string, ArtifactMeta>();
    for (const d of durable) byName.set(d.name, d);
    const forPath = (path: string) => byName.get(path) ?? byName.get(path.split('/').pop() ?? path);
    const matched = new Set<string>();
    for (const a of artifacts) {
      const d = forPath(a.path);
      if (d) matched.add(d.name);
    }
    return { forPath, orphans: durable.filter((d) => !matched.has(d.name)) };
  }, [artifacts, durable]);
  const [subtasks, setSubtasks] = useState<TaskSubtask[]>([]);
  const [controlError, setControlError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const streamRef = useRef<TaskStream | null>(null);
  // Multi-turn follow-up (KEYSTONE): the durable chat thread + the reply composer state.
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  // Multi-turn follow-up (KEYSTONE): send a new user turn that CONTINUES this task. Optimistically clear
  // the terminal state so the already-open socket renders the continuation as a live run.
  async function sendReply() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.sendTaskMessage(workspaceId, task.id, text);
      setReply('');
      setView((v) => ({ ...v, status: 'running', stoppedReason: null }));
      const m = await api.listTaskMessages(workspaceId, task.id).catch(() => [] as TaskMessage[]);
      setMessages(m);
    } catch (e) {
      setControlError(`Reply failed: ${String(e)}`);
    } finally {
      setSending(false);
    }
  }

  async function doShare() {
    try {
      const { shareId } = await api.shareTask(workspaceId, task.id);
      const url = `${window.location.origin}/share?id=${shareId}`;
      setShareUrl(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
    } catch (e) {
      setControlError(`Share failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    setView(emptyTaskView());
    const stream = openTaskStream(task.id, (event: AgentEvent) => {
      setView((v) => applyEvent(v, event));
    });
    stream.socket.on('connect', () => setConnected(true));
    stream.socket.on('disconnect', () => setConnected(false));
    // Live browser screencast frames (real-time browser view) — base64 JPEG per frame.
    stream.socket.on('browser_frame', (data: string) => setLiveFrame(data));
    streamRef.current = stream;
    return () => {
      stream.close();
      streamRef.current = null;
    };
  }, [task.id]);

  // Refresh the artifact list on mount and whenever a tool result or final output lands
  // (files appear as the agent writes them).
  useEffect(() => {
    let cancelled = false;
    api
      .listArtifacts(workspaceId, task.id)
      .then((a) => !cancelled && setArtifacts(a))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, task.id, view.toolCalls.length, view.finalOutput]);

  // Durable artifacts (TICKET-ART): fetch the DB-backed list when final_output referenced any
  // (empty unless ARTIFACT_PERSISTENCE_ENABLED produced some — so the panel only appears when used).
  useEffect(() => {
    if (view.artifactIds.length === 0) {
      setDurable([]);
      return;
    }
    let cancelled = false;
    api
      .listDurableArtifacts(workspaceId, task.id)
      .then((d) => !cancelled && setDurable(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, task.id, view.artifactIds.length]);

  // Multi-turn follow-up (KEYSTONE): load the durable chat thread on mount + whenever a new answer lands.
  useEffect(() => {
    if (!FOLLOWUP_TURNS_ENABLED) return;
    let cancelled = false;
    api
      .listTaskMessages(workspaceId, task.id)
      .then((m) => !cancelled && setMessages(m))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, task.id, view.finalOutput]);

  // Poll the task detail for Wide Research sub-agents (they appear as the parent fans out). Also
  // serves as a REST fallback so the view isn't empty if the websocket can't connect.
  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api
        .getTask(workspaceId, task.id)
        .then((t) => !cancelled && setSubtasks(t.subtasks))
        .catch(() => undefined);
    void poll();
    const id = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId, task.id, view.toolCalls.length, view.status]);

  // REST event fallback: if the WebSocket can't connect, periodically fold the persisted event log into
  // the view so the task is never permanently blank. applyEvent is idempotent (ignores seq <= lastSeq).
  useEffect(() => {
    if (connected) return;
    let cancelled = false;
    const sync = () =>
      api
        .taskEvents(workspaceId, task.id)
        .then((rows) => {
          if (cancelled) return;
          setView((v) => rows.reduce((acc, r) => applyEvent(acc, r.payload as AgentEvent), v));
        })
        .catch(() => undefined);
    void sync();
    const id = setInterval(() => void sync(), 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected, workspaceId, task.id]);

  async function upload(file: File) {
    try {
      const dataBase64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] ?? '');
        r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
      await api.uploadArtifact(workspaceId, task.id, file.name, dataBase64);
      const a = await api.listArtifacts(workspaceId, task.id);
      setArtifacts(a);
    } catch (e) {
      setControlError(`Upload failed: ${String(e)}`);
    }
  }

  async function downloadDurable(artifactId: string, name: string) {
    try {
      const blob = await api.downloadDurableArtifact(workspaceId, task.id, artifactId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name.split('/').pop() ?? name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }

  async function download(path: string) {
    try {
      const blob = await api.downloadArtifact(workspaceId, task.id, path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = path.split('/').pop() ?? path;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }

  async function stop() {
    setControlError(null);
    // Only use the socket when it's actually connected, else fall back to REST (don't hang on an ack).
    const stream = connected ? streamRef.current : null;
    if (stream) {
      const ack = await stream.send({ type: 'stop', taskId: task.id });
      if (!ack.ok) setControlError(`Stop failed: ${ack.error ?? 'unknown error'}`);
    } else {
      await api.stopTask(workspaceId, task.id).catch((e) => setControlError(`Stop failed: ${String(e)}`));
    }
  }

  async function decide(approvalId: string, decision: 'approve' | 'deny') {
    setControlError(null);
    const appr = view.approvals.find((x) => x.approvalId === approvalId);
    // Elevated approvals (TICKET-POLICY) need a typed confirmation the WS message can't carry — route
    // via HTTP with break-glass confirmation (required in single-user mode; ignored in team mode).
    if (appr?.elevated && decision === 'approve') {
      const confirmation = window.prompt('This is an ELEVATED action. Type CONFIRM-ELEVATED to approve:') ?? undefined;
      if (!confirmation) return;
      setView((v) => resolveApproval(v, approvalId));
      try {
        await api.decideApproval(workspaceId, task.id, approvalId, 'approve', confirmation);
      } catch (e) {
        setView((v) => ({
          ...v,
          approvals: v.approvals.map((x) => (x.approvalId === approvalId ? { ...x, resolved: false } : x)),
        }));
        setControlError(`Could not approve: ${String(e)}`);
      }
      return;
    }
    setView((v) => resolveApproval(v, approvalId)); // optimistic
    const unresolve = () =>
      setView((v) => ({
        ...v,
        approvals: v.approvals.map((a) => (a.approvalId === approvalId ? { ...a, resolved: false } : a)),
      }));
    const stream = connected ? streamRef.current : null;
    try {
      if (stream) {
        const ack = await stream.send(
          decision === 'approve'
            ? { type: 'approve', taskId: task.id, approvalId }
            : { type: 'deny', taskId: task.id, approvalId },
        );
        if (!ack.ok) {
          unresolve();
          setControlError(`Could not ${decision}: ${ack.error ?? 'unknown error'}`);
        }
      } else {
        await api.decideApproval(workspaceId, task.id, approvalId, decision);
      }
    } catch (e) {
      unresolve();
      setControlError(`Could not ${decision}: ${String(e)}`);
    }
  }

  const status = view.status ?? task.status;
  // A `stopped`/`error`(final) event doesn't change view.status, so also treat a stoppedReason as
  // terminal — otherwise the Stop button + running badge would linger after the task stopped.
  const isTerminal = TERMINAL.has(status) || view.stoppedReason !== null;
  const pendingApprovals = view.approvals.filter((a) => !a.resolved);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-slate-400 hover:text-slate-200">
          ← All tasks
        </button>
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-slate-500'}`}
          >
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            {connected ? 'live' : 'offline'}
          </span>
          <button
            onClick={doShare}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
          >
            Share
          </button>
          {!isTerminal && (
            <button
              onClick={stop}
              className="rounded-lg border border-rose-700 bg-rose-950/40 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-900/40"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {shareUrl && (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 px-4 py-2 text-xs text-emerald-200">
          Public replay link (copied):{' '}
          <a href={shareUrl} target="_blank" rel="noreferrer" className="font-mono underline">
            {shareUrl}
          </a>
        </div>
      )}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="mb-1 flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-100">{task.title}</h2>
          <StatusBadge status={status} />
          {task.capability && task.capability !== 'general' && (
            <span className="rounded-full border border-indigo-700 bg-indigo-600/20 px-2 py-0.5 text-xs font-medium capitalize text-indigo-300">
              {task.capability}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-400">{task.prompt}</p>
        {view.cost && (
          <p className="mt-3 text-xs text-slate-500">
            {/* Lead with the COST (the number a user actually cares about); the raw token total is
                secondary + compactly formatted so a multi-step run doesn't read as an alarming "21297". */}
            <span className="text-slate-300">~${fmtUsd(view.cost.estimatedUsd)}</span>
            <span className="text-slate-600"> · {fmtTokens(view.cost.inputTokens + view.cost.outputTokens)} tokens</span>
          </p>
        )}
      </div>

      {pendingApprovals.length > 0 && (
        <div className="rounded-2xl border border-amber-800 bg-amber-950/30 p-4">
          <h3 className="mb-2 text-sm font-semibold text-amber-300">Approval required</h3>
          <div className="flex flex-col gap-2">
            {pendingApprovals.map((a) => (
              <div key={a.approvalId} className="flex flex-col gap-2 border-t border-amber-900/40 pt-2 first:border-t-0 first:pt-0">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-200">
                    <span className={RISK_COLORS[a.riskLevel]}>[{a.riskLevel}]</span> {a.action}
                    {a.elevated && <span className="ml-2 rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-red-200">ELEVATED</span>}
                    {a.reason && <span className="text-slate-500"> — {a.reason}</span>}
                  </span>
                  <span className="flex shrink-0 gap-2">
                    <button
                      onClick={() => decide(a.approvalId, 'approve')}
                      className="rounded bg-emerald-600 px-2.5 py-1 text-xs text-white hover:bg-emerald-500"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => decide(a.approvalId, 'deny')}
                      className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                    >
                      Deny
                    </button>
                  </span>
                </div>
                {a.detail && (
                  <div className="rounded-lg bg-slate-900/60 p-2 font-mono text-[11px] text-slate-300">
                    {a.detail.command && <div><span className="text-slate-500">command:</span> {a.detail.command}</div>}
                    {a.detail.filePath && <div><span className="text-slate-500">file ({a.detail.fileAction ?? 'write'}):</span> {a.detail.filePath}</div>}
                    {a.detail.url && <div><span className="text-slate-500">{a.detail.httpMethod ?? 'GET'} url:</span> {a.detail.url}</div>}
                    {a.detail.browserAction && <div><span className="text-slate-500">browser:</span> {a.detail.browserAction}{a.detail.formTarget ? ` → ${a.detail.formTarget}` : ''}</div>}
                    {a.detail.requestedScopes.length > 0 && <div><span className="text-slate-500">scopes:</span> {a.detail.requestedScopes.join(', ')}</div>}
                    {a.detail.diffPreview && (
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-1.5 text-[10px] leading-tight text-slate-300">{a.detail.diffPreview}</pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {view.planSteps.length > 0 && (
        <Section title="Plan">
          <ol className="flex flex-col gap-1.5">
            {view.planSteps.map((s) => {
              const st = s.status ?? 'pending';
              const done = st === 'completed';
              return (
                <li key={s.id} className="flex items-start gap-2 text-sm">
                  <PlanStepIcon status={st} />
                  <span
                    className={
                      st === 'failed'
                        ? 'text-rose-300'
                        : done
                          ? 'text-slate-500 line-through'
                          : st === 'in_progress'
                            ? 'text-slate-100'
                            : 'text-slate-300'
                    }
                  >
                    {s.title}
                  </span>
                </li>
              );
            })}
          </ol>
        </Section>
      )}

      {(view.toolCalls.length > 0 || liveFrame) && (
        <ComputerPanel
          calls={view.toolCalls}
          running={!isTerminal}
          workspaceId={workspaceId}
          taskId={task.id}
          liveFrame={isTerminal ? null : liveFrame}
          onInput={(input) =>
            void streamRef.current?.send({ type: 'browser_input', taskId: task.id, ...input })
          }
        />
      )}

      {view.messages.length > 0 && (
        <Section title="Reasoning">
          <div className="flex flex-col gap-2">
            {view.messages.map((m) => (
              <p key={m.seq} className="whitespace-pre-wrap text-sm text-slate-300">
                {m.text}
              </p>
            ))}
          </div>
        </Section>
      )}

      {controlError && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300">
          {controlError}
        </div>
      )}

      {view.errors.map((e, i) => (
        <div key={i} className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">
          {e}
        </div>
      ))}

      {subtasks.length > 0 && (
        <Section title={`Sub-agents · Wide Research (${subtasks.length})`}>
          <ul className="flex flex-col gap-1.5">
            {subtasks.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-slate-300" title={s.prompt}>
                  {s.title}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {s.estCostUsd != null && (
                    <span className="text-xs text-slate-500">${s.estCostUsd.toFixed(4)}</span>
                  )}
                  <StatusBadge status={s.status} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Files">
        <label className="mb-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
          Upload a file
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </label>
        {artifacts.length === 0 ? (
          <p className="text-sm text-slate-500">No files yet — the agent&apos;s outputs and your uploads appear here.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {artifacts.map((a) => (
              <li key={a.path} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-slate-300">{a.path}</span>
                    {durableMatch.forPath(a.path) && (
                      <span
                        className="shrink-0 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
                        title={`Saved durably — version ${durableMatch.forPath(a.path)!.version} (survives sandbox teardown)`}
                      >
                        Durable v{durableMatch.forPath(a.path)!.version}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-slate-500">{formatBytes(a.size)}</span>
                    <button onClick={() => download(a.path)} className="text-xs text-emerald-400 hover:text-emerald-300">
                      Download
                    </button>
                  </span>
                </div>
                {isImage(a.path) && (
                  <ArtifactImage workspaceId={workspaceId} taskId={task.id} path={a.path} />
                )}
                {isHtml(a.path) && (
                  <HtmlPreview workspaceId={workspaceId} taskId={task.id} path={a.path} size={a.size} />
                )}
                {isAudio(a.path) && (
                  <ArtifactAudio workspaceId={workspaceId} taskId={task.id} path={a.path} />
                )}
              </li>
            ))}
          </ul>
        )}
        {durableMatch.orphans.length > 0 && (
          <div className="mt-4 border-t border-slate-800 pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Durable artifacts (saved, no longer in sandbox)</p>
            <ul className="flex flex-col gap-2">
              {durableMatch.orphans.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-slate-300" title={`sha256:${d.sha256}`}>
                    {d.name} <span className="text-slate-500">v{d.version}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-slate-500">{formatBytes(d.sizeBytes)}</span>
                    <button
                      onClick={() => downloadDurable(d.id, d.name)}
                      className="text-xs text-emerald-400 hover:text-emerald-300"
                    >
                      Download
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {view.finalOutput && (
        <Section title="Result">
          <p className="whitespace-pre-wrap text-sm text-slate-100">{view.finalOutput}</p>
          {isTerminal && <RatingStars workspaceId={workspaceId} taskId={task.id} initial={task.rating} />}
        </Section>
      )}

      {view.stoppedReason && (
        <p className="text-sm text-slate-500">Stopped: {view.stoppedReason}</p>
      )}

      {/* Multi-turn follow-up (KEYSTONE): the chat thread + an always-available reply composer so a
          finished task is a conversation you continue, not a one-shot job. */}
      {FOLLOWUP_TURNS_ENABLED && messages.length > 0 && (
        <Section title="Conversation">
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                  m.role === 'user' ? 'self-end bg-emerald-900/40 text-emerald-100' : 'self-start bg-slate-800 text-slate-200'
                }`}
              >
                {m.content}
              </div>
            ))}
          </div>
        </Section>
      )}

      {FOLLOWUP_TURNS_ENABLED && isTerminal && (
        <div className="sticky bottom-0 z-10 mt-1 flex items-end gap-2 rounded-xl border border-slate-700 bg-slate-900/95 p-2 backdrop-blur">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendReply();
              }
            }}
            placeholder="Reply or ask for changes…"
            rows={1}
            className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <button
            onClick={() => void sendReply()}
            disabled={sending || reply.trim() === ''}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Manus-style 1-5 star feedback on a finished result; persisted via updateTaskMeta. */
function RatingStars({
  workspaceId,
  taskId,
  initial,
}: {
  workspaceId: string;
  taskId: string;
  initial: number | null;
}) {
  const [rating, setRating] = useState<number | null>(initial);
  const [hover, setHover] = useState(0);
  const [failed, setFailed] = useState(false);
  async function rate(n: number) {
    const prev = rating;
    setRating(n);
    setFailed(false);
    try {
      await api.updateTaskMeta(workspaceId, taskId, { rating: n });
    } catch {
      setRating(prev); // roll back the optimistic update
      setFailed(true);
    }
  }
  return (
    <div className="mt-4 flex items-center gap-2 border-t border-slate-800 pt-3">
      <span className="text-xs text-slate-500">How was this result?</span>
      <div className="flex items-center">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => rate(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            title={`${n} star${n > 1 ? 's' : ''}`}
            className={`px-0.5 text-base ${(hover || rating || 0) >= n ? 'text-amber-400' : 'text-slate-600 hover:text-amber-300'}`}
          >
            ★
          </button>
        ))}
      </div>
      {failed ? (
        <span className="text-xs text-rose-400">Couldn&apos;t save — try again</span>
      ) : (
        rating && <span className="text-xs text-emerald-400">Thanks!</span>
      )}
    </div>
  );
}

// Map a tool name to a Manus-style action category for the computer panel header.
const TOOL_CATEGORY: { match: (t: string) => boolean; label: string; icon: string }[] = [
  { match: (t) => t.startsWith('shell') || t.includes('sandbox') || t.includes('exec'), label: 'Terminal', icon: '⌨️' },
  { match: (t) => t.startsWith('browser'), label: 'Browser', icon: '🌐' },
  { match: (t) => t.startsWith('fs_') || t.startsWith('generate_'), label: 'Editor', icon: '📝' },
  { match: (t) => t === 'http_fetch' || t === 'web_search' || t === 'world_bank', label: 'Web', icon: '🔎' },
  { match: (t) => t.startsWith('github'), label: 'GitHub', icon: '🐙' },
  { match: (t) => t.includes('peer'), label: 'Peer', icon: '🤝' },
  { match: (t) => t.includes('knowledge'), label: 'Knowledge', icon: '📖' },
];
function toolCategory(tool: string): { label: string; icon: string } {
  return TOOL_CATEGORY.find((c) => c.match(tool)) ?? { label: 'Tool', icon: '•' };
}

/**
 * The product's Computer panel — the Manus-style live action panel: every tool call as a timeline you can
 * scrub through, each labelled by category (Terminal/Editor/Browser/Web/…). Follows the latest action
 * live while the task runs, until the user scrubs back.
 */
type BrowserInput = { kind: 'click' | 'type' | 'key'; x?: number; y?: number; text?: string; key?: string };

function ComputerPanel({
  calls,
  running,
  workspaceId,
  taskId,
  liveFrame,
  onInput,
}: {
  calls: ToolCallView[];
  running: boolean;
  workspaceId: string;
  taskId: string;
  liveFrame?: string | null;
  onInput?: (input: BrowserInput) => void;
}) {
  const [focus, setFocus] = useState(calls.length - 1);
  const [follow, setFollow] = useState(true);
  const [takeover, setTakeover] = useState(false);
  const [typeText, setTypeText] = useState('');
  useEffect(() => {
    if (follow) setFocus(calls.length - 1);
  }, [calls.length, follow]);

  const hasCalls = calls.length > 0;
  const idx = Math.min(Math.max(focus, 0), calls.length - 1);
  const tc = hasCalls ? calls[idx]! : null;
  const cat = tc ? toolCategory(tc.tool) : { label: 'Browser', icon: '🌐' };
  // fs_write and the coding workspace edit tools (write_file/apply_patch) all carry before/after in
  // their output, so the same before/after diff view renders for each (TICKET-CODING).
  const diff =
    tc && (tc.tool === 'fs_write' || tc.tool === 'write_file' || tc.tool === 'apply_patch') && tc.status === 'ok'
      ? asFsWriteOutput(tc.output)
      : null;
  // Browser actions auto-capture a screenshot — show it inline so the user watches the agent browse.
  const shot = (tc?.output as { screenshot?: string } | null | undefined)?.screenshot;
  // When the agent is actively browsing and we're following live, show the real-time screencast frame.
  const showLive = running && follow && !!liveFrame;
  const go = (n: number) => {
    setFollow(false);
    setFocus(Math.min(Math.max(n, 0), calls.length - 1));
  };
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm text-slate-200">
          <span>{showLive ? '🌐' : cat.icon}</span>
          <span className="font-medium">AgentOS&apos;s Computer</span>
          <span className="text-slate-500">· {showLive ? 'Browser (live)' : cat.label}</span>
        </span>
        <span className="flex items-center gap-2 text-xs">
          {showLive && onInput && (
            <button
              onClick={() => setTakeover((t) => !t)}
              className={`rounded px-2 py-0.5 ${takeover ? 'bg-amber-500 text-slate-900' : 'border border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >
              {takeover ? '● You are in control' : 'Take control'}
            </button>
          )}
          {running && follow && (
            <span className="flex items-center gap-1 text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live
            </span>
          )}
          {!follow && (
            <button onClick={() => setFollow(true)} className="text-emerald-400 hover:text-emerald-300">
              Jump to live →
            </button>
          )}
        </span>
      </div>
      <div className="px-4 py-3">
        {showLive ? (
          <div>
            <img
              src={`data:image/jpeg;base64,${liveFrame}`}
              alt="Live browser"
              onClick={(e) => {
                if (!takeover || !onInput) return;
                const r = e.currentTarget.getBoundingClientRect();
                onInput({ kind: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
              }}
              className={`w-full rounded-lg border border-slate-800 ${takeover ? 'cursor-crosshair' : ''}`}
            />
            {takeover && onInput && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={typeText}
                  onChange={(e) => setTypeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (typeText) onInput({ kind: 'type', text: typeText });
                      onInput({ kind: 'key', key: 'Enter' });
                      setTypeText('');
                    }
                  }}
                  placeholder="Click a field above, then type here + Enter…"
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none"
                />
                <button
                  onClick={() => {
                    if (typeText) onInput({ kind: 'type', text: typeText });
                    setTypeText('');
                  }}
                  className="rounded-lg bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-500"
                >
                  Type
                </button>
              </div>
            )}
          </div>
        ) : tc ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className={`font-mono text-xs ${RISK_COLORS[tc.riskLevel]}`}>{tc.tool}</span>
              <ToolStatus status={tc.status} />
            </div>
            {shot && typeof shot === 'string' ? (
              <ArtifactImage workspaceId={workspaceId} taskId={taskId} path={shot} />
            ) : diff ? (
              <FileDiff {...diff} />
            ) : (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-400">
                {JSON.stringify(tc.status === 'error' ? { error: tc.error } : tc.output ?? tc.input, null, 2)}
              </pre>
            )}
          </>
        ) : (
          <p className="text-xs text-slate-500">Waiting for the browser…</p>
        )}
      </div>
      {hasCalls && (
        <div className="flex items-center gap-2 border-t border-slate-800 px-4 py-2">
          <button onClick={() => go(idx - 1)} disabled={idx === 0} className="text-slate-400 hover:text-slate-100 disabled:opacity-30">
            ⏮
          </button>
          <input
            type="range"
            min={0}
            max={calls.length - 1}
            value={idx}
            onChange={(e) => go(Number(e.target.value))}
            className="h-1 flex-1 accent-emerald-500"
          />
          <button onClick={() => go(idx + 1)} disabled={idx === calls.length - 1} className="text-slate-400 hover:text-slate-100 disabled:opacity-30">
            ⏭
          </button>
          <span className="w-12 shrink-0 text-right text-xs text-slate-500">
            {idx + 1}/{calls.length}
          </span>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </div>
  );
}

/** Live status glyph for a plan step (Manus-style checklist). */
function PlanStepIcon({ status }: { status: string }) {
  if (status === 'completed') return <span className="mt-0.5 text-emerald-400">✓</span>;
  if (status === 'failed') return <span className="mt-0.5 text-rose-400">✗</span>;
  if (status === 'in_progress')
    return <span className="mt-0.5 animate-pulse text-amber-400">●</span>;
  return <span className="mt-0.5 text-slate-600">○</span>;
}

/** Compact USD: cents-and-up at 2dp, sub-cent at 4dp so a cheap run still shows a real (non-$0.00) figure. */
function fmtUsd(usd: number): string {
  return usd >= 0.01 ? usd.toFixed(2) : usd.toFixed(4);
}

/** Compact token count: 21297 -> "21.3K" so a multi-step run's cumulative total doesn't read as alarming. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(path);
}

function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

function isAudio(path: string): boolean {
  return /\.(mp3|wav|ogg|m4a)$/i.test(path);
}

/** Above this size we don't inline-preview HTML (the deliverable byte cap is 4MB; keep srcdoc small). */
const MAX_HTML_PREVIEW_BYTES = 1_500_000;

/** Inline preview for image artifacts (the agent's browser screenshots, etc.) — the "computer"
 * panel visual. Fetches the credentialed blob into an object URL. */
function ArtifactImage({ workspaceId, taskId, path }: { workspaceId: string; taskId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    api
      .downloadArtifact(workspaceId, taskId, path)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [workspaceId, taskId, path]);
  if (!src) return null;
  return <img src={src} alt={path} className="max-h-72 rounded-lg border border-slate-800" />;
}

/** Inline audio player for generated/ uploaded speech artifacts. Fetches the credentialed blob. */
function ArtifactAudio({ workspaceId, taskId, path }: { workspaceId: string; taskId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    api
      .downloadArtifact(workspaceId, taskId, path)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [workspaceId, taskId, path]);
  if (!src) return null;
  return <audio src={src} controls className="mt-1 w-full" />;
}

/**
 * Inline preview for HTML deliverables (slides, documents, the spreadsheet table view) — the Manus
 * "see the result render" UX. Rendered in a hardened iframe: `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, so the deck's inline controller script runs but the document has an opaque
 * origin — it cannot read cookies/localStorage or reach the parent page. Content is injected via
 * srcDoc (text), never a same-origin URL. Collapsed by default; only fetched when opened.
 */
function HtmlPreview({
  workspaceId,
  taskId,
  path,
  size,
}: {
  workspaceId: string;
  taskId: string;
  path: string;
  size: number;
}) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooBig = size > MAX_HTML_PREVIEW_BYTES;

  useEffect(() => {
    if (!open || html !== null || tooBig) return;
    let cancelled = false;
    api
      .downloadArtifact(workspaceId, taskId, path)
      .then((blob) => blob.text())
      .then((text) => !cancelled && setHtml(text))
      .catch(() => !cancelled && setError('Could not load preview'));
    return () => {
      cancelled = true;
    };
  }, [open, html, tooBig, workspaceId, taskId, path]);

  if (tooBig) return null; // large decks: download instead

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-indigo-400 hover:text-indigo-300"
      >
        {open ? 'Hide preview' : 'Preview'}
      </button>
      {open && error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
      {open && html !== null && (
        <iframe
          title={`preview-${path}`}
          sandbox="allow-scripts"
          srcDoc={html}
          className="mt-2 h-96 w-full rounded-lg border border-slate-800 bg-white"
        />
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function ToolStatus({ status }: { status: 'running' | 'ok' | 'error' }) {
  const map = {
    running: 'text-amber-400',
    ok: 'text-emerald-400',
    error: 'text-rose-400',
  };
  return <span className={`text-xs ${map[status]}`}>● {status}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'completed'
      ? 'border-emerald-700 text-emerald-300'
      : status === 'failed'
        ? 'border-rose-700 text-rose-300'
        : status === 'stopped'
          ? 'border-slate-600 text-slate-300'
          : 'border-amber-700 text-amber-300';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${color}`}>{status}</span>
  );
}
