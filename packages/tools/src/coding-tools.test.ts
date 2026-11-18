import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodingTools } from './coding-tools';

function toolMap(root: string) {
  const tools = createCodingTools({ root, checkpoint: async (l) => ({ ref: 'cp', label: l }), rollback: async (r) => ({ ref: r }) });
  return new Map(tools.map((t) => [t.definition.id, t]));
}

describe('coding tools (edit pipeline + path safety)', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'coding-test-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('write_file creates a file and returns a unified diff', async () => {
    const t = toolMap(root).get('write_file')!;
    const out = (await t.run({ path: 'src/a.ts', content: 'export const a = 1;\n' })) as Record<string, unknown>;
    expect(out.created).toBe(true);
    expect(out.diff).toContain('+export const a = 1;');
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('apply_patch applies a unified diff to an existing file', async () => {
    writeFileSync(join(root, 'f.txt'), 'one\ntwo\nthree\n');
    const tools = toolMap(root);
    const patch = '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
    const out = (await tools.get('apply_patch')!.run({ path: 'f.txt', patch })) as Record<string, unknown>;
    expect(out.applied).toBe(true);
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('apply_patch rejects a patch whose context does not match (strict)', async () => {
    writeFileSync(join(root, 'f.txt'), 'aaa\nbbb\n');
    const tools = toolMap(root);
    const badPatch = '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n xxx\n-yyy\n+zzz\n';
    await expect(tools.get('apply_patch')!.run({ path: 'f.txt', patch: badPatch })).rejects.toThrow(/mismatch/i);
  });

  it('blocks path traversal (escapes the workspace)', async () => {
    const t = toolMap(root).get('write_file')!;
    await expect(t.run({ path: '../escape.txt', content: 'x' })).rejects.toThrow(/escapes/i);
  });

  it('blocks a symlink escape out of the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'coding-outside-'));
    try {
      mkdirSync(join(root, 'sub'));
      // Plant a symlink inside the workspace that points outside it.
      try { symlinkSync(outside, join(root, 'sub', 'link'), 'dir'); } catch { return; /* symlink not permitted on this host */ }
      const t = toolMap(root).get('write_file')!;
      await expect(t.run({ path: 'sub/link/pwned.txt', content: 'x' })).rejects.toThrow(/escapes/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('omits run_* tools when no Docker session is provided', () => {
    const ids = [...toolMap(root).keys()];
    expect(ids).toContain('write_file');
    expect(ids).toContain('apply_patch');
    expect(ids).toContain('checkpoint_workspace');
    expect(ids).not.toContain('run_command');
    expect(ids).not.toContain('run_tests');
  });

  it('provides run_* tools backed by a session when one is supplied', () => {
    const fakeSession = { exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, truncated: false }) };
    const tools = createCodingTools({ root, session: fakeSession as never });
    const ids = tools.map((t) => t.definition.id);
    expect(ids).toContain('run_command');
    expect(ids).toContain('run_tests');
  });
});
