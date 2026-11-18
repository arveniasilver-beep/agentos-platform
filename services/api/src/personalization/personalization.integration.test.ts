import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { PersonalizationService } from './personalization.service';

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

suite('PersonalizationService (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const service = new PersonalizationService(prisma as never);
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('defaults to empty, upserts, and builds a system preamble', async () => {
    const user = await prisma.user.create({ data: { email: `pz-${suffix}@t.local`, displayName: 'P' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'PZ', slug: `pz-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    // Default (no row yet) is empty and yields no preamble.
    expect(await service.get(ws.id)).toEqual({
      nickname: null,
      profession: null,
      about: null,
      instructions: null,
      memories: [],
    });
    expect(await service.buildPreamble(ws.id)).toBeUndefined();

    // Upsert (create path).
    const saved = await service.update(ws.id, {
      nickname: 'Sal',
      instructions: 'Answer in Turkish.',
      memories: ['Prefers concise answers', '  ', 'Uses Postgres'],
    });
    expect(saved.nickname).toBe('Sal');
    expect(saved.memories).toEqual(['Prefers concise answers', 'Uses Postgres']); // blanks dropped

    // Preamble reflects the saved data.
    const preamble = await service.buildPreamble(ws.id);
    expect(preamble).toContain('Sal');
    expect(preamble).toContain('Answer in Turkish.');
    expect(preamble).toContain('- Uses Postgres');

    // Upsert (update path) — clearing a field with an empty string removes it.
    const updated = await service.update(ws.id, { nickname: '   ' });
    expect(updated.nickname).toBeNull();
    expect(updated.instructions).toBe('Answer in Turkish.'); // untouched field preserved
  });
});
