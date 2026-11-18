'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '@agentos/protocol';
import { BRAND } from '@agentos/brand';
import { api, type SharedReplay } from '../../lib/api';
import { reduceEvents, type TaskView } from '../../lib/task-view';

export default function SharePage() {
  const [replay, setReplay] = useState<SharedReplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      setError('No share link id.');
      return;
    }
    api
      .getSharedReplay(id)
      .then((r) => {
        setReplay(r);
        setStep(r.events.length);
      })
      .catch(() => setError('This shared run was not found (it may have been unshared).'));
  }, []);

  const events = useMemo<AgentEvent[]>(
    () => (replay?.events ?? []).map((e) => e.payload as AgentEvent),
    [replay],
  );
  const view: TaskView = useMemo(() => reduceEvents(events.slice(0, step)), [events, step]);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setStep((s) => {
        if (s >= events.length) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 600);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, events.length]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-center">
        <h1 className="text-lg font-semibold text-slate-200">{BRAND.appName} · Shared run</h1>
        <p className="mt-4 text-sm text-slate-400">{error}</p>
      </main>
    );
  }
  if (!replay) {
    return <main className="px-6 py-20 text-center text-sm text-slate-500">Loading replay…</main>;
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-emerald-400">{BRAND.appName} · shared replay</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-100">{replay.title}</h1>
        <p className="mt-1 text-sm text-slate-400">{replay.prompt}</p>
        <p className="mt-2 text-xs text-slate-500">
          status: {replay.status}
          {replay.estCostUsd != null && ` · $${replay.estCostUsd.toFixed(4)}`}
        </p>
      </header>

      {/* Replay scrubber */}
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <button
          onClick={() => {
            if (step >= events.length) setStep(0);
            setPlaying((p) => !p);
          }}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
        >
          {playing ? 'Pause' : step >= events.length ? 'Replay' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={events.length}
          value={step}
          onChange={(e) => {
            setPlaying(false);
            setStep(Number(e.target.value));
          }}
          className="flex-1 accent-emerald-500"
        />
        <span className="w-16 text-right text-xs text-slate-500">
          {step}/{events.length}
        </span>
      </div>

      {view.planSummary && (
        <Section title="Plan">
          <p className="whitespace-pre-wrap text-sm text-slate-300">{view.planSummary}</p>
        </Section>
      )}

      {view.toolCalls.length > 0 && (
        <Section title="Tool calls">
          <ul className="flex flex-col gap-1.5 text-sm">
            {view.toolCalls.map((t) => (
              <li key={t.callId} className="flex items-center justify-between gap-3">
                <span className="font-mono text-slate-300">{t.tool}</span>
                <span
                  className={
                    t.status === 'error'
                      ? 'text-rose-400'
                      : t.status === 'ok'
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                  }
                >
                  ● {t.status}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {view.finalOutput && (
        <Section title="Result">
          <p className="whitespace-pre-wrap text-sm text-slate-100">{view.finalOutput}</p>
        </Section>
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </div>
  );
}
