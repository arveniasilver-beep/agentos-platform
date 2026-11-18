import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantContext, TaskStatus } from '@agentos/db';
import { ArtifactsService } from './artifacts.service';
import { StorageService } from '../storage/storage.service';

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) { process.env.DATABASE_URL = m[1]; break; }
    }
  }
}
const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite('Artifact versioning + rollback (Ticket-10, live Postgres)', () => {
  const prisma = getPrisma();
  const svc = new ArtifactsService(prisma as never, new StorageService());
  const sfx = Date.now().toString(36);
  let userId = '';
  let wsA = '';
  let wsB = '';
  let artId = '';
  let v1id = '';
  let v2id = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `av-${sfx}@t.local`, displayName: 'A' } });
    userId = u.id;
    wsA = (await prisma.workspace.create({ data: { name: 'A', slug: `av-a-${sfx}`, ownerUserId: u.id } })).id;
    wsB = (await prisma.workspace.create({ data: { name: 'B', slug: `av-b-${sfx}`, ownerUserId: u.id } })).id;
    const task = await prisma.task.create({ data: { workspaceId: wsA, createdByUserId: userId, title: 't', prompt: 'p', status: TaskStatus.completed, riskCeiling: 'low' } });
    const art = await prisma.artifact.create({ data: { workspaceId: wsA, taskId: task.id, name: 'report.pdf', kind: 'pdf' } });
    artId = art.id;
    v1id = (await prisma.artifactVersion.create({ data: { artifactId: art.id, workspaceId: wsA, version: 1, blobKey: 'k1', sha256: 'h1', sizeBytes: BigInt(10), mimeType: 'application/pdf' } })).id;
    v2id = (await prisma.artifactVersion.create({ data: { artifactId: art.id, workspaceId: wsA, version: 2, blobKey: 'k2', sha256: 'h2', sizeBytes: BigInt(20), mimeType: 'application/pdf' } })).id;
    await prisma.artifact.update({ where: { id: art.id }, data: { currentVersionId: v2id } });
  });

  afterAll(async () => {
    for (const w of [wsA, wsB]) if (w) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('lists the version history newest-first with the current pointer', async () => {
    const { versions, currentVersionId } = await svc.listVersions(wsA, artId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(currentVersionId).toBe(v2id);
    expect(versions[0]?.sha256).toBe('h2');
  });

  it('rolls back to a prior version NON-destructively, and can roll forward again', async () => {
    const back = await svc.rollback(wsA, artId, 1);
    expect(back.version).toBe(1);
    expect((await prisma.artifact.findUniqueOrThrow({ where: { id: artId } })).currentVersionId).toBe(v1id);
    // v2 is untouched (non-destructive) — rolling forward restores it.
    expect((await svc.rollback(wsA, artId, 2)).version).toBe(2);
    expect((await prisma.artifact.findUniqueOrThrow({ where: { id: artId } })).currentVersionId).toBe(v2id);
    // a missing version is a clean 404, not a silent no-op.
    await expect(svc.rollback(wsA, artId, 99)).rejects.toThrow(/not found/i);
  });

  it('tenancy: another workspace cannot read or roll back this artifact (404)', async () => {
    await expect(svc.listVersions(wsB, artId)).rejects.toThrow(/not found/i);
    await expect(svc.rollback(wsB, artId, 1)).rejects.toThrow(/not found/i);
  });
});
