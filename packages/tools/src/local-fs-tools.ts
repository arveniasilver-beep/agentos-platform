import { z } from 'zod';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { defineTool } from '@agentos/tool-abi';
import { safeResolve } from './fs-tools';
import type { RuntimeTool } from './runtime';

/**
 * "My Computer" tools: operate on host folders the USER explicitly approved (Manus-style). Each path is
 * resolved INSIDE the chosen approved folder via safeResolve (realpath, symlink-safe → no escape).
 * Reads are medium-risk; writes are high-risk (approval-gated) and only allowed for folders the user
 * marked writable. The API layer only provisions these when ENABLE_LOCAL_FS is on (local/desktop).
 */
export interface ApprovedFolder {
  label: string;
  root: string;
  writable: boolean;
}

const MAX_READ_BYTES = 400_000;

export function createLocalFsTools(folders: ApprovedFolder[]): RuntimeTool[] {
  if (folders.length === 0) return [];
  const byLabel = new Map(folders.map((f) => [f.label, f]));
  const labels = folders.map((f) => f.label).join(', ');

  const pick = (label: string): ApprovedFolder => {
    const f = byLabel.get(label);
    if (!f) throw new Error(`unknown folder "${label}" — call local_list_folders first (have: ${labels})`);
    return f;
  };
  const resolveIn = (f: ApprovedFolder, rel: string): string => {
    const abs = safeResolve(f.root, rel || '.');
    if (!abs) throw new Error(`path escapes the approved folder "${f.label}"`);
    return abs;
  };

  const listFolders: RuntimeTool = {
    definition: defineTool({
      id: 'local_list_folders',
      name: 'local_list_folders',
      description:
        'List the local folders on this computer the user approved you to work in. Returns each ' +
        "folder's label (use it in the other local_* tools) and whether it is writable. Call this first.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        folders: z.array(z.object({ label: z.string(), writable: z.boolean() })),
      }),
      riskLevel: 'low',
      permissions: ['fs.read'],
    }),
    run: () => Promise.resolve({ folders: folders.map((f) => ({ label: f.label, writable: f.writable })) }),
  };

  const localList: RuntimeTool = {
    definition: defineTool({
      id: 'local_list',
      name: 'local_list',
      description: 'List the entries of a directory inside an approved local folder.',
      inputSchema: z.object({ folder: z.string().min(1), path: z.string().max(1000).default('.') }),
      outputSchema: z.object({
        entries: z.array(z.object({ name: z.string(), type: z.enum(['file', 'dir']), size: z.number() })),
      }),
      riskLevel: 'medium',
      permissions: ['fs.read'],
      timeoutMs: 20_000,
    }),
    run: async (input) => {
      const { folder, path } = input as { folder: string; path: string };
      const abs = resolveIn(pick(folder), path);
      const names = await readdir(abs);
      const entries = await Promise.all(
        names.slice(0, 500).map(async (name) => {
          const s = await stat(join(abs, name)).catch(() => null);
          return { name, type: s?.isDirectory() ? ('dir' as const) : ('file' as const), size: s?.size ?? 0 };
        }),
      );
      return { entries };
    },
  };

  const localRead: RuntimeTool = {
    definition: defineTool({
      id: 'local_read',
      name: 'local_read',
      description: 'Read a UTF-8 text file inside an approved local folder (truncated if very large).',
      inputSchema: z.object({ folder: z.string().min(1), path: z.string().min(1).max(1000) }),
      outputSchema: z.object({ path: z.string(), content: z.string(), truncated: z.boolean() }),
      riskLevel: 'medium',
      permissions: ['fs.read'],
      timeoutMs: 20_000,
    }),
    run: async (input) => {
      const { folder, path } = input as { folder: string; path: string };
      const abs = resolveIn(pick(folder), path);
      const buf = await readFile(abs);
      const truncated = buf.byteLength > MAX_READ_BYTES;
      return { path, content: buf.subarray(0, MAX_READ_BYTES).toString('utf8'), truncated };
    },
  };

  const localWrite: RuntimeTool = {
    definition: defineTool({
      id: 'local_write',
      name: 'local_write',
      description:
        'Write a UTF-8 text file inside an approved local folder. Only works for folders the user marked ' +
        'writable, and (being a change to real files on the user\'s computer) requires approval.',
      inputSchema: z.object({
        folder: z.string().min(1),
        path: z.string().min(1).max(1000),
        content: z.string().max(2_000_000),
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number() }),
      riskLevel: 'high',
      approvalRequired: true,
      permissions: ['fs.write'],
      timeoutMs: 20_000,
    }),
    run: async (input) => {
      const { folder, path, content } = input as { folder: string; path: string; content: string };
      const f = pick(folder);
      if (!f.writable) throw new Error(`folder "${f.label}" is read-only — the user has not allowed writes`);
      const abs = resolveIn(f, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return { path, bytes: Buffer.byteLength(content, 'utf8') };
    },
  };

  return [listFolders, localList, localRead, localWrite];
}
