'use client';

/**
 * Before/after line diff for an fs_write edit (the "Manus's computer" file-diff view). The agent's
 * fs_write tool returns the prior + new content (bounded); this renders an LCS line diff so the user
 * sees exactly what changed, instead of a raw JSON blob.
 */

export interface FsWriteOutput {
  path: string;
  created: boolean;
  before?: string;
  after?: string;
}

/** Narrow an unknown tool_result output to the fs_write diff shape (or null if it isn't one). */
export function asFsWriteOutput(output: unknown): FsWriteOutput | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.created !== 'boolean') return null;
  if (o.before !== undefined && typeof o.before !== 'string') return null;
  if (o.after !== undefined && typeof o.after !== 'string') return null;
  return { path: o.path, created: o.created, before: o.before as string | undefined, after: o.after as string | undefined };
}

type Line = { type: 'same' | 'add' | 'del'; text: string };

// Guard against a pathological O(n*m) LCS on huge inputs (content is already ≤30KB, but a file that
// is all newlines could still be many lines). Above this product we fall back to a block diff.
const MAX_LCS_CELLS = 2_000_000;

function diffLines(before: string, after: string): Line[] {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) {
    return [...a.map((t) => ({ type: 'del' as const, text: t })), ...b.map((t) => ({ type: 'add' as const, text: t }))];
  }
  // LCS length table (suffix DP).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++]! });
  while (j < m) out.push({ type: 'add', text: b[j++]! });
  return out;
}

const ROW: Record<Line['type'], string> = {
  same: 'text-slate-400',
  add: 'bg-emerald-950/40 text-emerald-300',
  del: 'bg-rose-950/40 text-rose-300',
};
const SIGN: Record<Line['type'], string> = { same: ' ', add: '+', del: '-' };

export function FileDiff({ path, created, before, after }: FsWriteOutput) {
  // Nothing diffable (file too large to capture) — just note the write.
  if (after === undefined && before === undefined) {
    return (
      <p className="mt-1.5 text-xs text-slate-500">
        Wrote <span className="font-mono text-slate-400">{path}</span> (too large to preview a diff).
      </p>
    );
  }
  const lines = diffLines(before ?? '', after ?? '');
  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;

  return (
    <div className="mt-1.5">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="font-mono text-slate-300">{path}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">
          {created ? 'new file' : 'edited'}
        </span>
        {added > 0 && <span className="text-emerald-400">+{added}</span>}
        {removed > 0 && <span className="text-rose-400">−{removed}</span>}
      </div>
      <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950 text-xs leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={`px-2 ${ROW[l.type]}`}>
            <span className="select-none opacity-60">{SIGN[l.type]} </span>
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}
