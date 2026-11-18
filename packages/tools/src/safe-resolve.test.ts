import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeResolve } from './fs-tools';

// TICKET-7: path-confinement hardening — safeResolve must keep every local action inside the approved
// folder (lexical + realpath/symlink canonicalization). Escapes return null (rejected by the tool).
describe('safeResolve path confinement (TICKET-7)', () => {
  let root = '';
  let outside = '';

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'agentos-safe-'));
    root = join(base, 'approved');
    outside = join(base, 'secret');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'sub', 'ok.txt'), 'ok');
    writeFileSync(join(outside, 'creds.env'), 'TOKEN=secret');
  });
  afterAll(() => {
    try { rmSync(resolve(root, '..'), { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('allows paths inside the approved root', () => {
    expect(safeResolve(root, 'sub/ok.txt')).not.toBeNull();
    expect(safeResolve(root, '.')).toBe(root);
  });

  it('rejects ../ traversal (single + deep)', () => {
    expect(safeResolve(root, '../secret/creds.env')).toBeNull();
    expect(safeResolve(root, '../../..')).toBeNull();
    expect(safeResolve(root, 'sub/../../secret')).toBeNull();
  });

  it('rejects absolute-path escapes (POSIX + Windows drive forms)', () => {
    expect(safeResolve(root, '/etc/passwd')).toBeNull();
    expect(safeResolve(root, 'C:/Windows/System32')).toBeNull();
    expect(safeResolve(root, 'C:\\Windows\\System32\\drivers')).toBeNull();
  });

  it('rejects symlink escapes (a link inside root pointing outside)', () => {
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'link'), 'junction'); // junction works without admin on Windows dirs
      linked = true;
    } catch {
      try { symlinkSync(outside, join(root, 'link')); linked = true; } catch { linked = false; }
    }
    if (!linked) return; // symlink creation needs privileges in some envs — skip cleanly
    // The lexical check passes (link is under root) but realpath resolves outside => rejected.
    expect(safeResolve(root, 'link/creds.env')).toBeNull();
  });
});
