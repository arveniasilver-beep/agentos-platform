import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, makeRlsClient, tenantContext, TaskStatus, type PrismaClient } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { LlmProviderFactory } from './llm-provider.factory';
import { ToolsFactory } from './tools.factory';
import { TaskControlBus } from './task-control-bus';
import type { TaskEventBus } from '../events/task-event-bus';
import { TasksService } from './tasks.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { StorageService } from '../storage/storage.service';
import { PolicyService } from '../policy/policy.service';
import { CodingWorkspaceService } from '../coding/coding.service';

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
type Args = ConstructorParameters<typeof TasksService>;

suite('Multi-turn follow-up KEYSTONE (live Postgres, mock LLM)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let wsA = '';
  let wsB = '';
  let service: TasksService;

  const build = () =>
    new TasksService(
      prisma as Args[0],
      new AuditService(prisma as never),
      new LlmProviderFactory(null as never),
      new ToolsFactory(),
      { publish: () => undefined } as unknown as TaskEventBus,
      new TaskControlBus(null),
      null,
      null as never,
      { buildPreamble: async () => undefined } as never,
      { hasImageProvider: async () => false, hasSpeechProvider: async () => false } as never,
      { githubApiFor: async () => null, notionApiFor: async () => null, googleApiFor: async () => null, outlookApiFor: async () => null } as never,
      { hasPeer: async () => false, peerName: async () => null } as never,
      { approvedFor: async () => [] } as never,
      { deployerFor: async () => null } as never,
      new ArtifactsService(prisma as never, new StorageService()),
      new PolicyService(),
      new CodingWorkspaceService(),
      null as never,
      null as never,
    );

  const waitTerminal = async (taskId: string, ms = 15000): Promise<TaskStatus> => {
    const t0 = Date.now();
    for (;;) {
      const t = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
      if (t && (['completed', 'failed', 'stopped'] as TaskStatus[]).includes(t.status)) return t.status;
      if (Date.now() - t0 > ms) throw new Error(`task ${taskId} did not finish in ${ms}ms (status=${t?.status})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  beforeAll(async () => {
    process.env.LLM_MODE = 'mock';
    process.env.ENABLE_BROWSER_TOOLS = 'false';
    process.env.ENABLE_SANDBOX = 'false';
    process.env.AGENT_SANDBOX_ROOT = join(tmpdir(), `agentos-fu-${suffix}`);
    process.env.FOLLOWUP_TURNS_ENABLED = 'true';
    service = build();
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `fu-${suffix}@test.local`, displayName: 'FU' } });
    userId = u.id;
    wsA = (await prisma.workspace.create({ data: { name: 'FU A', slug: `fu-a-${suffix}`, ownerUserId: u.id } })).id;
    wsB = (await prisma.workspace.create({ data: { name: 'FU B', slug: `fu-b-${suffix}`, ownerUserId: u.id } })).id;
  });

  afterAll(async () => {
    delete process.env.FOLLOWUP_TURNS_ENABLED;
    for (const w of [wsA, wsB]) if (w) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('a finished task continues in the SAME task on a follow-up — resumes, threads, no double-counted cost', async () => {
    // ---- Turn 1 (deterministic: create + run + await) ----
    const task = await prisma.task.create({
      data: { workspaceId: wsA, createdByUserId: userId, title: 'chat', prompt: 'first question', status: TaskStatus.pending, riskCeiling: 'low' },
    });
    await service.runTask(task.id);
    let row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(TaskStatus.completed);
    expect(await prisma.usageRecord.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.costRecord.count({ where: { taskId: task.id } })).toBe(1);
    // The conversation snapshot is PRESERVED across terminal (not deleted) so a follow-up can resume.
    const snap1 = await prisma.taskSnapshot.findUnique({ where: { taskId: task.id } });
    expect(snap1).not.toBeNull();
    // The durable chat thread holds turn-1 [user, assistant].
    let msgs = await prisma.taskMessage.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    const estAfterT1 = Number(row.estCostUsd);

    // ---- Follow-up turn (real entrypoint) ----
    const back = await service.sendFollowup(wsA, task.id, userId, 'second question, change it');
    expect(back.status).toBe(TaskStatus.pending); // re-opened, not a new task
    expect(back.id).toBe(task.id); // SAME task
    await waitTerminal(task.id);
    row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(TaskStatus.completed);

    // A SECOND run ran on the same task → two cost rows, two usage rows.
    expect(await prisma.usageRecord.count({ where: { taskId: task.id } })).toBe(2);
    const costRows = await prisma.costRecord.findMany({ where: { taskId: task.id }, orderBy: { computedAt: 'asc' } });
    expect(costRows).toHaveLength(2);

    // Thread now reads [user, assistant, user, assistant] — a real conversation in ONE task.
    msgs = await prisma.taskMessage.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[2]?.content).toBe('second question, change it');

    // COST DELTA (the keystone risk): the per-run cost rows SUM to the task's cumulative estCostUsd —
    // turn-2's row is its own delta, NOT the re-billed turn-1 tokens.
    const sumRows = costRows.reduce((s, r) => s + Number(r.amountUsd), 0);
    expect(sumRows).toBeCloseTo(Number(row.estCostUsd), 6);
    expect(Number(row.estCostUsd)).toBeGreaterThan(estAfterT1); // cumulative grew
    expect(Number(costRows[1]!.amountUsd)).toBeGreaterThan(0); // turn-2 actually did work
    expect(Number(costRows[1]!.amountUsd)).toBeLessThan(Number(row.estCostUsd)); // not the whole cumulative

    // RESUME proof: the final snapshot carries the full multi-turn conversation (grew past turn 1).
    const snap2 = await prisma.taskSnapshot.findUnique({ where: { taskId: task.id } });
    const m2 = (snap2!.state as unknown as { messages: unknown[] }).messages;
    const m1 = (snap1!.state as unknown as { messages: unknown[] }).messages;
    expect(m2.length).toBeGreaterThan(m1.length);
  }, 40_000);

  it('concurrency: 5 simultaneous follow-ups on one finished task start EXACTLY ONE run (atomic claim)', async () => {
    const task = await prisma.task.create({
      data: { workspaceId: wsA, createdByUserId: userId, title: 'race', prompt: 'q', status: TaskStatus.pending, riskCeiling: 'low' },
    });
    await service.runTask(task.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(TaskStatus.completed);
    const usageBefore = await prisma.usageRecord.count({ where: { taskId: task.id } });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => service.sendFollowup(wsA, task.id, userId, `parallel ${i}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const conflicts = results.filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(1); // exactly one winner re-opened the task
    expect(conflicts).toBe(4); // the rest hit the atomic claim guard (409)
    await waitTerminal(task.id);
    // Exactly ONE extra run executed (one new user message, one new usage row) — no double-run.
    expect(await prisma.usageRecord.count({ where: { taskId: task.id } })).toBe(usageBefore + 1);
    expect(await prisma.taskMessage.count({ where: { taskId: task.id, role: 'user' } })).toBe(2); // turn-1 + 1 follow-up
  }, 40_000);

  it('flag OFF: a finished task is one-shot — the follow-up endpoint 404s', async () => {
    const task = await prisma.task.create({
      data: { workspaceId: wsA, createdByUserId: userId, title: 'oneshot', prompt: 'q', status: TaskStatus.pending, riskCeiling: 'low' },
    });
    await service.runTask(task.id);
    const prev = process.env.FOLLOWUP_TURNS_ENABLED;
    delete process.env.FOLLOWUP_TURNS_ENABLED;
    try {
      await expect(service.sendFollowup(wsA, task.id, userId, 'more')).rejects.toThrow(/not found/i);
    } finally {
      if (prev !== undefined) process.env.FOLLOWUP_TURNS_ENABLED = prev;
    }
  }, 30_000);

  it('runtime-role RLS: agentos_app cannot read another workspace task message', async () => {
    const tA = await prisma.task.create({ data: { workspaceId: wsA, createdByUserId: userId, title: 'a', prompt: 'a', status: TaskStatus.completed, riskCeiling: 'low' } });
    const m = await prisma.taskMessage.create({ data: { taskId: tA.id, workspaceId: wsA, role: 'user', seq: 0, content: 'secret A' } });
    let app: PrismaClient | undefined;
    try {
      const u = new URL(process.env.DATABASE_URL as string);
      u.username = 'agentos_app';
      u.password = 'agentos_app';
      app = makeRlsClient(u.toString());
      await app.$connect();
    } catch {
      console.warn('followup rls: agentos_app unavailable, skipping');
      return;
    }
    const client = app;
    try {
      await tenantContext.run({ workspaceId: wsB }, async () => {
        expect(await client.taskMessage.findUnique({ where: { id: m.id } })).toBeNull();
      });
      await tenantContext.run({ workspaceId: wsA }, async () => {
        expect((await client.taskMessage.findUnique({ where: { id: m.id } }))?.id).toBe(m.id);
      });
    } finally {
      await app.$disconnect().catch(() => undefined);
    }
  }, 30_000);
});
