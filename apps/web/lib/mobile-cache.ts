import type { SyncSnapshot } from './api';

// Minimal offline cache for the mobile panel (TICKET-6). SECURITY: stores ONLY the already-minimal,
// secret-free sync snapshot (task status, approval ids, artifact names, run statuses) — never tokens,
// cookies, prompts, args, outputs, or secrets. TTL'd; cleared on 401 / revoked / logout.

const KEY = 'agentos.m.snapshot.v1';
const FRESH_MS = 60_000; // a cached snapshot older than this is shown but flagged stale

interface Cached {
  workspaceId: string;
  at: number;
  snap: SyncSnapshot;
}

export function cacheSnapshot(workspaceId: string, snap: SyncSnapshot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ workspaceId, at: Date.now(), snap } satisfies Cached));
  } catch {
    /* storage unavailable (private mode) — cache is best-effort */
  }
}

/** Read the cached snapshot for this workspace, with its age + staleness, or null. */
export function readCachedSnapshot(workspaceId: string): { snap: SyncSnapshot; ageMs: number; stale: boolean } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Cached;
    if (o.workspaceId !== workspaceId || !o.snap) return null;
    const ageMs = Date.now() - o.at;
    return { snap: o.snap, ageMs, stale: ageMs > FRESH_MS };
  } catch {
    return null;
  }
}

/** Drop the cache — call on 401 / revoked / logout so no workspace data lingers. */
export function clearSnapshotCache(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
