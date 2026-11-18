import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, TaskStatus, type Task } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { TaskControlBus } from './task-control-bus';
import { TasksService } from './tasks.service';

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
type Args = ConstructorParameters<typeof TasksService>;

suite('Task management: rename / favorite / archive / delete (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';

  const service = new TasksService(
    prisma as Args[0],
    new AuditService(prisma as never),
    null as never,
    null as never,
    null as never,
    new TaskControlBus(null),
    null,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('renames, favorites, archives (hidden from default list), and deletes', async () => {
    const user = await prisma.user.create({ data: { email: `tm-${suffix}@t.local`, displayName: 'T' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'TM', slug: `tm-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;
    const mk = (title: string, status: TaskStatus) =>
      prisma.task.create({ data: { workspaceId: ws.id, createdByUserId: user.id, title, prompt: 'p', status } }) as Promise<Task>;
    const a = await mk('Alpha', TaskStatus.completed);
    const b = await mk('Beta', TaskStatus.completed);

    // Rename + favorite.
    const renamed = await service.updateMeta(ws.id, a.id, user.id, { title: 'Alpha v2', favorite: true });
    expect(renamed.title).toBe('Alpha v2');
    expect(renamed.favorite).toBe(true);

    // Favorites sort to the top of the default list.
    const active = await service.list(ws.id);
    expect(active.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(active.every((t) => t.archivedAt === null)).toBe(true);

    // Archiving hides from the default list and surfaces in the archived view.
    await service.updateMeta(ws.id, b.id, user.id, { archived: true });
    expect((await service.list(ws.id)).map((t) => t.id)).toEqual([a.id]);
    const archived = await service.list(ws.id, { archived: true });
    expect(archived.map((t) => t.id)).toEqual([b.id]);
    expect(archived[0]!.archivedAt).not.toBeNull();

    // Unarchive restores it.
    await service.updateMeta(ws.id, b.id, user.id, { archived: false });
    expect((await service.list(ws.id)).length).toBe(2);

    // A running task cannot be deleted (atomic state guard).
    const running = await mk('Running', TaskStatus.running);
    await expect(service.deleteTask(ws.id, running.id, user.id)).rejects.toThrow(/Stop the task/);
    expect(await prisma.task.findUnique({ where: { id: running.id } })).not.toBeNull();
    // A queued (pending) task can't be deleted either — a worker might claim it concurrently.
    const pending = await mk('Pending', TaskStatus.pending);
    await expect(service.deleteTask(ws.id, pending.id, user.id)).rejects.toThrow(/Stop the task/);

    // Search matches title OR prompt, case-insensitively, across active + archived.
    await prisma.task.update({ where: { id: b.id }, data: { archivedAt: new Date() } });
    const byTitle = await service.search(ws.id, 'alpha');
    expect(byTitle.map((t) => t.id)).toContain(a.id);
    const byArchived = await service.search(ws.id, 'BETA'); // archived + different case
    expect(byArchived.map((t) => t.id)).toContain(b.id);
    expect(await service.search(ws.id, '   ')).toEqual([]); // blank query -> no results

    // Delete a terminal task.
    expect(await service.deleteTask(ws.id, a.id, user.id)).toEqual({ deleted: true });
    expect(await prisma.task.findUnique({ where: { id: a.id } })).toBeNull();
  });
});
