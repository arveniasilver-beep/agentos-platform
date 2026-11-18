import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaTools } from './index';

describe('media tools', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'media-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('only registers tools whose provider callback is supplied', () => {
    expect(createMediaTools({ root }).map((t) => t.definition.id)).toEqual([]);
    expect(
      createMediaTools({ root, generateImage: async () => ({ data: Buffer.from('x'), ext: 'png' }) }).map(
        (t) => t.definition.id,
      ),
    ).toEqual(['generate_image']);
    const both = createMediaTools({
      root,
      generateImage: async () => ({ data: Buffer.from('x'), ext: 'png' }),
      generateSpeech: async () => ({ data: Buffer.from('y'), ext: 'mp3' }),
    });
    expect(both.map((t) => t.definition.id).sort()).toEqual(['generate_image', 'generate_speech']);
  });

  it('generate_image writes the returned bytes into deliverables/', async () => {
    const tools = createMediaTools({
      root,
      generateImage: async (prompt) => ({ data: Buffer.from(`IMG:${prompt}`), ext: 'png' }),
    });
    const tool = tools.find((t) => t.definition.id === 'generate_image')!;
    const res = (await tool.run({ prompt: 'a red cube', size: '1024x1024' })) as { path: string; bytes: number };
    expect(res.path).toMatch(/^deliverables\/a-red-cube-[0-9a-f]{6}\.png$/);
    expect(readFileSync(join(root, res.path), 'utf8')).toBe('IMG:a red cube');
  });

  it('generate_speech writes the audio bytes with the provider ext', async () => {
    const tools = createMediaTools({
      root,
      generateSpeech: async (text) => ({ data: Buffer.from(`WAV:${text}`), ext: 'wav' }),
    });
    const tool = tools.find((t) => t.definition.id === 'generate_speech')!;
    const res = (await tool.run({ text: 'hello there' })) as { path: string; bytes: number };
    expect(res.path).toMatch(/^deliverables\/hello-there-[0-9a-f]{6}\.wav$/);
    expect(readFileSync(join(root, res.path), 'utf8')).toBe('WAV:hello there');
  });
});
