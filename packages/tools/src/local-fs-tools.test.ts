import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalFsTools, type ApprovedFolder } from './index';

describe('local-fs (My Computer) tools', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mycomp-'));
    writeFileSync(join(root, 'notes.txt'), 'hello world');
    mkdirSync(join(root, 'sub'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const tools = (folders: ApprovedFolder[]) => {
    const t = createLocalFsTools(folders);
    return (id: string) => t.find((x) => x.definition.id === id)!;
  };

  it('returns no tools when no folder is approved', () => {
    expect(createLocalFsTools([])).toEqual([]);
  });

  it('lists approved folders + lists + reads inside the approved root', async () => {
    const get = tools([{ label: 'docs', root, writable: false }]);
    expect(await get('local_list_folders').run({})).toEqual({ folders: [{ label: 'docs', writable: false }] });
    const list = (await get('local_list').run({ folder: 'docs', path: '.' })) as { entries: { name: string }[] };
    expect(list.entries.map((e) => e.name).sort()).toEqual(['notes.txt', 'sub']);
    expect(await get('local_read').run({ folder: 'docs', path: 'notes.txt' })).toEqual({
      path: 'notes.txt',
      content: 'hello world',
      truncated: false,
    });
  });

  it('refuses an unknown folder label and a path that escapes the root', async () => {
    const get = tools([{ label: 'docs', root, writable: true }]);
    await expect(get('local_read').run({ folder: 'nope', path: 'x' })).rejects.toThrow(/unknown folder/);
    await expect(get('local_read').run({ folder: 'docs', path: '../../etc/passwd' })).rejects.toThrow(/escapes/);
  });

  it('writes only into a writable folder, and refuses a read-only one', async () => {
    const writable = tools([{ label: 'docs', root, writable: true }]);
    const res = (await writable('local_write').run({ folder: 'docs', path: 'sub/new.txt', content: 'data' })) as {
      path: string;
      bytes: number;
    };
    expect(res.bytes).toBe(4);
    expect(readFileSync(join(root, 'sub', 'new.txt'), 'utf8')).toBe('data');

    const readonly = tools([{ label: 'docs', root, writable: false }]);
    await expect(readonly('local_write').run({ folder: 'docs', path: 'x.txt', content: 'y' })).rejects.toThrow(/read-only/);
    expect(existsSync(join(root, 'x.txt'))).toBe(false);
  });

  it('local_write is high-risk + approval-gated', () => {
    const t = createLocalFsTools([{ label: 'docs', root, writable: true }]);
    const w = t.find((x) => x.definition.id === 'local_write')!;
    expect(w.definition.riskLevel).toBe('high');
    expect(w.definition.approvalRequired).toBe(true);
  });
});
