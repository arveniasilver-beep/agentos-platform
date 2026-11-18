import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantRawExec, Prisma } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { SecretsService } from '../secrets/secrets.service';
import { KnowledgeService } from './knowledge.service';

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

suite('Knowledge/RAG (live Postgres + pgvector, local embeddings)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';
  // No embeddings config -> the keyless local (lexical) provider, so this runs without any API key.
  const knowledge = new KnowledgeService(
    new SecretsService(prisma as never, null as never, new AuditService(prisma as never)),
  );

  afterAll(async () => {
    if (workspaceId) {
      await tenantRawExec(
        Prisma.sql`DELETE FROM vector_documents WHERE "workspaceId" = ${workspaceId}`,
      ).catch(() => undefined);
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('ingests, chunks, embeds and retrieves the most relevant passage by KNN', async () => {
    const user = await prisma.user.create({ data: { email: `k-${suffix}@t.local`, displayName: 'K' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'K', slug: `k-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    const ing = await knowledge.ingest(
      ws.id,
      'knowledge',
      'Geography',
      'The capital of France is Paris. Paris sits on the Seine river. Berlin is the capital of Germany.',
    );
    expect(ing.chunks).toBeGreaterThan(0);
    expect(ing.model).toContain('local');

    const hits = await knowledge.search(ws.id, 'what is the capital of France', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content.toLowerCase()).toContain('paris');
    expect(hits[0]?.title).toBe('Geography');

    const docs = await knowledge.list(ws.id);
    expect(docs.some((d) => d.title === 'Geography')).toBe(true);
  }, 30_000);
});
