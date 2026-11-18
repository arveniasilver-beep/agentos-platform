import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import IORedis from 'ioredis';
import { getPrisma, disconnectPrisma, TaskStatus } from '@agentos/db';
import { RunController } from '@agentos/agent-engine';
import { TaskControlBus, type TaskControlSignal } from './task-control-bus';
import { TasksService } from './tasks.service';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Load DATABASE_URL from packages/db/.env when unset (mirrors the other integration tests).
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
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

describe('TaskControlBus — no Redis (single-process)', () => {
  it('publish() is a no-op without peers (the local process applies the change directly)', async () => {
    const bus = new TaskControlBus(null);
    const received: TaskControlSignal[] = [];
    bus.onSignal((s) => received.push(s));

    bus.publish('task-1');
    await sleep(20);

    expect(received).toEqual([]);
    await bus.onModuleDestroy();
  });
});

describe('TaskControlBus — cross-replica delivery (live Redis)', () => {
  let connA: IORedis | undefined;
  let connB: IORedis | undefined;
  let busA: TaskControlBus | undefined;
  let busB: TaskControlBus | undefined;

  afterAll(async () => {
    await busA?.onModuleDestroy();
    await busB?.onModuleDestroy();
    await connA?.quit().catch(() => undefined);
    await connB?.quit().catch(() => undefined);
  });

  it('delivers a taskId notification published on one connection to a bus on another', async () => {
    const probe = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    try {
      await probe.connect();
      await probe.quit();
    } catch {
      console.warn('task-control-bus integration: Redis unreachable, skipping');
      return;
    }

    // Two buses on independent connections stand in for two replicas: A receives the operator's
    // request, B is running the engine.
    connA = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    connB = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    busA = new TaskControlBus(connA);
    busB = new TaskControlBus(connB);

    const onB: TaskControlSignal[] = [];
    busB.onSignal((s) => onB.push(s));

    // pub/sub drops messages published before the subscriber is established, so re-publish until the
    // first one lands (bounded). In production the periodic reconciler is the backstop for this gap.
    const start = Date.now();
    while (onB.length === 0 && Date.now() - start < 3000) {
      busA.publish('task-xyz');
      await sleep(50);
    }
    expect(onB.some((s) => s.taskId === 'task-xyz')).toBe(true);
  }, 20_000);
});

// The durable backstop: a stop/approval committed to the DB is applied to a locally-running
// controller even when NO live signal is delivered (the core guarantee that makes the lossy pub/sub
// channel safe). Exercises the private reconcile() via the active map directly.
const suite = process.env.DATABASE_URL ? describe : describe.skip;
type Args = ConstructorParameters<typeof TasksService>;
const activeOf = (s: TasksService): Map<string, RunController> =>
  (s as unknown as { active: Map<string, RunController> }).active;
const reconcileOf = (s: TasksService): ((ids: string[]) => Promise<void>) =>
  (s as unknown as { reconcile(ids: string[]): Promise<void> }).reconcile.bind(s);

suite('TasksService control reconcile (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) {
      await prisma.approval.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  function makeService(): TasksService {
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

  it('applies a DB-committed approval and stop to a local controller with no live signal', async () => {
    const user = await prisma.user.create({
      data: { email: `reconcile-${suffix}@test.local`, displayName: 'Reconcile User' },
    });
    userId = user.id;
    const ws = await prisma.workspace.create({
      data: { name: 'Reconcile WS', slug: `reconcile-${suffix}`, ownerUserId: user.id },
    });
    workspaceId = ws.id;
    const task = await prisma.task.create({
      data: {
        workspaceId: ws.id,
        createdByUserId: user.id,
        title: 'Reconcile task',
        prompt: 'x',
        status: TaskStatus.awaiting_approval,
      },
    });
    const approvalId = `${task.id}-a0`;
    await prisma.approval.create({
      data: { taskId: task.id, workspaceId: ws.id, approvalId, action: 'risky_tool', risk: 'high' },
    });

    const service = makeService();
    const controller = new RunController();
    activeOf(service).set(task.id, controller);

    // The engine is parked awaiting the approval; the decision is committed to the DB by some other
    // replica, and the live pub/sub signal is (simulated as) lost — only the reconciler runs.
    const decision = controller.awaitApproval(approvalId);
    await prisma.approval.updateMany({
      where: { taskId: task.id, approvalId, status: 'pending' },
      data: { status: 'approved', decidedAt: new Date() },
    });
    await reconcileOf(service)([task.id]);
    await expect(decision).resolves.toBe('approve');

    // Likewise a durable kill request is honored without any live signal.
    expect(controller.isStopped()).toBe(false);
    await prisma.task.update({ where: { id: task.id }, data: { killRequested: true } });
    await reconcileOf(service)([task.id]);
    expect(controller.isStopped()).toBe(true);

    // A task not running on this replica is left untouched (no throw, no effect).
    await reconcileOf(service)(['some-other-task-id']);
  });
});
