'use client';

import { useState } from 'react';
import { api, ApiError, type Task } from '../lib/api';

/**
 * "Schedule this task" (Manus's "Bir görev planla"): turn an existing task's prompt into a recurring
 * automation in one step. The automations backend already exists — this is the convenience entry that
 * pre-fills name + prompt from the task and lets the user pick a cadence (preset cron or custom).
 */
const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Every weekday at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday at 09:00', cron: '0 9 * * 1' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Custom…', cron: '' },
];

export function ScheduleTaskDialog({
  workspaceId,
  task,
  onClose,
  onScheduled,
}: {
  workspaceId: string;
  task: Task;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [name, setName] = useState(task.title);
  const [presetIdx, setPresetIdx] = useState(0);
  const [customCron, setCustomCron] = useState('0 9 * * *');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustom = PRESETS[presetIdx]?.cron === '';
  const cron = isCustom ? customCron.trim() : (PRESETS[presetIdx]?.cron ?? '');
  // Schedule in the user's local timezone so "09:00" means their morning, not UTC.
  const timezone =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : 'UTC';

  async function save() {
    if (!name.trim() || !cron) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAutomation(workspaceId, {
        name: name.trim(),
        prompt: task.prompt,
        cronExpression: cron,
        timezone,
      });
      onScheduled();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not schedule the task');
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
        className="mt-[12vh] w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Schedule task</h2>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Runs this task’s prompt on a schedule as a new automation ({timezone}).
        </p>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-900 bg-rose-950/30 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <label className="text-xs text-slate-400">
          Name
          <input className={`mt-1 ${field}`} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="mt-3 block text-xs text-slate-400">
          Cadence
          <select
            className={`mt-1 ${field}`}
            value={presetIdx}
            onChange={(e) => setPresetIdx(Number(e.target.value))}
          >
            {PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {isCustom && (
          <label className="mt-3 block text-xs text-slate-400">
            Cron expression (min hour day month weekday)
            <input
              className={`mt-1 font-mono ${field}`}
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              placeholder="0 9 * * *"
            />
          </label>
        )}

        <p className="mt-2 text-xs text-slate-600">
          Schedule: <span className="font-mono text-slate-400">{cron || '—'}</span>
        </p>

        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={busy || !name.trim() || !cron}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
