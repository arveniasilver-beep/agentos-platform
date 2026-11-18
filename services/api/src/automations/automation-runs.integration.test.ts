import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { AutomationRunsService } from './automation-runs.service';

// Load DATABASE_URL from .env for a local run (mirrors the other integration tests). Skip if absent.
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

/** A stub BullMQ queue: records enqueued retry jobs without Redis. */
function stubQueue() {
  const added: Array<{ name: string; data: unknown }> = [];
  return { added, queue: { add: async (name: string, data: unknown) => { added.push({ name, data }); } } as never };
}

suite('AutomationRunsService (durable run lifecycle, live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  const sfx = Date.now().toString(36);
  let wsId = '';
  let userId = '';

  async function makeAutomation(enabled = true) {
    return prisma.automation.create({
      data: { workspaceId: wsId, createdByUserId: userId, name: 'auto', prompt: 'p', cronExpression: '0 9 * * *', timezone: 'UTC', enabled, riskCeiling: 'high', stepBudget: 12 },
    });
  }

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { email: `arun-${sfx}@t.local`, displayName: 'A' } });
    userId = u.id;
    const w = await prisma.workspace.create({ data: { name: 'ARun WS', slug: `arun-${sfx}`, ownerUserId: u.id } });
    wsId = w.id;
  });
  afterAll(async () => {
    if (wsId) await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('creates a run, marks running, then completed on task success', async () => {
    const svc = new AutomationRunsService(prisma as never, audit, null);
    const a = await makeAutomation();
    const run = await svc.beginFire(a, 'scheduled', 'sched:100', 0);
    expect(run?.status).toBe('pending');
    await svc.markRunning(run!.id, 'task-x');
    await svc.onTaskTerminal(run!.id, 'completed');
    const final = await svc.getRun(run!.id);
    expect(final?.status).toBe('completed');
    expect(final?.taskId).toBe('task-x');
  });

  it('dedups a duplicate delivery of the SAME (automationId, fireKey, attempt)', async () => {
    const svc = new AutomationRunsService(prisma as never, audit, null);
    const a = await makeAutomation();
    const run1 = await svc.beginFire(a, 'scheduled', 'sched:200', 0);
    const run2 = await svc.beginFire(a, 'scheduled', 'sched:200', 0); // same key+attempt → dedup
    expect(run1).not.toBeNull();
    expect(run2).toBeNull();
    expect(await prisma.automationRun.count({ where: { automationId: a.id, scheduledFireKey: 'sched:200' } })).toBe(1);
  });

  it('skips a new fire while a run is active (overlap)', async () => {
    const svc = new AutomationRunsService(prisma as never, audit, null);
    const a = await makeAutomation();
    const run1 = await svc.beginFire(a, 'scheduled', 'sched:300', 0); // active (pending)
    const run2 = await svc.beginFire(a, 'scheduled', 'sched:301', 0); // different fire → overlap-skip
    expect(run1?.status).toBe('pending');
    expect(run2).toBeNull();
    const skipped = await prisma.automationRun.findMany({ where: { automationId: a.id, status: 'skipped' } });
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.skipReason).toMatch(/overlap/i);
    expect(await prisma.automationRun.count({ where: { automationId: a.id, status: { in: ['pending', 'running'] } } })).toBe(1);
  });

  it('on task failure schedules a run-level retry within the max', async () => {
    const sq = stubQueue();
    const svc = new AutomationRunsService(prisma as never, audit, sq.queue);
    const a = await makeAutomation();
    const run = await svc.beginFire(a, 'scheduled', 'sched:400', 0);
    await svc.markRunning(run!.id, 'task-f');
    await svc.onTaskTerminal(run!.id, 'failed', 'boom');
    const orig = await svc.getRun(run!.id);
    expect(orig?.status).toBe('failed');
    // A retry run (attempt 1) was created + a retry job enqueued.
    const retry = await prisma.automationRun.findFirst({ where: { automationId: a.id, scheduledFireKey: 'sched:400', attempt: 1 } });
    expect(retry).not.toBeNull();
    expect(retry?.retryOfRunId).toBe(run!.id);
    expect(sq.added.some((j) => (j.data as { runId?: string }).runId === retry?.id)).toBe(true);
  });

  it('stops retrying after AUTOMATION_MAX_RETRIES (terminal failure)', async () => {
    process.env.AUTOMATION_MAX_RETRIES = '1';
    try {
      const sq = stubQueue();
      const svc = new AutomationRunsService(prisma as never, audit, sq.queue);
      const a = await makeAutomation();
      const r0 = await svc.beginFire(a, 'scheduled', 'sched:500', 0);
      await svc.onTaskTerminal(r0!.id, 'failed'); // attempt 0 < 1 → retry created
      const r1 = await prisma.automationRun.findFirst({ where: { automationId: a.id, scheduledFireKey: 'sched:500', attempt: 1 } });
      expect(r1).not.toBeNull();
      await svc.onTaskTerminal(r1!.id, 'failed'); // attempt 1 == max → NO further retry
      const r2 = await prisma.automationRun.findFirst({ where: { automationId: a.id, scheduledFireKey: 'sched:500', attempt: 2 } });
      expect(r2).toBeNull();
      expect((await svc.getRun(r1!.id))?.status).toBe('failed');
    } finally {
      delete process.env.AUTOMATION_MAX_RETRIES;
    }
  });

  it('marks awaiting_approval and is idempotent', async () => {
    const svc = new AutomationRunsService(prisma as never, audit, null);
    const a = await makeAutomation();
    const run = await svc.beginFire(a, 'scheduled', 'sched:600', 0);
    await svc.markRunning(run!.id, 'task-a');
    await svc.markAwaitingApproval(run!.id);
    await svc.markAwaitingApproval(run!.id); // idempotent
    expect((await svc.getRun(run!.id))?.status).toBe('awaiting_approval');
  });

  it('multi-instance race: concurrent same-fire creates exactly one run (DB unique = last defense)', async () => {
    const svc = new AutomationRunsService(prisma as never, audit, null);
    const a = await makeAutomation();
    const [r1, r2] = await Promise.all([
      svc.beginFire(a, 'scheduled', 'sched:700', 0),
      svc.beginFire(a, 'scheduled', 'sched:700', 0),
    ]);
    const created = [r1, r2].filter(Boolean);
    expect(created.length).toBe(1); // the other lost the unique race → null
    expect(await prisma.automationRun.count({ where: { automationId: a.id, scheduledFireKey: 'sched:700' } })).toBe(1);
  });
});
