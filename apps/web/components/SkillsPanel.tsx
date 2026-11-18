'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Skill } from '../lib/api';

/** Manage reusable skills (named prompt recipes) and run them on demand. */
export function SkillsPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [items, setItems] = useState<Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [capability, setCapability] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listSkills(workspaceId).then(setItems).catch((e) =>
      setError(e instanceof ApiError ? e.message : 'Failed to load skills'),
    );
  }
  useEffect(refresh, [workspaceId]);

  async function create() {
    if (!name.trim() || !instructions.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createSkill(workspaceId, {
        name: name.trim(),
        instructions: instructions.trim(),
        ...(capability ? { capability } : {}),
        ...(effort ? { effort } : {}),
      });
      setName('');
      setInstructions('');
      setCapability('');
      setEffort('');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create skill');
    } finally {
      setBusy(false);
    }
  }

  async function run(skill: Skill) {
    let input: string | undefined;
    if (skill.instructions.includes('{{input}}')) {
      const raw = window.prompt(`Input for "${skill.name}"`);
      if (raw === null) return; // only an explicit Cancel aborts (blank input is allowed)
      input = raw;
    }
    // Skills v2 (TICKET-4): collect each typed param value before running.
    let params: Record<string, unknown> | undefined;
    if (skill.params && skill.params.length > 0) {
      params = {};
      for (const p of skill.params) {
        const raw = window.prompt(`${p.name}${p.required ? ' (required)' : ''}${p.description ? ` — ${p.description}` : ''} [${p.type}]`);
        if (raw === null) return;
        if (raw !== '') params[p.name] = raw;
      }
    }
    setError(null);
    setNotice(null);
    try {
      const task = await api.runSkill(workspaceId, skill.id, input, params);
      setNotice(`Started "${task.title}" — find it in your task list.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not run skill');
    }
  }

  async function remove(skill: Skill) {
    setError(null);
    try {
      await api.deleteSkill(workspaceId, skill.id);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete skill');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Skills</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <div className="mb-5 rounded-xl border border-slate-800 bg-slate-950 p-4">
          <input
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
            placeholder="Skill name (e.g. Summarize a URL)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="mt-2 w-full resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
            rows={3}
            placeholder="Instructions. Use {{input}} where the run-time input should go."
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <select value={capability} onChange={(e) => setCapability(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200" title="capability mode (v2)">
              <option value="">capability: default</option>
              {['slides', 'document', 'website', 'chart', 'image', 'spreadsheet', 'chat'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={effort} onChange={(e) => setEffort(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200" title="effort tier (v2)">
              <option value="">effort: default</option>
              {['low', 'medium', 'high', 'max'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-500">{'{{input}}'} / {'{{param}}'} placeholders are filled at run time</span>
            <button
              onClick={create}
              disabled={busy || !name.trim() || !instructions.trim()}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Add skill'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
          {notice && <p className="mt-2 text-sm text-emerald-400">{notice}</p>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {items === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              No skills yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate text-sm font-medium text-slate-200">
                      {s.name}
                      {s.version && s.version > 1 && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">v{s.version}</span>}
                      {s.capability && <span className="rounded bg-sky-900 px-1.5 py-0.5 text-[10px] text-sky-300">{s.capability}</span>}
                    </div>
                    <p className="truncate text-xs text-slate-500">{s.instructions}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs">
                    <button onClick={() => run(s)} className="text-emerald-400 hover:text-emerald-300">
                      Run
                    </button>
                    <button onClick={() => remove(s)} className="text-rose-400 hover:text-rose-300">
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
