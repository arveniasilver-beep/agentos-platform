import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, TaskStatus } from '@agentos/db';
import { TasksService } from './tasks.service';
import { TaskControlBus } from './task-control-bus';

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

// onModuleInit only touches this.prisma + loadServerEnv(); the constructor wires the control bus,
// so that one needs a real (Redis-less) instance. The rest can be stubbed.
function makeService(prisma: unknown): TasksService {
  type Args = ConstructorParameters<typeof TasksService>;
  return new TasksService(
    prisma as Args[0],
    null as unknown as Args[1],
    null as unknown as Args[2],
    null as unknown as Args[3],
    null as unknown as Args[4],
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
}

suite('TasksService boot reaper (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('fails orphaned running-state tasks on boot, leaving pending + terminal untouched', async () => {
    const user = await prisma.user.create({
      data: { email: `reaper-${suffix}@test.local`, displayName: 'Reaper User' },
    });
    userId = user.id;
    const ws = await prisma.workspace.create({
      data: { name: 'Reaper WS', slug: `reaper-${suffix}`, ownerUserId: user.id },
    });
    workspaceId = ws.id;

    const mk = (status: TaskStatus) =>
      prisma.task.create({
        data: { workspaceId: ws.id, createdByUserId: user.id, title: status, prompt: 'x', status },
      });
    const running = await mk(TaskStatus.running);
    const planning = await mk(TaskStatus.planning);
    const awaiting = await mk(TaskStatus.awaiting_approval);
    const pending = await mk(TaskStatus.pending);
    const completed = await mk(TaskStatus.completed);

    await makeService(prisma).onModuleInit();

    const reload = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
    expect((await reload(running.id)).status).toBe(TaskStatus.failed);
    expect((await reload(planning.id)).status).toBe(TaskStatus.failed);
    expect((await reload(awaiting.id)).status).toBe(TaskStatus.failed);
    expect((await reload(running.id)).errorText).toMatch(/restart/i);
    // pending (re-deliverable) and terminal tasks are untouched
    expect((await reload(pending.id)).status).toBe(TaskStatus.pending);
    expect((await reload(completed.id)).status).toBe(TaskStatus.completed);
  });
});

// Build the service with a stub task queue so boot-resume re-enqueues (records the call) instead of
// running the engine inline (which would need real providers/tools).
function makeServiceWithQueue(prisma: unknown, queue: unknown): TasksService {
  type Args = ConstructorParameters<typeof TasksService>;
  return new TasksService(
    prisma as Args[0], null as unknown as Args[1], null as unknown as Args[2], null as unknown as Args[3],
    null as unknown as Args[4], new TaskControlBus(null), queue as Args[6],
    null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never,
  );
}

suite('TasksService boot resume (RESUME_ENABLED, live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = `r${Date.now().toString(36)}`;
  let userId = '';
  let workspaceId = '';
  let prevResume: string | undefined;

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    if (prevResume === undefined) delete process.env.RESUME_ENABLED; else process.env.RESUME_ENABLED = prevResume;
    await disconnectPrisma();
  });

  it('RESUME_ENABLED=true: re-enqueues orphaned running tasks for resume instead of failing them', async () => {
    prevResume = process.env.RESUME_ENABLED;
    process.env.RESUME_ENABLED = 'true';
    const user = await prisma.user.create({ data: { email: `bootresume-${suffix}@t.local`, displayName: 'BR' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'BR WS', slug: `bootresume-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;
    const running = await prisma.task.create({
      data: { workspaceId: ws.id, createdByUserId: user.id, title: 'r', prompt: 'x', status: TaskStatus.running, leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() + 99_000) },
    });

    const enqueued: string[] = [];
    const queue = { add: async (_name: string, data: { taskId: string }) => { enqueued.push(data.taskId); } };
    await makeServiceWithQueue(prisma, queue).onModuleInit();

    const after = await prisma.task.findUniqueOrThrow({ where: { id: running.id } });
    expect(after.status).not.toBe(TaskStatus.failed); // NOT failed — resumed instead
    expect(after.leaseOwner).toBeNull(); // stale lease cleared so the re-claim can pick it up
    expect(enqueued).toContain(running.id); // re-enqueued for a fresh worker to resume
  });
});
