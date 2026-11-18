/**
 * Minimal, dependency-free unified-diff generate + apply (TICKET-CODING). Line-based; `split('\n')`
 * round-trips exactly through `join('\n')` so a trailing newline is preserved as a trailing element.
 * `applyUnifiedDiff` is STRICT — it verifies every context and removed line matches the source at the
 * hunk position and throws on any mismatch (no fuzzy apply), so a patch can never silently corrupt a file.
 */

type Op = { t: 'eq' | 'del' | 'ins'; s: string };

/** LCS line diff: equal / delete (only in old) / insert (only in new), in source order. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', s: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { ops.push({ t: 'del', s: a[i]! }); i++; }
    else { ops.push({ t: 'ins', s: b[j]! }); j++; }
  }
  while (i < n) { ops.push({ t: 'del', s: a[i]! }); i++; }
  while (j < m) { ops.push({ t: 'ins', s: b[j]! }); j++; }
  return ops;
}

/** Generate a unified diff (with `context` lines of context) for old → new. Empty string if identical. */
export function generateUnifiedDiff(oldText: string, newText: string, label = 'file', context = 3): string {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = diffLines(a, b);

  type Anno = Op & { oldNo: number; newNo: number };
  const annotated: Anno[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    annotated.push({ ...op, oldNo, newNo });
    if (op.t === 'eq') { oldNo++; newNo++; }
    else if (op.t === 'del') { oldNo++; }
    else { newNo++; }
  }

  const changeIdx = annotated.map((o, i) => (o.t !== 'eq' ? i : -1)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return '';
  const hunks: Array<{ start: number; end: number }> = [];
  for (const idx of changeIdx) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(annotated.length - 1, idx + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last.end + 1) last.end = Math.max(last.end, hi);
    else hunks.push({ start: lo, end: hi });
  }

  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  for (const h of hunks) {
    const slice = annotated.slice(h.start, h.end + 1);
    const oldLines = slice.filter((o) => o.t !== 'ins');
    const newLines = slice.filter((o) => o.t !== 'del');
    const oldStart = oldLines.length ? oldLines[0]!.oldNo : (slice[0]?.oldNo ?? 1);
    const newStart = newLines.length ? newLines[0]!.newNo : (slice[0]?.newNo ?? 1);
    out.push(`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`);
    for (const o of slice) out.push((o.t === 'eq' ? ' ' : o.t === 'del' ? '-' : '+') + o.s);
  }
  return out.join('\n') + '\n';
}

/** Count the number of added + removed lines in a unified diff (for the large-diff gate). */
export function countDiffLines(patch: string): number {
  let count = 0;
  for (const line of patch.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) count++;
  }
  return count;
}

interface Hunk { oldStart: number; lines: string[] }

function parseHunks(patch: string): Hunk[] {
  const lines = patch.split('\n');
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (m) { cur = { oldStart: Number(m[1]), lines: [] }; hunks.push(cur); continue; }
    if (cur && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+'))) cur.lines.push(line);
  }
  return hunks;
}

/** Apply a unified diff to `oldText`, STRICTLY validating context/removed lines. Throws on mismatch. */
export function applyUnifiedDiff(oldText: string, patch: string): string {
  const src = oldText.split('\n');
  const hunks = parseHunks(patch);
  if (hunks.length === 0) throw new Error('patch contains no hunks');
  const out: string[] = [];
  let cursor = 0; // 0-based index into src
  for (const h of hunks) {
    const target = h.oldStart - 1; // 1-based → 0-based
    if (target < cursor) throw new Error(`patch hunks out of order at line ${h.oldStart}`);
    while (cursor < target) {
      if (cursor >= src.length) throw new Error('patch hunk starts past end of file');
      out.push(src[cursor++]!);
    }
    for (const pl of h.lines) {
      const kind = pl[0];
      const text = pl.slice(1);
      if (kind === ' ') {
        if (src[cursor] !== text) throw new Error(`context mismatch at line ${cursor + 1}: expected "${src[cursor]}" got context "${text}"`);
        out.push(src[cursor++]!);
      } else if (kind === '-') {
        if (src[cursor] !== text) throw new Error(`removed-line mismatch at line ${cursor + 1}: expected "${src[cursor]}" got "-${text}"`);
        cursor++;
      } else if (kind === '+') {
        out.push(text);
      }
    }
  }
  while (cursor < src.length) out.push(src[cursor++]!);
  return out.join('\n');
}
