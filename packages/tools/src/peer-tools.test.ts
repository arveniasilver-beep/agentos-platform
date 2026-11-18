import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPeerTools, type ConsultPeer } from './index';

describe('peer tools', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'peer-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function tools(consultPeer: ConsultPeer) {
    return createPeerTools({ root, consultPeer, peerName: 'MiMo-VL' });
  }
  const consult = (c: ConsultPeer) => tools(c).find((t) => t.definition.id === 'consult_peer')!;
  const critique = (c: ConsultPeer) => tools(c).find((t) => t.definition.id === 'critique_with_peer')!;

  it('registers both consult_peer and critique_with_peer with the peer name', () => {
    const ts = tools(async () => ({ answer: '', model: '' }));
    expect(ts.map((t) => t.definition.id).sort()).toEqual(['consult_peer', 'critique_with_peer']);
    expect(ts[0]!.definition.description).toContain('MiMo-VL');
  });

  it('consult_peer forwards a text-only question (no image)', async () => {
    let seen: { q: string; opts?: unknown } | null = null;
    const t = consult(async (q, opts) => {
      seen = { q, opts };
      return { answer: 'four', model: 'mimo' };
    });
    const res = (await t.run({ question: 'what is 2+2?' })) as { answer: string; model: string };
    expect(res).toEqual({ answer: 'four', model: 'mimo' });
    expect(seen).toEqual({ q: 'what is 2+2?', opts: undefined });
  });

  it('consult_peer reads an image from the sandbox and passes it base64-encoded', async () => {
    writeFileSync(join(root, 'shot.png'), Buffer.from('PNGDATA'));
    let opts: { image?: { base64: string; mimeType: string }; critic?: boolean } | undefined;
    const t = consult(async (_q, o) => {
      opts = o;
      return { answer: 'a cat', model: 'mimo-vl' };
    });
    const res = (await t.run({ question: 'what is shown?', image_path: 'shot.png' })) as { answer: string };
    expect(res.answer).toBe('a cat');
    expect(opts).toEqual({ image: { base64: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' } });
  });

  it('consult_peer rejects a path that escapes the sandbox', async () => {
    const t = consult(async () => ({ answer: '', model: '' }));
    await expect(t.run({ question: 'q', image_path: '../secret.png' })).rejects.toThrow(/escapes the task sandbox/);
  });

  it('consult_peer rejects an unsupported image type', async () => {
    writeFileSync(join(root, 'note.txt'), 'hi');
    const t = consult(async () => ({ answer: '', model: '' }));
    await expect(t.run({ question: 'q', image_path: 'note.txt' })).rejects.toThrow(/unsupported image type/);
  });

  it('consult_peer refuses to follow a symlink that escapes the sandbox', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'peer-outside-'));
    writeFileSync(join(outside, 'secret.png'), Buffer.from('TOPSECRET'));
    let linked = false;
    try {
      symlinkSync(join(outside, 'secret.png'), join(root, 'leak.png'));
      linked = true;
    } catch {
      /* symlink not permitted here (e.g. unprivileged Windows) */
    }
    try {
      if (!linked) {
        console.warn('peer symlink test: symlink creation not permitted, skipping');
        return;
      }
      const t = consult(async () => ({ answer: 'leaked!', model: 'x' }));
      await expect(t.run({ question: 'q', image_path: 'leak.png' })).rejects.toThrow(/escapes the task sandbox/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('critique_with_peer asks the peer in critic mode and embeds the draft + focus', async () => {
    let seen: { q: string; opts: { critic?: boolean } | undefined } | null = null;
    const t = critique(async (q, opts) => {
      seen = { q, opts };
      return { answer: 'your claim X is unsupported', model: 'mimo' };
    });
    const res = (await t.run({ draft: 'The sky is green.', focus: 'correctness' })) as {
      critique: string;
      model: string;
    };
    expect(res).toEqual({ critique: 'your claim X is unsupported', model: 'mimo' });
    expect(seen!.opts?.critic).toBe(true);
    expect(seen!.q).toContain('Focus your critique on: correctness');
    expect(seen!.q).toContain('The sky is green.');
  });
});
