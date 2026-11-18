'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Personalization } from '../lib/api';

/**
 * Personalization (Manus-style "Kişiselleştirme"): the workspace's profile, custom instructions, and
 * remembered facts. Everything here is prepended to the system prompt of every task, so the agent is
 * steered consistently across all runs.
 */
export function PersonalizationPanel({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Personalization | null>(null);
  const [newFact, setNewFact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .getPersonalization(workspaceId)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load personalization'));
  }, [workspaceId]);

  function patch(p: Partial<Personalization>) {
    setData((d) => (d ? { ...d, ...p } : d));
  }

  function addFact() {
    const f = newFact.trim();
    if (!f || !data) return;
    if (data.memories.length >= 100) return;
    patch({ memories: [...data.memories, f] });
    setNewFact('');
  }

  async function save() {
    if (!data) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.updatePersonalization(workspaceId, data);
      setData(saved);
      setNotice('Saved — applied to all future tasks.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="mt-10 w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Personalization</h2>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Profile, custom instructions, and remembered facts — prepended to every task so the agent
          works the way you want across all runs.
        </p>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-900 bg-rose-950/30 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-sm text-emerald-300">
            {notice}
          </div>
        )}

        {!data ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-400">
                Name / nickname
                <input
                  className={`mt-1 ${field}`}
                  maxLength={100}
                  value={data.nickname ?? ''}
                  onChange={(e) => patch({ nickname: e.target.value })}
                  placeholder="How should the agent address you?"
                />
              </label>
              <label className="text-xs text-slate-400">
                Profession
                <input
                  className={`mt-1 ${field}`}
                  maxLength={100}
                  value={data.profession ?? ''}
                  onChange={(e) => patch({ profession: e.target.value })}
                  placeholder="e.g. Founder, Analyst"
                />
              </label>
            </div>

            <label className="text-xs text-slate-400">
              About you
              <textarea
                className={`mt-1 resize-none ${field}`}
                rows={2}
                maxLength={2000}
                value={data.about ?? ''}
                onChange={(e) => patch({ about: e.target.value })}
                placeholder="Context the agent should know about you."
              />
            </label>

            <label className="text-xs text-slate-400">
              Custom instructions
              <textarea
                className={`mt-1 resize-none ${field}`}
                rows={4}
                maxLength={4000}
                value={data.instructions ?? ''}
                onChange={(e) => patch({ instructions: e.target.value })}
                placeholder="e.g. Always answer in Turkish. Prefer concise, sourced answers."
              />
            </label>

            <div>
              <p className="mb-1 text-xs text-slate-400">Remembered facts ({data.memories.length}/100)</p>
              <div className="mb-2 flex gap-2">
                <input
                  className={field}
                  value={newFact}
                  maxLength={500}
                  placeholder="Add a fact the agent should remember…"
                  onChange={(e) => setNewFact(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addFact();
                    }
                  }}
                />
                <button
                  onClick={addFact}
                  disabled={!newFact.trim()}
                  className="shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              {data.memories.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {data.memories.map((m, i) => (
                    <li
                      key={`${i}-${m}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-1.5 text-sm text-slate-200"
                    >
                      <span className="truncate">{m}</span>
                      <button
                        onClick={() => patch({ memories: data.memories.filter((_, j) => j !== i) })}
                        className="shrink-0 text-xs text-slate-500 hover:text-rose-400"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex justify-end">
              <button
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
