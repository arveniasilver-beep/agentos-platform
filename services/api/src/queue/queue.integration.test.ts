import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import IORedis from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import { getPrisma, disconnectPrisma, TaskStatus } from '@agentos/db';
import { MockProvider } from '@agentos/llm';
import { InMemoryToolExecutor, RunController } from '@agentos/agent-engine';
import { TaskRunner } from '../tasks/task-runner';
import { AGENT_TASK_QUEUE, type RunJobData } from './queue.constants';

// Load DATABASE_URL from packages/db/.env when unset (mirrors the db integration test).
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
const hasDeps = Boolean(process.env.DATABASE_URL);
// This suite needs a live Redis; probe it once so a missing Redis skips rather than hangs.
const suite = hasDeps ? describe : describe.skip;

const QUEUE = `${AGENT_TASK_QUEUE}-test`;

suite('BullMQ task queue round-trip (live Redis + Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';
  let queue: Queue<RunJobData> | undefined;
  let worker: Worker<RunJobData> | undefined;
  let producer: IORedis | undefined;
  let consumer: IORedis | undefined;

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await producer?.quit().catch(() => undefined);
    await consumer?.quit().catch(() => undefined);
    if (workspaceId) {
      await prisma.usageRecord.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.costRecord.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('runs a queued task through a worker to completion', async () => {
    // Skip cleanly if Redis is unreachable in this environment.
    producer = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    try {
      await producer.connect();
    } catch {
      console.warn('queue integration: Redis unreachable, skipping');
      return;
    }
    consumer = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

    const user = await prisma.user.create({
      data: { email: `queue-${suffix}@test.local`, displayName: 'Queue User' },
    });
    userId = user.id;
    const ws = await prisma.workspace.create({
      data: {
        name: 'Queue WS',
        slug: `queue-${suffix}`,
        ownerUserId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    workspaceId = ws.id;
    const task = await prisma.task.create({
      data: {
        workspaceId: ws.id,
        createdByUserId: user.id,
        title: 'Queued task',
        prompt: 'Respond and finish.',
        status: TaskStatus.pending,
      },
    });

    const q = new Queue<RunJobData>(QUEUE, { connection: producer });
    queue = q;
    const w = new Worker<RunJobData>(
      QUEUE,
      async (job: Job<RunJobData>) => {
        const t = await prisma.task.findUniqueOrThrow({ where: { id: job.data.taskId } });
        await new TaskRunner(prisma).run({
          task: {
            id: t.id,
            workspaceId: t.workspaceId,
            createdByUserId: t.createdByUserId,
            prompt: t.prompt,
            riskCeiling: t.riskCeiling,
            stepBudget: t.stepBudget,
            costBudgetUsd: null,
          },
          provider: new MockProvider([
            { text: '1. respond', stopReason: 'end_turn' },
            { text: 'Done.', stopReason: 'end_turn' },
          ]),
          tools: new InMemoryToolExecutor([]),
          controller: new RunController(),
        });
      },
      { connection: consumer },
    );
    worker = w;

    const done = new Promise<void>((resolveDone, reject) => {
      w.on('completed', () => resolveDone());
      w.on('failed', (_job, err) => reject(err));
    });

    await q.add('run', { taskId: task.id });
    await done;

    const finished = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(finished.status).toBe(TaskStatus.completed);
    expect(Number(finished.estCostUsd)).toBeGreaterThan(0);
    const usage = await prisma.usageRecord.findFirst({ where: { taskId: task.id } });
    expect(usage).not.toBeNull();
  }, 20_000);
});
