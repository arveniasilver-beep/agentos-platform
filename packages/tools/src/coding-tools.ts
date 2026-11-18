import { z } from 'zod';
import { resolve, normalize, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';
import { safeResolve } from './fs-tools';
import { generateUnifiedDiff, applyUnifiedDiff, countDiffLines } from './diff';
import type { SandboxSession } from './sandbox';

/** Bounded prior/new content captured for a diff (larger files skip the inline before/after). */
const DIFF_MAX_BYTES = 30_000;

export interface CodingToolsOptions {
  /** The single real coding-workspace directory on the host (also bind-mounted into the runner at /work). */
  root: string;
  /** Max read size for read_file. */
  maxReadBytes?: number;
  /** Bind-mounted Docker session whose /work IS `root`. When omitted, the run_* tools are not provided. */
  session?: SandboxSession;
  /** Host-side checkpoint primitive (git commit / snapshot). Returns the created ref. */
  checkpoint?: (label: string) => Promise<{ ref: string; label: string }>;
  /** Host-side rollback to a prior checkpoint ref. */
  rollback?: (ref: string) => Promise<{ ref: string }>;
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Detect the package manager from lockfiles in the workspace root (defaults to npm). */
function detectPm(root: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(resolve(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Coding workspace tools (TICKET-CODING). Edit tools (read_file/write_file/apply_patch) operate on the
 * host `root` with the same path-safety canonicalization as fs-tools (traversal + symlink escape blocked).
 * The runner tools (run_*) execute INSIDE the hardened Docker session whose /work is bind-mounted to the
 * SAME `root`, so the agent tests the exact files it edited. checkpoint/rollback delegate to host-side git.
 */
export function createCodingTools(opts: CodingToolsOptions): RuntimeTool[] {
  const root = normalize(resolve(opts.root));
  const maxReadBytes = opts.maxReadBytes ?? 400_000;
  const tools: RuntimeTool[] = [];

  const readContent = async (rel: string): Promise<{ file: string; before: string | undefined }> => {
    const file = safeResolve(root, rel);
    if (!file) throw new Error('path escapes the coding workspace');
    let before: string | undefined;
    if (existsSync(file)) {
      const prev = await readFile(file);
      before = prev.byteLength <= DIFF_MAX_BYTES ? prev.toString('utf8') : undefined;
    }
    return { file, before };
  };

  tools.push({
    definition: defineTool({
      id: 'read_file',
      name: 'read_file',
      description: 'Read a UTF-8 text file from the coding workspace.',
      inputSchema: z.object({ path: z.string().min(1) }),
      outputSchema: z.object({ path: z.string(), content: z.string(), truncated: z.boolean() }),
      riskLevel: 'low',
      permissions: ['fs.read'],
    }),
    run: async (input) => {
      const path = asStr((input as Record<string, unknown>).path) ?? '';
      const file = safeResolve(root, path);
      if (!file) throw new Error('path escapes the coding workspace');
      const buf = await readFile(file);
      return { path, content: buf.subarray(0, maxReadBytes).toString('utf8'), truncated: buf.byteLength > maxReadBytes };
    },
  });

  tools.push({
    definition: defineTool({
      id: 'write_file',
      name: 'write_file',
      description:
        'Create or overwrite a UTF-8 file in the coding workspace with full content. Returns a unified ' +
        'diff of the change for review. For surgical edits to an existing file, prefer apply_patch.',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      outputSchema: z.object({
        path: z.string(), bytes: z.number(), created: z.boolean(),
        diff: z.string(), changedLines: z.number(),
        before: z.string().optional(), after: z.string().optional(),
      }),
      riskLevel: 'medium',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { path, content } = input as { path: string; content: string };
      const { file, before } = await readContent(path);
      const diff = generateUnifiedDiff(before ?? '', content, path);
      await mkdir(dirname(file), { recursive: true });
      const created = !existsSync(file);
      await writeFile(file, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      const after = bytes <= DIFF_MAX_BYTES ? content : undefined;
      return {
        path, bytes, created, diff, changedLines: countDiffLines(diff),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      };
    },
  });

  tools.push({
    definition: defineTool({
      id: 'apply_patch',
      name: 'apply_patch',
      description:
        'Apply a unified diff (the patch) to an existing file in the coding workspace. The patch is ' +
        'validated strictly against the current file (context and removed lines must match) before writing.',
      inputSchema: z.object({ path: z.string().min(1), patch: z.string().min(1) }),
      outputSchema: z.object({
        path: z.string(), applied: z.boolean(), created: z.boolean(), diff: z.string(), changedLines: z.number(),
        before: z.string().optional(), after: z.string().optional(),
      }),
      riskLevel: 'medium',
      permissions: ['fs.write'],
    }),
    run: async (input) => {
      const { path, patch } = input as { path: string; patch: string };
      const file = safeResolve(root, path);
      if (!file) throw new Error('path escapes the coding workspace');
      const prev = existsSync(file) ? (await readFile(file)).toString('utf8') : '';
      const next = applyUnifiedDiff(prev, patch); // throws on context mismatch (strict)
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, next, 'utf8');
      const before = Buffer.byteLength(prev, 'utf8') <= DIFF_MAX_BYTES ? prev : undefined;
      const after = Buffer.byteLength(next, 'utf8') <= DIFF_MAX_BYTES ? next : undefined;
      return {
        path, applied: true, created: prev === '', diff: patch, changedLines: countDiffLines(patch),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      };
    },
  });

  // --- runner tools (only when a bind-mounted Docker session is available) -----------------------
  if (opts.session) {
    const session = opts.session;
    const runDef = (id: string, description: string) =>
      defineTool({
        id, name: id, description,
        inputSchema: z.object({ command: z.string().min(1).max(10_000) }),
        outputSchema: z.object({ command: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number(), timedOut: z.boolean(), truncated: z.boolean() }),
        riskLevel: 'high',
        permissions: ['shell.exec'],
        timeoutMs: 120_000,
      });
    const runWith = async (command: string) => ({ command, ...(await session.exec(command)) });

    tools.push({
      definition: runDef('run_command', 'Run a shell command inside the coding workspace runner (Docker, /work = the workspace). Network is disabled by default.'),
      run: (input) => runWith((input as { command: string }).command),
    });

    const scripted = (id: string, verb: string, desc: string): RuntimeTool => ({
      definition: defineTool({
        id, name: id, description: desc,
        inputSchema: z.object({ command: z.string().optional() }),
        outputSchema: z.object({ command: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number(), timedOut: z.boolean(), truncated: z.boolean() }),
        riskLevel: 'medium',
        permissions: ['shell.exec'],
        timeoutMs: 180_000,
      }),
      run: (input) => {
        const explicit = asStr((input as Record<string, unknown>).command);
        const pm = detectPm(root);
        const command = explicit ?? (verb === 'test' ? `${pm} test` : `${pm} run ${verb}`);
        return runWith(command);
      },
    });
    tools.push(scripted('run_tests', 'test', 'Run the project test suite inside the coding workspace runner.'));
    tools.push(scripted('run_lint', 'lint', 'Run the project linter inside the coding workspace runner.'));
    tools.push(scripted('run_build', 'build', 'Run the project build inside the coding workspace runner.'));
  }

  // --- checkpoint / rollback (host-side git or snapshot) -----------------------------------------
  if (opts.checkpoint) {
    const checkpoint = opts.checkpoint;
    tools.push({
      definition: defineTool({
        id: 'checkpoint_workspace',
        name: 'checkpoint_workspace',
        description: 'Create a restorable checkpoint of the coding workspace (git commit). Safe; no approval needed.',
        inputSchema: z.object({ label: z.string().max(200).optional() }),
        outputSchema: z.object({ ref: z.string(), label: z.string(), created: z.boolean() }),
        riskLevel: 'low',
        permissions: [],
      }),
      run: async (input) => {
        const label = asStr((input as Record<string, unknown>).label) ?? 'checkpoint';
        const r = await checkpoint(label);
        return { ref: r.ref, label: r.label, created: true };
      },
    });
  }
  if (opts.rollback) {
    const rollback = opts.rollback;
    tools.push({
      definition: defineTool({
        id: 'rollback_workspace',
        name: 'rollback_workspace',
        description: 'Roll the coding workspace back to a prior checkpoint ref (DESTRUCTIVE: discards uncommitted changes).',
        inputSchema: z.object({ ref: z.string().min(1) }),
        outputSchema: z.object({ ref: z.string(), restored: z.boolean() }),
        // Destructive — approval-gated by default risk; policy also routes rollback to require_approval.
        riskLevel: 'high',
        permissions: [],
      }),
      run: async (input) => {
        const ref = (input as { ref: string }).ref;
        const r = await rollback(ref);
        return { ref: r.ref, restored: true };
      },
    });
  }

  return tools;
}
