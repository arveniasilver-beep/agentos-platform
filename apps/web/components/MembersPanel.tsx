'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Member, type MemberRole } from '../lib/api';

const ASSIGNABLE: Exclude<MemberRole, 'owner'>[] = ['admin', 'member', 'viewer'];

/** Workspace collaboration: list members, invite by email, change role, remove. */
export function MembersPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<MemberRole, 'owner'>>('member');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listMembers(workspaceId).then(setMembers).catch((e) =>
      setError(e instanceof ApiError ? e.message : 'Failed to load members'),
    );
  }
  useEffect(refresh, [workspaceId]);

  async function add() {
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addMember(workspaceId, email.trim(), role);
      setEmail('');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add member');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(m: Member, next: Exclude<MemberRole, 'owner'>) {
    setError(null);
    try {
      await api.updateMemberRole(workspaceId, m.userId, next);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change role');
    }
  }

  async function remove(m: Member) {
    setError(null);
    try {
      await api.removeMember(workspaceId, m.userId);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove member');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Members</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <div className="mb-5 flex gap-2">
          <input
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Exclude<MemberRole, 'owner'>)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-200"
          >
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            onClick={add}
            disabled={busy || !email.trim()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Invite'}
          </button>
        </div>
        {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

        <div className="flex-1 overflow-y-auto">
          {members === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-200">{m.user.displayName}</div>
                    <div className="truncate text-xs text-slate-500">{m.user.email}</div>
                  </div>
                  {m.role === 'owner' ? (
                    <span className="text-xs font-medium text-amber-400">owner</span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <select
                        value={m.role}
                        onChange={(e) => changeRole(m, e.target.value as Exclude<MemberRole, 'owner'>)}
                        className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-200"
                      >
                        {ASSIGNABLE.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button onClick={() => remove(m)} className="text-xs text-rose-400 hover:text-rose-300">
                        Remove
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
