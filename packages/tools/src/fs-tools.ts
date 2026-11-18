import { z } from 'zod';
import { resolve, normalize, sep, dirname } from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

function within(root: string, target: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(rootWithSep);
}

/** realpath of the deepest existing ancestor of `p` (so to-be-created files canonicalize too). */
function realpathOfDeepestExisting(p: string): string {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) return realpathSync.native(cur);
    const parent = dirname(cur);
    if (parent === cur) return realpathSync.native(parent);
    cur = parent;
  }
}

/**
 * Resolve a relative path inside `root`, returning null on any escape. Checks both the lexical
 * path AND the canonical (realpath) path of the deepest existing ancestor, so a symlink planted
 * inside the folder that points outside it cannot be used to read/write host files.
 */
export function safeResolve(root: string, rel: string): string | null {
  const target = normalize(resolve(root, rel));
  if (!within(root, target)) return null;
  try {
    const realRoot = realpathSync.native(root);
    const realTarget = realpathOfDeepestExisting(target);
    if (!within(realRoot, realTarget)) return null;
  } catch {
    return null;
  }
  return target;
}

/** Cap on the prior/new content captured for a fs_write diff (larger files skip the diff). */
const DIFF_MAX_BYTES = 30_000;

export interface FsToolsOptions {
  /** Absolute path to the single approved folder the agent may touch. */
  root: string;
  /** Allow writes (default false — read-only, the MVP default). */
  writable?: boolean;
  maxBytes?: number;
}

/** Filesystem tools scoped to one approved folder (path-canonicalized, traversal-blocked). */
export function createFsTools(opts: FsToolsOptions): RuntimeTool[] {
  const root = normalize(resolve(opts.root));
  const writable = opts.writable ?? false;
  const maxBytes = opts.maxBytes ?? 200_000;

  const fsRead: RuntimeTool = {
    definition: defineTool({
      id: 'fs_read',
      name: 'fs_read',
      description: 'Read a UTF-8 text file from the approved folder.',
      inputSchema: z.object({ path: z.string().min(1) }),
      outputSchema: z.object({ path: z.string(), content: z.string(), truncated: z.boolean() }),
      riskLevel: 'low',
      permissions: ['fs.read'],
    }),
    run: async (input) => {
      const { path } = input as { path: string };
      const file = safeResolve(root, path);
      if (!file) throw new Error('path escapes the approved folder');
      const buf = await readFile(file);
      const truncated = buf.byteLength > maxBytes;
      return { path, content: buf.subarray(0, maxBytes).toString('utf8'), truncated };
    },
  };

  const fsList: RuntimeTool = {
    definition: defineTool({
      id: 'fs_list',
      name: 'fs_list',
      description: 'List the entries of a directory inside the approved folder.',
      inputSchema: z.object({ path: z.string().default('.') }),
      outputSchema: z.object({
        path: z.string(),
        entries: z.array(z.object({ name: z.string(), kind: z.enum(['file', 'dir', 'other']) })),
      }),
      riskLevel: 'low',
      permissions: ['fs.read'],
    }),
    run: async (input) => {
      const { path } = input as { path: string };
      const dir = safeResolve(root, path);
      if (!dir) throw new Error('path escapes the approved folder');
      const dirents = await readdir(dir, { withFileTypes: true });
      const entries = dirents.map((d) => ({
        name: d.name,
        kind: d.isDirectory() ? ('dir' as const) : d.isFile() ? ('file' as const) : ('other' as const),
      }));
      return { path, entries };
    },
  };

  if (!writable) {
    return [fsRead, fsList];
  }

  const fsWrite: RuntimeTool = {
    definition: defineTool({
      id: 'fs_write',
      name: 'fs_write',
      description: 'Write a UTF-8 text file in the approved folder (creates parent directories).',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      outputSchema: z.object({
        path: z.string(),
        bytes: z.number(),
        // Whether this created a new file (vs overwrote one), plus the prior/new content (bounded)
        // so the UI can render a before/after diff of the edit. Omitted when too large to diff.
        created: z.boolean(),
        before: z.string().optional(),
        after: z.string().optional(),
      }),
      riskLevel: 'medium',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { path, content } = input as { path: string; content: string };
      const file = safeResolve(root, path);
      if (!file) throw new Error('path escapes the approved folder');
      // Capture the prior content (bounded) before overwriting, so the UI can show the diff.
      const existed = existsSync(file);
      let before: string | undefined;
      if (existed) {
        try {
          const prev = await readFile(file);
          if (prev.byteLength <= DIFF_MAX_BYTES) before = prev.toString('utf8');
        } catch {
          // unreadable prior content (e.g. a dir) — just skip the diff
        }
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      const after = bytes <= DIFF_MAX_BYTES ? content : undefined;
      return {
        path,
        bytes,
        created: !existed,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      };
    },
  };

  return [fsRead, fsList, fsWrite];
}
