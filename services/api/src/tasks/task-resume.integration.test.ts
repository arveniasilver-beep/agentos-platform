import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import {
  getPrisma,
  disconnectPrisma,
  makeRlsClient,
  tenantContext,
  TaskStatus,
  Prisma,
  type PrismaClient,
} from '@agentos/db';
import type { AgentEvent } from '@agentos/protocol';
import { MockProvider } from '@agentos/llm';
import {
  AgentEngine,
  RunController,
  InMemoryToolExecutor,
  type InMemoryTool,
  type ResumableState,
} from '@agentos/agent-engine';
import { TaskRunner, type RunnableTask } from './task-runner';

// Mirror the other integration suites: load DATABASE_URL from .env when unset, skip cleanly without it.
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

function tool(name: string, handler: InMemoryTool['handler']): InMemoryTool {
  return {
    descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, riskLevel: 'low', approvalRequired: false },
    handler,
  };
}
const answer = (text: string) => ({ text, stopReason: 'end_turn' as const });
const planThenAnswer = () => [{ text: '1. do it', stopReason: 'end_turn' as const }, answer('done')];

suite('Durable resume (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';
  const extraWorkspaces: string[] = [];
  const extraUsers: string[] = [];
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['RESUME_ENABLED', 'RESUME_HEARTBEAT_SEC', 'RESUME_LEASE_TTL_SEC', 'RESUME_MAX_ATTEMPTS']) prevEnv[k] = process.env[k];
    process.env.RESUME_ENABLED = 'true';
    process.env.RESUME_LEASE_TTL_SEC = '60';
    const user = await prisma.user.create({ data: { email: `resume-${suffix}@t.local`, displayName: 'Resume' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'Resume WS', slug: `resume-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;
  });

  afterAll(async () => {
    for (const id of [workspaceId, ...extraWorkspaces]) if (id) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    for (const id of [userId, ...extraUsers]) if (id) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await disconnectPrisma();
  });

  async function mkTask(over: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
    return prisma.task.create({
      data: { workspaceId, createdByUserId: userId, title: 't', prompt: 'do the thing', status: TaskStatus.pending, ...over },
    });
  }
  function runnable(t: { id: string; prompt: string; riskCeiling: unknown; stepBudget: number; costBudgetUsd: unknown }): RunnableTask {
    return {
      id: t.id, workspaceId, createdByUserId: userId, prompt: t.prompt,
      riskCeiling: t.riskCeiling as RunnableTask['riskCeiling'], stepBudget: t.stepBudget,
      costBudgetUsd: t.costBudgetUsd !== null ? Number(t.costBudgetUsd) : null,
    };
  }
  const usageCount = (taskId: string) => prisma.usageRecord.count({ where: { taskId } });

  it('fresh run (RESUME_ENABLED) writes a snapshot during the run, then deletes it + clears lease on completion', async () => {
    const t = await mkTask();
    let snapshotSeenDuringRun = false;
    const tools = new InMemoryToolExecutor([
      tool('probe', async () => {
        snapshotSeenDuringRun = (await prisma.taskSnapshot.findUnique({ where: { taskId: t.id } })) !== null;
        return { ok: true, output: {} };
      }),
    ]);
    // plan, call probe (step 0), final.
    const provider = new MockProvider([
      { text: '1. probe', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'probe', input: {} }], stopReason: 'tool_use' },
      answer('done'),
    ]);
    await new TaskRunner(prisma).run({ task: runnable(t), provider, tools, controller: new RunController() });

    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe(TaskStatus.completed);
    expect(snapshotSeenDuringRun).toBe(true); // snapshot existed mid-run
    expect(await prisma.taskSnapshot.findUnique({ where: { taskId: t.id } })).toBeNull(); // deleted on terminal
    expect(after.leaseOwner).toBeNull(); // lease released
    expect(await usageCount(t.id)).toBe(1);
  });

  it('RESUME_ENABLED=false → no snapshot is written and behavior is unchanged', async () => {
    process.env.RESUME_ENABLED = 'false';
    try {
      const t = await mkTask();
      let snapshotSeenDuringRun = false;
      const tools = new InMemoryToolExecutor([
        tool('probe', async () => {
          snapshotSeenDuringRun = (await prisma.taskSnapshot.findUnique({ where: { taskId: t.id } })) !== null;
          return { ok: true, output: {} };
        }),
      ]);
      const provider = new MockProvider([
        { text: '1. probe', stopReason: 'end_turn' },
        { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'probe', input: {} }], stopReason: 'tool_use' },
        answer('done'),
      ]);
      await new TaskRunner(prisma).run({ task: runnable(t), provider, tools, controller: new RunController() });
      const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.status).toBe(TaskStatus.completed);
      expect(snapshotSeenDuringRun).toBe(false); // never written
      expect(after.leaseOwner).toBeNull(); // lease columns untouched
      expect(after.fencingToken).toBe(0);
      expect(await usageCount(t.id)).toBe(1);
    } finally {
      process.env.RESUME_ENABLED = 'true';
    }
  });

  it('crash mid-run → resume completes from snapshot WITHOUT re-running the completed step, single usage row', async () => {
    const t = await mkTask();
    // 1) Capture a real mid-run snapshot via the engine, stopping right after step 0 completes.
    const ctl = new RunController();
    const snaps: ResumableState[] = [];
    const events: AgentEvent[] = [];
    await new AgentEngine().run({
      taskId: t.id, prompt: t.prompt,
      provider: new MockProvider([
        { text: '1. search\n2. answer', stopReason: 'end_turn' },
        { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'web_search', input: {} }], stopReason: 'tool_use' },
        { text: '', toolCalls: [{ type: 'tool_use', id: 'u2', name: 'web_search', input: {} }], stopReason: 'tool_use' },
        answer('The answer is 42.'),
      ]),
      tools: new InMemoryToolExecutor([tool('web_search', () => ({ ok: true, output: { r: 1 } }))]),
      controller: ctl, emit: (e) => { events.push(e); },
      checkpoint: (s) => { snaps.push(s); if (s.step === 1) ctl.requestStop(); },
    });
    const snap = snaps.find((s) => s.step === 1)!;
    expect(snap).toBeDefined();

    // 2) Persist the crashed state into the DB: events (minus the synthetic 'stopped'), the snapshot,
    //    and a task left 'running' with an EXPIRED lease (owning process is gone).
    const persistable = events.filter((e) => e.type !== 'stopped');
    await prisma.taskLog.createMany({
      data: persistable.map((e) => ({ taskId: t.id, workspaceId, seq: e.seq, type: e.type, payload: e as unknown as Prisma.InputJsonValue })),
    });
    await prisma.taskSnapshot.create({ data: { taskId: t.id, workspaceId, seq: snap.seq, state: snap as unknown as Prisma.InputJsonValue } });
    await prisma.task.update({
      where: { id: t.id },
      data: { status: TaskStatus.running, leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 1000), fencingToken: 1 },
    });

    // 3) Resume: a fresh provider that just answers (needs no tool) — if the completed step were
    //    re-run, this counter would increment.
    let resumeToolCalls = 0;
    await new TaskRunner(prisma).run({
      task: runnable(await prisma.task.findUniqueOrThrow({ where: { id: t.id } })),
      provider: new MockProvider([answer('The answer is 42.')]),
      tools: new InMemoryToolExecutor([tool('web_search', () => { resumeToolCalls += 1; return { ok: true, output: {} }; })]),
      controller: new RunController(),
    });

    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe(TaskStatus.completed);
    expect((after.result as { summary?: string } | null)?.summary).toBe('The answer is 42.');
    expect(resumeToolCalls).toBe(0); // step 0's tool was NOT re-run
    expect(await usageCount(t.id)).toBe(1); // crashed attempt never wrote usage; only the resume did
    expect(await prisma.taskSnapshot.findUnique({ where: { taskId: t.id } })).toBeNull(); // cleaned on terminal
  });

  it('duplicate job delivery → exactly one execution (single usage row)', async () => {
    const t = await mkTask();
    const mk = () => new TaskRunner(prisma).run({
      task: runnable(t), provider: new MockProvider(planThenAnswer()),
      tools: new InMemoryToolExecutor([]), controller: new RunController(),
    });
    await Promise.all([mk(), mk()]); // two concurrent deliveries
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe(TaskStatus.completed);
    expect(await usageCount(t.id)).toBe(1); // the loser bailed — no second usage row
  });

  it('a live lease blocks a second worker (no double run)', async () => {
    const t = await mkTask({
      status: TaskStatus.running,
      leaseOwner: 'worker-A',
      leaseExpiresAt: new Date(Date.now() + 60_000), // fresh lease, still alive
      fencingToken: 1,
    });
    await prisma.taskSnapshot.create({
      data: { taskId: t.id, workspaceId, seq: 1, state: { v: 1, seq: 1, step: 0, planned: true, messages: [{ role: 'user', content: t.prompt }], runningSummary: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, callCounter: 0, approvalCounter: 0, toolCallCount: 0, toolErrors: 0 } as unknown as Prisma.InputJsonValue },
    });
    await new TaskRunner(prisma).run({
      task: runnable(t), provider: new MockProvider([answer('x')]),
      tools: new InMemoryToolExecutor([]), controller: new RunController(),
    });
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe(TaskStatus.running); // untouched — reclaim bailed on the live lease
    expect(await usageCount(t.id)).toBe(0);
  });

  it('poison-task guard: a task past RESUME_MAX_ATTEMPTS is failed, not resumed', async () => {
    process.env.RESUME_MAX_ATTEMPTS = '2';
    try {
      const t = await mkTask({
        status: TaskStatus.running, leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000),
        fencingToken: 1, resumeCount: 2, // reclaim will bump to 3 > 2
      });
      await new TaskRunner(prisma).run({
        task: runnable(t), provider: new MockProvider([answer('x')]),
        tools: new InMemoryToolExecutor([]), controller: new RunController(),
      });
      const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.status).toBe(TaskStatus.failed);
      expect(after.errorText ?? '').toMatch(/resume attempts/i);
      expect(await usageCount(t.id)).toBe(0); // never ran the engine
    } finally {
      delete process.env.RESUME_MAX_ATTEMPTS;
    }
  });

  it('worker that lost its lease self-stops on the next heartbeat (fencing)', async () => {
    process.env.RESUME_HEARTBEAT_SEC = '1';
    try {
      const t = await mkTask();
      const provider = new MockProvider([
        { text: '1. work', stopReason: 'end_turn' },
        { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'slow', input: {} }], stopReason: 'tool_use' },
        answer('should-not-reach'),
      ]);
      const tools = new InMemoryToolExecutor([
        tool('slow', async () => {
          // Simulate ANOTHER worker re-claiming this task: bump the fencing token + steal ownership.
          await prisma.task.update({ where: { id: t.id }, data: { fencingToken: { increment: 1 }, leaseOwner: 'other-worker' } });
          // Wait past one heartbeat tick (1s) so our fenced heartbeat detects the loss and stops us.
          await new Promise<void>((r) => { setTimeout(r, 1300); });
          return { ok: true, output: {} };
        }),
      ]);
      await new TaskRunner(prisma).run({ task: runnable(t), provider, tools, controller: new RunController() });
      const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.status).toBe(TaskStatus.stopped); // self-stopped after losing the lease
      expect(provider.calls.length).toBe(2); // never made the 3rd (final) model call
    } finally {
      delete process.env.RESUME_HEARTBEAT_SEC;
    }
  }, 15_000);

  it('cross-workspace snapshot reads are blocked by RLS (least-privilege role)', async () => {
    let app: PrismaClient | undefined;
    try {
      const url = new URL(process.env.DATABASE_URL as string);
      url.username = 'agentos_app';
      url.password = 'agentos_app';
      app = makeRlsClient(url.toString());
      await app.$connect();
    } catch {
      console.warn('resume rls: agentos_app role unavailable, skipping');
      return;
    }
    const appClient = app;

    // Two workspaces, each with a task + a snapshot (seeded by the owner client, RLS-bypassed).
    const ua = await prisma.user.create({ data: { email: `rs-a-${suffix}@t.local`, displayName: 'A' } });
    extraUsers.push(ua.id);
    const wa = await prisma.workspace.create({ data: { name: 'A', slug: `rs-a-${suffix}`, ownerUserId: ua.id } });
    extraWorkspaces.push(wa.id);
    const ub = await prisma.user.create({ data: { email: `rs-b-${suffix}@t.local`, displayName: 'B' } });
    extraUsers.push(ub.id);
    const wb = await prisma.workspace.create({ data: { name: 'B', slug: `rs-b-${suffix}`, ownerUserId: ub.id } });
    extraWorkspaces.push(wb.id);
    const blank = { v: 1, seq: 0, step: 0, planned: false, messages: [], runningSummary: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, callCounter: 0, approvalCounter: 0, toolCallCount: 0, toolErrors: 0 };
    const ta = await prisma.task.create({ data: { workspaceId: wa.id, createdByUserId: ua.id, title: 'a', prompt: 'x', status: TaskStatus.running } });
    const tb = await prisma.task.create({ data: { workspaceId: wb.id, createdByUserId: ub.id, title: 'b', prompt: 'x', status: TaskStatus.running } });
    await prisma.taskSnapshot.create({ data: { taskId: ta.id, workspaceId: wa.id, seq: 0, state: blank as unknown as Prisma.InputJsonValue } });
    await prisma.taskSnapshot.create({ data: { taskId: tb.id, workspaceId: wb.id, seq: 0, state: blank as unknown as Prisma.InputJsonValue } });

    // In workspace A's context the app role sees A's snapshot only — B's is invisible even by id.
    await tenantContext.run({ workspaceId: wa.id }, async () => {
      expect((await appClient.taskSnapshot.findUnique({ where: { taskId: ta.id } }))?.taskId).toBe(ta.id);
      expect(await appClient.taskSnapshot.findUnique({ where: { taskId: tb.id } })).toBeNull();
      const visible = await appClient.taskSnapshot.findMany({ where: { taskId: { in: [ta.id, tb.id] } } });
      expect(visible.map((s) => s.taskId)).toEqual([ta.id]);
    });
    await app.$disconnect().catch(() => undefined);
  });
});
