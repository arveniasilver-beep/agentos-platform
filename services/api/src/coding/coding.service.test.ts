import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingWorkspaceService } from './coding.service';

function gitAvailable(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('CodingWorkspaceService (checkpoint / rollback)', () => {
  let base = '';
  const prev = process.env.CODING_WORKSPACE_ROOT;
  beforeAll(() => { base = mkdtempSync(join(tmpdir(), 'coding-ws-')); process.env.CODING_WORKSPACE_ROOT = base; });
  afterAll(() => { if (prev === undefined) delete process.env.CODING_WORKSPACE_ROOT; else process.env.CODING_WORKSPACE_ROOT = prev; rmSync(base, { recursive: true, force: true }); });

  it('checkpoints an edit and rolls back to it (git or snapshot fallback)', async () => {
    const svc = new CodingWorkspaceService();
    const { dir } = await svc.ensureWorkspace('ws1', 'proj1');
    const file = join(dir, 'app.txt');
    writeFileSync(file, 'v1\n');
    const cp = await svc.checkpoint(dir, 'first');
    expect(cp.ref).toBeTruthy();
    // Change the file, then roll back to the checkpoint → original content restored.
    writeFileSync(file, 'v2-broken\n');
    await svc.rollback(dir, cp.ref);
    expect(readFileSync(file, 'utf8')).toBe('v1\n');
  });

  it('checkpoint does NOT run repo git hooks (hooks bypassed)', async () => {
    if (!gitAvailable()) return; // hook bypass only applies to the git path
    const svc = new CodingWorkspaceService();
    const { dir, git } = await svc.ensureWorkspace('ws2', 'proj2');
    if (!git) return;
    // Plant a pre-commit hook that would create a marker (and fail) IF it ran.
    const marker = join(dir, 'HOOK_RAN');
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\nexit 1\n`);
    try { chmodSync(hook, 0o755); } catch { /* windows: no exec bit needed */ }
    writeFileSync(join(dir, 'x.txt'), 'data\n');
    // Must succeed despite the failing hook (proves bypass), and the marker must be absent.
    const cp = await svc.checkpoint(dir, 'with-hook');
    expect(cp.ref).toBeTruthy();
    expect(existsSync(marker)).toBe(false);
  });
});
