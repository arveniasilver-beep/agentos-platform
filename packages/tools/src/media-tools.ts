import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';

/**
 * Media-generation tools (generate_image / generate_speech). The actual provider call is a host
 * callback (the API layer wires it to the workspace's configured provider + encrypted key), so this
 * package stays free of provider/secret concerns. The returned bytes are written into the task
 * sandbox under deliverables/ where the artifact system serves them. Only registered when the host
 * provides the corresponding callback (i.e. a provider is available).
 */

/** A generated binary asset (bytes + file extension). */
export interface GeneratedMedia {
  data: Buffer;
  ext: string;
}
export type GenerateImage = (prompt: string, opts?: { size?: string }) => Promise<GeneratedMedia>;
export type GenerateSpeech = (text: string) => Promise<GeneratedMedia>;

const DELIVERABLES_DIR = 'deliverables';

function slug(s: string, fallback: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || fallback;
}

export interface MediaToolsOptions {
  root: string;
  generateImage?: GenerateImage;
  generateSpeech?: GenerateSpeech;
}

/** Build the media tools whose provider callback is available. */
export function createMediaTools(opts: MediaToolsOptions): RuntimeTool[] {
  const baseDir = join(opts.root, DELIVERABLES_DIR);
  const tools: RuntimeTool[] = [];

  const writeAsset = async (name: string, ext: string, data: Buffer): Promise<{ path: string; bytes: number }> => {
    await mkdir(baseDir, { recursive: true });
    // A short random suffix keeps two same-prompt (or identically-slugifying, e.g. all-non-ASCII)
    // generations from silently clobbering each other.
    const rel = `${name}-${randomBytes(3).toString('hex')}.${ext}`;
    await writeFile(join(baseDir, rel), data);
    return { path: `${DELIVERABLES_DIR}/${rel}`, bytes: data.byteLength };
  };

  if (opts.generateImage) {
    const gen = opts.generateImage;
    tools.push({
      definition: defineTool({
        id: 'generate_image',
        name: 'generate_image',
        description:
          'Generate an image from a text prompt using the workspace\'s configured image provider and ' +
          'save it as a downloadable artifact. Use for illustrations, designs, diagrams-as-art, or any ' +
          'visual the user asks to create. Returns the artifact path.',
        inputSchema: z.object({
          prompt: z.string().min(1).max(4_000),
          // Sizes the default provider (gpt-image-1) accepts: square / portrait / landscape.
          size: z.enum(['1024x1024', '1024x1536', '1536x1024']).optional(),
        }),
        outputSchema: z.object({ path: z.string(), bytes: z.number() }),
        riskLevel: 'low',
        permissions: ['llm.call'],
        timeoutMs: 120_000,
      }),
      run: async (input) => {
        const { prompt, size } = input as { prompt: string; size?: string };
        const asset = await gen(prompt, size ? { size } : undefined);
        return writeAsset(slug(prompt, 'image'), asset.ext, asset.data);
      },
    });
  }

  if (opts.generateSpeech) {
    const gen = opts.generateSpeech;
    tools.push({
      definition: defineTool({
        id: 'generate_speech',
        name: 'generate_speech',
        description:
          "Synthesize speech audio from text using the workspace's configured speech provider and save " +
          'it as a downloadable artifact. Use for voiceovers or read-aloud audio. Returns the artifact path.',
        inputSchema: z.object({ text: z.string().min(1).max(8_000) }),
        outputSchema: z.object({ path: z.string(), bytes: z.number() }),
        riskLevel: 'low',
        permissions: ['llm.call'],
        timeoutMs: 120_000,
      }),
      run: async (input) => {
        const { text } = input as { text: string };
        const asset = await gen(text);
        return writeAsset(slug(text, 'speech'), asset.ext, asset.data);
      },
    });
  }

  return tools;
}
