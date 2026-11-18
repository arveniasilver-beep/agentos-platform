import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { SecretsService } from '../secrets/secrets.service';
import { MediaService } from './media.service';

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) {
        process.env.DATABASE_URL = m[1];
        break;
      }
    }
  }
}
const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite('Media generation config + provider (live Postgres, mock provider)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const secrets = new SecretsService(prisma as never, new CryptoService(), new AuditService(prisma as never));
  const media = new MediaService(secrets);
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('stores encrypted provider config and generates via the configured (mock) provider', async () => {
    const user = await prisma.user.create({ data: { email: `md-${suffix}@t.local`, displayName: 'M' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'MD', slug: `md-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    // No provider yet -> not advertised, and generation errors clearly.
    expect(await media.hasImageProvider(ws.id)).toBe(false);
    await expect(media.generateImage(ws.id, 'x')).rejects.toThrow(/No image provider/);

    // Configure the keyless mock image provider.
    const info = await secrets.setImageConfig(ws.id, user.id, { provider: 'mock' });
    expect(info.configured).toBe(true);
    expect(info.provider).toBe('mock');
    expect(await media.hasImageProvider(ws.id)).toBe(true);

    const img = await media.generateImage(ws.id, 'a blue circle');
    expect(img.ext).toBe('svg');
    expect(img.data.toString('utf8')).toContain('a blue circle');

    // Speech provider (mock WAV).
    await secrets.setSpeechConfig(ws.id, user.id, { provider: 'mock' });
    expect(await media.hasSpeechProvider(ws.id)).toBe(true);
    const audio = await media.generateSpeech(ws.id, 'hello');
    expect(audio.ext).toBe('wav');
    expect(audio.data.subarray(0, 4).toString('ascii')).toBe('RIFF');

    // The raw key/config is never returned by the info endpoints — only provider/model/lastFour.
    const back = await secrets.getImageInfo(ws.id);
    expect(Object.keys(back).sort()).toEqual(['configured', 'lastFour', 'model', 'provider']);

    // Removing the config disables the tools again.
    await secrets.deleteImageConfig(ws.id, user.id);
    expect(await media.hasImageProvider(ws.id)).toBe(false);
  });
});
