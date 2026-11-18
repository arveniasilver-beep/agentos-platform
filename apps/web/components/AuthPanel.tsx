'use client';

import { useState } from 'react';
import { api, ApiError, type SessionUser } from '../lib/api';

export function AuthPanel({ onAuthed }: { onAuthed: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(email, password, displayName || email);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-24 w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-xl">
      <h2 className="mb-1 text-xl font-semibold text-slate-100">
        {mode === 'login' ? 'Sign in' : 'Create your account'}
      </h2>
      <p className="mb-6 text-sm text-slate-400">
        {mode === 'login' ? 'Welcome back.' : 'Start running autonomous tasks.'}
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === 'register' && (
          <input
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}
        <input
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
          type="password"
          required
          minLength={8}
          placeholder="Password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <button
        className="mt-4 w-full text-center text-xs text-slate-400 hover:text-slate-200"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setError(null);
        }}
      >
        {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}
