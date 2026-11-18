import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { NotificationsService } from './notifications.service';

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

suite('Notifications (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const service = new NotificationsService(prisma as never);
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('lists newest-first with an unread count and marks read', async () => {
    const user = await prisma.user.create({ data: { email: `nt-${suffix}@t.local`, displayName: 'N' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'NT', slug: `nt-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    await prisma.notification.createMany({
      data: [
        { workspaceId: ws.id, userId: user.id, kind: 'task_done', title: 'Task completed' },
        { workspaceId: ws.id, userId: user.id, kind: 'approval_request', title: 'Approval needed' },
      ],
    });

    const before = await service.list(ws.id, user.id);
    expect(before.unread).toBe(2);
    expect(before.items).toHaveLength(2);
    expect(before.items.map((i) => i.title).sort()).toEqual(['Approval needed', 'Task completed']);

    // Mark one read.
    const oneId = before.items[0]!.id;
    const r1 = await service.markRead(ws.id, user.id, oneId);
    expect(r1.unread).toBe(1);

    // Mark all read.
    const r2 = await service.markRead(ws.id, user.id);
    expect(r2.unread).toBe(0);
    const after = await service.list(ws.id, user.id);
    expect(after.items.every((i) => i.readAt !== null)).toBe(true);
  });
});
