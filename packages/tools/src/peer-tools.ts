import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { defineTool } from '@agentos/tool-abi';
import { safeResolve } from './fs-tools';
import type { RuntimeTool } from './runtime';

/**
 * Cross-model peer consultation tool (consult_peer). The brain (e.g. DeepSeek) asks a configured peer
 * model (e.g. MiMo-VL) a single question, optionally attaching an image from the task sandbox that the
 * peer reads. This is how a text-only brain "sees": it delegates the image to the multimodal peer and
 * reasons over the returned description. The actual model call is a host callback (the API wires it to
 * the workspace's encrypted peer config), so this package stays free of provider/secret concerns.
 */

export interface PeerImage {
  base64: string;
  mimeType: string;
}
export interface ConsultPeerOpts {
  image?: PeerImage;
  /** Frame the peer as an adversarial critic (used by critique_with_peer) rather than a neutral answerer. */
  critic?: boolean;
}
export type ConsultPeer = (
  question: string,
  opts?: ConsultPeerOpts,
) => Promise<{ answer: string; model: string }>;

export interface PeerToolsOptions {
  /** Task sandbox root — image paths are resolved within it (no traversal escape). */
  root: string;
  consultPeer: ConsultPeer;
  /** Display name of the peer model, woven into the tool description. */
  peerName?: string;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Resolve a sandbox-relative path, blocking ../ traversal, absolutes, AND symlink escapes
 * (safeResolve canonicalizes via realpath — same hardening fs-tools uses on the shared task root). */
function resolveInRoot(root: string, rel: string): string {
  const abs = safeResolve(root, rel);
  if (!abs) throw new Error('path escapes the task sandbox');
  return abs;
}

/** Read a sandbox image into a PeerImage (path/mime/size guarded), or undefined when no path given. */
async function loadImage(root: string, imagePath?: string): Promise<PeerImage | undefined> {
  if (!imagePath) return undefined;
  const abs = resolveInRoot(root, imagePath);
  const mimeType = MIME_BY_EXT[extname(abs).toLowerCase()];
  if (!mimeType) throw new Error('unsupported image type (use png, jpg, webp, or gif)');
  const bytes = await readFile(abs);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${bytes.byteLength} bytes, max ${MAX_IMAGE_BYTES})`);
  }
  return { base64: bytes.toString('base64'), mimeType };
}

export function createPeerTools(opts: PeerToolsOptions): RuntimeTool[] {
  const who = opts.peerName ? `the peer model (${opts.peerName})` : 'a second, peer AI model';
  return [
    {
      definition: defineTool({
        id: 'consult_peer',
        name: 'consult_peer',
        description:
          `Ask ${who} a single question and get its answer back. Use this to (a) get a second, ` +
          'independent opinion on a hard reasoning/decision step, or (b) READ AN IMAGE you cannot see ' +
          'yourself: pass image_path (a file in your workspace) and the peer — if multimodal — will ' +
          'describe/analyse it for you. Be specific in your question. Returns the peer\'s answer text.',
        inputSchema: z.object({
          question: z.string().min(1).max(8_000),
          /** Optional sandbox-relative path to an image for the peer to read (vision). */
          image_path: z.string().max(1_000).optional(),
        }),
        outputSchema: z.object({ answer: z.string(), model: z.string() }),
        riskLevel: 'low',
        permissions: ['llm.call'],
        timeoutMs: 120_000,
      }),
      run: async (input) => {
        const { question, image_path } = input as { question: string; image_path?: string };
        const image = await loadImage(opts.root, image_path);
        const res = await opts.consultPeer(question, image ? { image } : undefined);
        return { answer: res.answer, model: res.model };
      },
    },
    {
      definition: defineTool({
        id: 'critique_with_peer',
        name: 'critique_with_peer',
        description:
          `Submit YOUR draft answer/plan/code to ${who} for an ADVERSARIAL critique — a debate step. ` +
          'The peer is told to disagree where warranted, find errors, gaps, and risks, and propose a ' +
          'stronger alternative. Use before finalising a hard or high-stakes answer, then reconcile its ' +
          'critique into your final response. Optionally focus the critique and/or attach an image.',
        inputSchema: z.object({
          draft: z.string().min(1).max(12_000),
          /** What to scrutinise most (e.g. "correctness", "security", "is the claim supported?"). */
          focus: z.string().max(500).optional(),
          image_path: z.string().max(1_000).optional(),
        }),
        outputSchema: z.object({ critique: z.string(), model: z.string() }),
        riskLevel: 'low',
        permissions: ['llm.call'],
        timeoutMs: 120_000,
      }),
      run: async (input) => {
        const { draft, focus, image_path } = input as { draft: string; focus?: string; image_path?: string };
        const image = await loadImage(opts.root, image_path);
        const prompt =
          (focus ? `Focus your critique on: ${focus}\n\n` : '') +
          `Critique the following draft. Point out errors, weak assumptions, gaps, and risks, then ` +
          `propose a stronger version.\n\n---DRAFT---\n${draft}`;
        const res = await opts.consultPeer(prompt, { critic: true, ...(image ? { image } : {}) });
        return { critique: res.answer, model: res.model };
      },
    },
  ];
}
