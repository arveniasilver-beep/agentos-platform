import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantContext } from '@agentos/db';
import { PlaybooksService } from './playbooks.service';
import { AuditService } from '../audit/audit.service';

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

suite('PlaybooksService (live Postgres + RLS)', () => {
  const prisma = getPrisma();
  const svc = new PlaybooksService(prisma as never, new AuditService(prisma as never));
  const suffix = Date.now().toString(36);
  let userId = '';
  let wsA = '';
  let wsB = '';

  afterAll(async () => {
    for (const id of [wsA, wsB]) if (id) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('creates, lists, runs (template fields) and deletes — isolated per workspace', async () => {
    const user = await prisma.user.create({ data: { email: `pb-${suffix}@t.local`, displayName: 'P' } });
    userId = user.id;
    const a = await prisma.workspace.create({ data: { name: 'A', slug: `pb-a-${suffix}`, ownerUserId: user.id } });
    const b = await prisma.workspace.create({ data: { name: 'B', slug: `pb-b-${suffix}`, ownerUserId: user.id } });
    wsA = a.id;
    wsB = b.id;

    const pb = await tenantContext.runWorkspace(a.id, () =>
      svc.create(a.id, user.id, { name: 'Weekly report', prompt: 'Write the weekly report', capability: 'document', effort: 'max' }),
    );
    expect(pb.capability).toBe('document');
    expect(pb.effort).toBe('max');

    // Listed in its own workspace…
    const listA = await tenantContext.runWorkspace(a.id, () => svc.list(a.id));
    expect(listA.map((p) => p.id)).toContain(pb.id);
    // …and NOT visible from another workspace (RLS).
    const listB = await tenantContext.runWorkspace(b.id, () => svc.list(b.id));
    expect(listB.map((p) => p.id)).not.toContain(pb.id);

    // A cross-workspace delete cannot remove it (scoped deleteMany + RLS).
    await expect(tenantContext.runWorkspace(b.id, () => svc.remove(b.id, pb.id))).rejects.toThrow(/not found/i);
    expect((await tenantContext.runWorkspace(a.id, () => svc.list(a.id))).length).toBe(1);

    // Owning workspace deletes it.
    await tenantContext.runWorkspace(a.id, () => svc.remove(a.id, pb.id));
    expect((await tenantContext.runWorkspace(a.id, () => svc.list(a.id))).length).toBe(0);
  });
});
