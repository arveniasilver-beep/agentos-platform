import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import IORedis from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import { getPrisma, disconnectPrisma, TaskStatus } from '@agentos/db';
import type { AutomationJobData } from '../queue/queue.constants';

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const envPath = resolve(process.cwd(), rel);
    if (existsSync(envPath)) {
      const match = readFileSync(envPath, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (match?.[1]) {
        process.env.DATABASE_URL = match[1];
        break;
      }
    }
  }
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const suite = process.env.DATABASE_URL ? describe : describe.skip;
const QUEUE = `agent-automations-test-${Date.now().toString(36)}`;

suite('automation scheduler -> worker -> task (live Redis + Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';
  let automationId = '';
  let queue: Queue<AutomationJobData> | undefined;
  let worker: Worker<AutomationJobData> | undefined;
  let producer: IORedis | undefined;
  let consumer: IORedis | undefined;

  afterAll(async () => {
    await worker?.close();
    if (queue && automationId) await queue.removeJobScheduler(automationId).catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await producer?.quit().catch(() => undefined);
    await consumer?.quit().catch(() => undefined);
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('fires on schedule and creates a task from the automation', async () => {
    producer = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    try {
      await producer.connect();
    } catch {
      console.warn('automation integration: Redis unreachable, skipping');
      return;
    }
    consumer = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

    const user = await prisma.user.create({
      data: { email: `auto-${suffix}@test.local`, displayName: 'Auto User' },
    });
    userId = user.id;
    const ws = await prisma.workspace.create({
      data: {
        name: 'Auto WS',
        slug: `auto-${suffix}`,
        ownerUserId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    workspaceId = ws.id;
    const automation = await prisma.automation.create({
      data: {
        workspaceId: ws.id,
        createdByUserId: user.id,
        name: 'Heartbeat',
        prompt: 'tick',
        cronExpression: '* * * * *',
        enabled: true,
      },
    });
    automationId = automation.id;

    queue = new Queue<AutomationJobData>(QUEUE, { connection: producer });
    // The worker mirrors AutomationsService.runAutomation's effect: a fire creates a Task row.
    worker = new Worker<AutomationJobData>(
      QUEUE,
      async (job: Job<AutomationJobData>) => {
        const a = await prisma.automation.findUniqueOrThrow({ where: { id: job.data.automationId } });
        await prisma.task.create({
          data: {
            workspaceId: a.workspaceId,
            createdByUserId: a.createdByUserId,
            title: a.name,
            prompt: a.prompt,
            status: TaskStatus.pending,
          },
        });
      },
      { connection: consumer },
    );

    // A job scheduler firing every second exercises the cron->fire->worker path quickly.
    await queue.upsertJobScheduler(automationId, { every: 1000 }, { name: 'fire', data: { automationId } });

    let created = 0;
    for (let i = 0; i < 80; i++) {
      created = await prisma.task.count({ where: { workspaceId } });
      if (created >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(created).toBeGreaterThanOrEqual(1);

    const task = await prisma.task.findFirst({ where: { workspaceId } });
    expect(task?.title).toBe('Heartbeat');
    expect(task?.prompt).toBe('tick');
  }, 30_000);
});
