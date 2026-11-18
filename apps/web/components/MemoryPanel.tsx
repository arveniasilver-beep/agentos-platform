'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type ProjectMemoryEntry } from '../lib/api';

const KINDS = [
  'decision', 'project_rule', 'architecture_note', 'risk', 'known_bug',
  'lesson_learned', 'completed_ticket', 'deferred_item', 'important_file', 'user_preference',
] as const;
const HIGH_IMPACT = new Set(['decision', 'project_rule', 'architecture_note']);

/** Minimal Project Memory manager (TICKET-MEMORY): list/create/edit/archive/delete. Content shown as
 * stored (already redacted server-side). Member+ can write; viewers see read-only. */
export function MemoryPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [items, setItems] = useState<ProjectMemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [kind, setKind] = useState<string>('decision');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api
      .listMemory(workspaceId, { includeArchived })
      .then(setItems)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load memory'));
  }
  useEffect(refresh, [workspaceId, includeArchived]);

  async function create() {
    if (!content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createMemory(workspaceId, {
        kind,
        content: content.trim(),
        priority,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setContent('');
      setTags('');
      setPriority(0);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create memory');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col space-y-4 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Project Memory</h2>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
      </div>
      <p className="text-xs text-slate-500">
        Durable project context the agent recalls at task start. Secrets are redacted on save; entries are
        injected as context (not commands). High-impact kinds (decision / project_rule / architecture_note)
        are audited.
      </p>

      <div className="space-y-2 rounded-md border border-slate-700 p-3">
        <div className="flex gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded bg-slate-800 px-2 py-1 text-sm">
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input
            type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))}
            className="w-20 rounded bg-slate-800 px-2 py-1 text-sm" placeholder="priority" title="priority"
          />
        </div>
        <textarea
          value={content} onChange={(e) => setContent(e.target.value)} rows={2}
          placeholder="Memory content (secrets are redacted on save)…"
          className="w-full rounded bg-slate-800 px-2 py-1 text-sm"
        />
        <input
          value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma, separated"
          className="w-full rounded bg-slate-800 px-2 py-1 text-sm"
        />
        <button
          onClick={create} disabled={busy || !content.trim()}
          className="rounded bg-sky-600 px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Add memory'}
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
        show archived
      </label>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <ul className="space-y-2">
        {items?.map((m) => (
          <li key={m.id} className={`rounded-md border border-slate-700 p-2 text-sm ${m.archivedAt ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs ${HIGH_IMPACT.has(m.kind) ? 'bg-amber-900 text-amber-300' : 'bg-slate-800 text-slate-300'}`}>{m.kind}</span>
                {m.archivedAt && <span className="text-xs text-slate-500">archived</span>}
                {m.expiresAt && <span className="text-xs text-slate-500">expires {new Date(m.expiresAt).toLocaleDateString()}</span>}
              </span>
              <span className="flex gap-2">
                {!m.archivedAt && (
                  <button onClick={() => api.archiveMemory(workspaceId, m.id).then(refresh)} className="text-xs text-slate-400 hover:text-slate-200">archive</button>
                )}
                <button onClick={() => api.deleteMemory(workspaceId, m.id).then(refresh)} className="text-xs text-rose-400 hover:text-rose-300">delete</button>
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-slate-200">{m.content}</p>
            <p className="mt-1 text-xs text-slate-500">
              source: {m.source} · priority {m.priority} · confidence {m.confidence.toFixed(2)}
              {m.tags.length > 0 && <> · {m.tags.join(', ')}</>}
            </p>
          </li>
        ))}
        {items?.length === 0 && <li className="text-sm text-slate-500">No memory yet.</li>}
      </ul>
      </div>
    </div>
  );
}
