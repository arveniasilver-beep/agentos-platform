import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistryExecutor } from './runtime';
import { createFsTools, safeResolve } from './fs-tools';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aos-tools-'));
  await writeFile(join(root, 'hello.txt'), 'hello world', 'utf8');
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('safeResolve', () => {
  it('blocks traversal outside the root', () => {
    expect(safeResolve(root, '../escape')).toBeNull();
    expect(safeResolve(root, 'inside.txt')).not.toBeNull();
  });
});

describe('fs tools (read-only)', () => {
  it('reads and lists, but exposes no write tool', async () => {
    const exec = new ToolRegistryExecutor(createFsTools({ root }));
    expect(exec.list().map((d) => d.name).sort()).toEqual(['fs_list', 'fs_read']);

    const read = await exec.execute('fs_read', { path: 'hello.txt' });
    expect(read.ok).toBe(true);
    expect((read.output as { content: string }).content).toBe('hello world');

    const list = await exec.execute('fs_list', { path: '.' });
    expect(list.ok).toBe(true);
    expect((list.output as { entries: { name: string }[] }).entries.some((e) => e.name === 'hello.txt')).toBe(true);
  });

  it('refuses to read outside the approved folder', async () => {
    const exec = new ToolRegistryExecutor(createFsTools({ root }));
    const r = await exec.execute('fs_read', { path: '../../etc/passwd' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('escapes the approved folder');
  });

  it('refuses to follow a symlink that escapes the approved folder', async () => {
    // Plant a symlink inside root pointing outside it. Skip if the OS blocks symlink creation
    // (e.g. unprivileged Windows).
    const outside = await mkdtemp(join(tmpdir(), 'aos-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
    let linked = false;
    try {
      await symlink(outside, join(root, 'escape-link'), 'dir');
      linked = true;
    } catch {
      /* symlink not permitted here */
    }
    try {
      if (!linked) {
        console.warn('fs symlink test: symlink creation not permitted, skipping');
        return;
      }
      const exec = new ToolRegistryExecutor(createFsTools({ root, writable: true }));
      const read = await exec.execute('fs_read', { path: 'escape-link/secret.txt' });
      expect(read.ok).toBe(false);
      const list = await exec.execute('fs_list', { path: 'escape-link' });
      expect(list.ok).toBe(false);
      const write = await exec.execute('fs_write', { path: 'escape-link/pwn.txt', content: 'x' });
      expect(write.ok).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('fs tools (writable)', () => {
  it('writes a file and reads it back', async () => {
    const exec = new ToolRegistryExecutor(createFsTools({ root, writable: true }));
    expect(exec.list().map((d) => d.name)).toContain('fs_write');

    const write = await exec.execute('fs_write', { path: 'sub/new.txt', content: 'written' });
    expect(write.ok).toBe(true);
    expect((write.output as { bytes: number }).bytes).toBe(7);

    const read = await exec.execute('fs_read', { path: 'sub/new.txt' });
    expect((read.output as { content: string }).content).toBe('written');
  });

  it('reports created=true with no before on a new file, and before/after on overwrite', async () => {
    const exec = new ToolRegistryExecutor(createFsTools({ root, writable: true }));

    const create = await exec.execute('fs_write', { path: 'diff/a.txt', content: 'v1\nline2\n' });
    const c = create.output as { created: boolean; before?: string; after?: string };
    expect(c.created).toBe(true);
    expect(c.before).toBeUndefined();
    expect(c.after).toBe('v1\nline2\n');

    const overwrite = await exec.execute('fs_write', { path: 'diff/a.txt', content: 'v2\nline2\n' });
    const o = overwrite.output as { created: boolean; before?: string; after?: string };
    expect(o.created).toBe(false);
    expect(o.before).toBe('v1\nline2\n');
    expect(o.after).toBe('v2\nline2\n');
  });

  it('omits before/after for files larger than the diff cap', async () => {
    const exec = new ToolRegistryExecutor(createFsTools({ root, writable: true }));
    const big = 'x'.repeat(40_000);
    const r = await exec.execute('fs_write', { path: 'diff/big.txt', content: big });
    const out = r.output as { created: boolean; before?: string; after?: string; bytes: number };
    expect(out.bytes).toBe(40_000);
    expect(out.after).toBeUndefined(); // too large to diff
  });
});
