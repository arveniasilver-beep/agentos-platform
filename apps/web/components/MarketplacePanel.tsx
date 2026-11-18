'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { PLAYBOOK_TEMPLATES, TEMPLATE_CATEGORIES, type PlaybookTemplate } from '../lib/playbook-templates';
import { extractVariables } from '../lib/playbook-vars';

/**
 * Marketplace (Manus-style template gallery): a curated catalog of starter playbooks. "Add to
 * Playbooks" clones the template into this workspace as a normal (parameterized) playbook — no
 * cross-tenant data, just static templates.
 */
export function MarketplacePanel({
  workspaceId,
  onClose,
  onAdded,
}: {
  workspaceId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [category, setCategory] = useState<(typeof TEMPLATE_CATEGORIES)[number] | 'All'>('All');
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reconcile against playbooks already in this workspace so a template added earlier (or last time
  // this panel was open) shows "Added" instead of tricking the user into creating a duplicate.
  useEffect(() => {
    api
      .listPlaybooks(workspaceId)
      .then((existing) => {
        const names = new Set(existing.map((p) => p.name));
        setAddedIds(new Set(PLAYBOOK_TEMPLATES.filter((t) => names.has(t.name)).map((t) => t.id)));
      })
      .catch(() => undefined);
  }, [workspaceId]);

  const shown = useMemo(
    () => (category === 'All' ? PLAYBOOK_TEMPLATES : PLAYBOOK_TEMPLATES.filter((t) => t.category === category)),
    [category],
  );

  async function add(t: PlaybookTemplate) {
    setBusyId(t.id);
    setError(null);
    try {
      await api.createPlaybook(workspaceId, {
        name: t.name,
        prompt: t.prompt,
        ...(t.capability && t.capability !== 'general' ? { capability: t.capability } : {}),
        ...(t.effort && t.effort !== 'high' ? { effort: t.effort } : {}),
      });
      setAddedIds((s) => new Set(s).add(t.id));
      onAdded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the template');
    } finally {
      setBusyId(null);
    }
  }

  const tab = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium ${active ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="mt-8 w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Marketplace</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-400">
          Curated starter playbooks. Add one to your workspace, then run it (filling in any {'{{'}variables{'}}'}).
        </p>

        {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

        <div className="mb-4 flex flex-wrap gap-2">
          <button className={tab(category === 'All')} onClick={() => setCategory('All')}>
            All
          </button>
          {TEMPLATE_CATEGORIES.map((c) => (
            <button key={c} className={tab(category === c)} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {shown.map((t) => {
            const vars = extractVariables(t.prompt);
            const added = addedIds.has(t.id);
            return (
              <div key={t.id} className="flex flex-col rounded-xl border border-slate-800 bg-slate-950 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-200">{t.name}</span>
                  <span className="rounded-full border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {t.category}
                  </span>
                </div>
                <p className="mb-2 flex-1 text-xs text-slate-500">{t.description}</p>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-600">
                    {vars.length} variable{vars.length === 1 ? '' : 's'}
                  </span>
                  <button
                    onClick={() => add(t)}
                    disabled={busyId === t.id || added}
                    className={`rounded-lg px-3 py-1 text-xs font-medium ${added ? 'bg-slate-700 text-slate-400' : 'bg-emerald-600 text-white hover:bg-emerald-500'} disabled:opacity-60`}
                  >
                    {added ? 'Added ✓' : busyId === t.id ? 'Adding…' : 'Add to Playbooks'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
