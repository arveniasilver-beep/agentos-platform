'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task } from '../lib/api';

/**
 * Global task search / command palette (Manus's "Ara"): debounced search across all of the
 * workspace's tasks (title + prompt, archived included), plus a "start a new task with this text"
 * action. Opened with Cmd/Ctrl+K. Keyboard: ↑/↓ to move, Enter to open, Esc to close.
 */
export function CommandPalette({
  workspaceId,
  onClose,
  onOpenTask,
  onCreate,
}: {
  workspaceId: string;
  onClose: () => void;
  onOpenTask: (task: Task) => void;
  /** Starts a task with the given prompt; rejects on failure (the palette stays open + shows it). */
  onCreate: (prompt: string) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Task[]>([]);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .searchTasks(workspaceId, term)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setActive(0);
        })
        .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Search failed'));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, workspaceId]);

  // The "new task" row sits at index 0 when there's a query; results follow.
  const canCreate = q.trim().length > 0;
  const rowCount = (canCreate ? 1 : 0) + results.length;

  function activate(index: number) {
    if (creating) return;
    if (canCreate && index === 0) {
      setCreating(true);
      setError(null);
      // On success the parent navigates (unmounting this palette); on failure we keep it open.
      onCreate(q.trim()).catch(() => {
        setCreating(false);
        setError('Could not start the task — check that an LLM key is configured.');
      });
      return;
    }
    const task = results[index - (canCreate ? 1 : 0)];
    if (task) onOpenTask(task);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rowCount - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(active);
    }
  }

  const rowCls = (i: number) =>
    `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
      i === active ? 'bg-slate-800 text-slate-100' : 'text-slate-300 hover:bg-slate-900'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="mt-[10vh] w-full max-w-xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tasks or start a new one…"
          className="w-full border-b border-slate-800 bg-transparent px-4 py-3 text-sm text-slate-100 outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {error && <p className="px-3 py-2 text-sm text-rose-400">{error}</p>}
          {canCreate && (
            <button className={rowCls(0)} onClick={() => activate(0)} disabled={creating}>
              <span className="text-emerald-400">＋</span>
              <span className="truncate">
                {creating ? 'Starting…' : 'Start new task:'}{' '}
                <span className="text-slate-100">“{q.trim()}”</span>
              </span>
            </button>
          )}
          {results.map((t, i) => {
            const idx = i + (canCreate ? 1 : 0);
            return (
              <button key={t.id} className={rowCls(idx)} onClick={() => activate(idx)}>
                <span className={t.favorite ? 'text-amber-400' : 'text-slate-600'}>
                  {t.favorite ? '★' : '•'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.title}</span>
                  <span className="block truncate text-xs text-slate-500">{t.prompt}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-500">
                  {t.archivedAt ? 'archived' : t.status}
                </span>
              </button>
            );
          })}
          {!canCreate && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              Type to search your tasks. <span className="text-slate-600">⌘/Ctrl + K</span>
            </p>
          )}
          {canCreate && results.length === 0 && !error && (
            <p className="px-3 py-3 text-center text-xs text-slate-600">No matching tasks.</p>
          )}
        </div>
      </div>
    </div>
  );
}
