import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { defineTool } from '@agentos/tool-abi';
import { safeResolve } from './fs-tools';
import type { RuntimeTool } from './runtime';

/** Deploy a named site (slug + files); returns the public URL. Implemented by the API, which routes
 * to the configured backend (Netlify or the self-hosted VPS server — the latter needs the slug). */
export type PublishSite = (input: { slug: string; files: { path: string; content: Buffer }[] }) => Promise<{ url: string }>;

export interface HostingToolsOptions {
  /** Task sandbox root; the published directory must resolve inside it. */
  root: string;
  publishSite: PublishSite;
}

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Recursively collect files under `dir` as site-root-relative paths (bounded). */
async function collectFiles(dir: string): Promise<{ path: string; content: Buffer }[]> {
  const out: { path: string; content: Buffer }[] = [];
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(current, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        if (out.length >= MAX_FILES) throw new Error(`too many files (max ${MAX_FILES})`);
        const content = await readFile(abs);
        total += content.byteLength;
        if (total > MAX_TOTAL_BYTES) throw new Error('site is too large to publish (max 25 MB)');
        out.push({ path: relative(dir, abs).split('\\').join('/'), content });
      }
    }
  };
  await walk(dir);
  return out;
}

/** Publish a generated static website (e.g. a generate_website output dir) to a public URL. */
export function createHostingTools(opts: HostingToolsOptions): RuntimeTool[] {
  const publish: RuntimeTool = {
    definition: defineTool({
      id: 'publish_site',
      name: 'publish_site',
      description:
        'Publish a static website folder (e.g. the directory produced by generate_website, like ' +
        '"deliverables/my-site") to the public internet and return its live shareable URL. Re-publishing ' +
        'the same workspace keeps the same URL.',
      inputSchema: z.object({ dir: z.string().min(1).max(1000) }),
      outputSchema: z.object({ url: z.string(), files: z.number() }),
      // Publishing to the public internet is an outward, public action → high-risk + approval-gated.
      riskLevel: 'high',
      approvalRequired: true,
      permissions: ['fs.read', 'net.request'],
      timeoutMs: 120_000,
    }),
    run: async (input) => {
      const { dir } = input as { dir: string };
      const abs = safeResolve(opts.root, dir);
      if (!abs) throw new Error('the directory escapes the task sandbox');
      const dirStat = await stat(abs).then((s) => s.isDirectory()).catch(() => false);
      if (!dirStat) throw new Error(`no such directory in the task: ${dir}`);
      const files = await collectFiles(abs);
      if (files.length === 0) throw new Error('the directory has no files to publish');
      if (!files.some((f) => f.path === 'index.html')) {
        throw new Error('a website needs an index.html at the top of the folder');
      }
      // Stable site slug from the folder name (DNS-label safe) so re-publishing keeps the same URL
      // and the self-hosted backend (which routes by slug) can address it.
      const slug =
        basename(dir)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 63) || 'site';
      const { url } = await opts.publishSite({ slug, files });
      return { url, files: files.length };
    },
  };
  return [publish];
}
