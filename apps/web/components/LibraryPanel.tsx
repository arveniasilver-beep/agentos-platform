'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type LibraryItem } from '../lib/api';

/**
 * Cross-task Library (Manus's "Kütüphane"): every deliverable the agent produced across the
 * workspace's tasks, searchable, grouped by task, with inline preview + download. Downloads/preview
 * fetch the credentialed blob from the per-task artifact route.
 */
export function LibraryPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listLibrary(workspaceId)
      .then((r) => {
        setItems(r.items);
        setTruncated(r.truncated);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the library'));
  }, [workspaceId]);

  // Filter by filename or task title, then group by task (preserving newest-first order).
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = (items ?? []).filter(
      (it) =>
        !needle ||
        it.path.toLowerCase().includes(needle) ||
        it.taskTitle.toLowerCase().includes(needle),
    );
    const byTask = new Map<string, { title: string; items: LibraryItem[] }>();
    for (const it of filtered) {
      const g = byTask.get(it.taskId) ?? { title: it.taskTitle, items: [] };
      g.items.push(it);
      byTask.set(it.taskId, g);
    }
    return [...byTask.entries()];
  }, [items, q]);

  async function download(it: LibraryItem) {
    try {
      const blob = await api.downloadArtifact(workspaceId, it.taskId, it.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = it.path.split('/').pop() ?? it.path;
      // Firefox requires the anchor to be in the DOM, and the object URL to outlive the click.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('Download failed');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="mt-10 w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Library</h2>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files and tasks…"
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
        />

        {error && (
          <div className="mb-3 rounded-lg border border-rose-900 bg-rose-950/30 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        {items === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
            {items.length === 0 ? 'No files yet — the agent’s outputs appear here.' : 'No matches.'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {truncated && (
              <p className="text-xs text-amber-400/80">
                Showing files from your most recent tasks (list truncated).
              </p>
            )}
            {groups.map(([taskId, g]) => (
              <div key={taskId}>
                <h3 className="mb-1 truncate text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {g.title}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {g.items.map((it) => (
                    <li key={`${taskId}/${it.path}`} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-sm">
                        <span className="truncate font-mono text-slate-300">{it.path}</span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="text-xs text-slate-500">{formatBytes(it.size)}</span>
                          <button onClick={() => download(it)} className="text-xs text-emerald-400 hover:text-emerald-300">
                            Download
                          </button>
                        </span>
                      </div>
                      <LibraryPreview workspaceId={workspaceId} item={it} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const MAX_HTML_PREVIEW_BYTES = 1_500_000;

/** Inline preview: image artifacts render directly; HTML deliverables render in a hardened
 * sandbox="allow-scripts" (no allow-same-origin) iframe — the same isolation as TaskDetail. */
function LibraryPreview({ workspaceId, item }: { workspaceId: string; item: LibraryItem }) {
  const isImage = /\.(png|jpe?g|webp|gif|svg)$/i.test(item.path);
  const isHtml = /\.html?$/i.test(item.path) && item.size <= MAX_HTML_PREVIEW_BYTES;
  const [open, setOpen] = useState(false);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    let url: string | null = null;
    let cancelled = false;
    api
      .downloadArtifact(workspaceId, item.taskId, item.path)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImgSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [isImage, workspaceId, item.taskId, item.path]);

  useEffect(() => {
    if (!open || !isHtml || html !== null) return;
    let cancelled = false;
    api
      .downloadArtifact(workspaceId, item.taskId, item.path)
      .then((blob) => blob.text())
      .then((text) => !cancelled && setHtml(text))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, isHtml, html, workspaceId, item.taskId, item.path]);

  if (isImage && imgSrc) {
    return <img src={imgSrc} alt={item.path} className="max-h-64 rounded-lg border border-slate-800" />;
  }
  if (isHtml) {
    return (
      <div>
        <button onClick={() => setOpen((o) => !o)} className="text-xs text-indigo-400 hover:text-indigo-300">
          {open ? 'Hide preview' : 'Preview'}
        </button>
        {open && html !== null && (
          <iframe
            title={`preview-${item.taskId}-${item.path}`}
            sandbox="allow-scripts"
            srcDoc={html}
            className="mt-2 h-80 w-full rounded-lg border border-slate-800 bg-white"
          />
        )}
      </div>
    );
  }
  return null;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
