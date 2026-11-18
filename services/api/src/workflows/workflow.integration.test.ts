import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, makeRlsClient, tenantContext, type PrismaClient } from '@agentos/db';
import { loadServerEnv } from '@agentos/config';
import { AuditService } from '../audit/audit.service';
import { WorkflowService, type TaskLauncher } from './workflow.service';

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

const MULTI = {
  start: 'a',
  trigger: { type: 'manual' },
  steps: [
    { id: 'a', type: 'task', prompt: 'do A', onSuccess: 'cond', onFailure: 'fail' },
    { id: 'cond', type: 'condition', expr: { left: 'lastStatus', op: 'eq', value: 'completed' }, onTrue: 'gate', onFalse: 'fail' },
    { id: 'gate', type: 'approval', onSuccess: 'b', onFailure: 'fail' },
    { id: 'b', type: 'task', prompt: 'do B', onSuccess: 'end', onFailure: 'fail' },
  ],
};

suite('Workflow Builder (TICKET-8, live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  const launched: Array<{ id: string; prompt: string }> = [];
  let n = 0;
  const stub: TaskLauncher = { createAndStart: async (_ws, _uid, dto) => { const id = `task-${++n}`; launched.push({ id, prompt: dto.prompt }); return { id }; } };
  const svc = new WorkflowService(prisma as never, audit, stub);
  const sfx = Date.now().toString(36);
  let userId = '';
  let wsA = '';
  let wsB = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `wf-${sfx}@t.local`, displayName: 'W' } });
    userId = u.id;
    wsA = (await prisma.workspace.create({ data: { name: 'A', slug: `wf-a-${sfx}`, ownerUserId: u.id } })).id;
    wsB = (await prisma.workspace.create({ data: { name: 'B', slug: `wf-b-${sfx}`, ownerUserId: u.id } })).id;
  });
  afterAll(async () => {
    delete process.env.WORKFLOW_BUILDER_ENABLED;
    for (const w of [wsA, wsB]) if (w) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('rejects an invalid definition', async () => {
    await expect(svc.create(wsA, userId, { name: 'bad', definition: { start: 'x', trigger: { type: 'manual' }, steps: [] } })).rejects.toThrow();
    await expect(svc.create(wsA, userId, { name: 'bad2', definition: { start: 'a', trigger: { type: 'manual' }, steps: [{ id: 'a', type: 'task', prompt: 'x', onSuccess: 'ghost' }] } })).rejects.toThrow(/invalid workflow/);
  });

  it('drives a multi-step run: task -> condition -> approval(halt) -> task -> completed', async () => {
    launched.length = 0;
    const { workflow } = await svc.create(wsA, userId, { name: 'multi', definition: MULTI });
    let run = await svc.startRun(wsA, workflow.id, 'manual');
    expect(run.status).toBe('running'); // halted at task step a
    expect(launched.map((l) => l.prompt)).toEqual(['do A']);

    await svc.onTaskTerminal(run.id, launched[0]!.id, 'completed'); // a done -> cond(true) -> approval(halt)
    run = (await svc.getRun(wsA, run.id))!;
    expect(run.status).toBe('awaiting_approval');
    expect(run.currentStepId).toBe('gate');

    run = await svc.decideApproval(wsA, run.id, 'approve', userId); // -> task b
    expect(run.status).toBe('running');
    expect(launched.map((l) => l.prompt)).toEqual(['do A', 'do B']);

    await svc.onTaskTerminal(run.id, launched[1]!.id, 'completed'); // b done -> end
    run = (await svc.getRun(wsA, run.id))!;
    expect(run.status).toBe('completed');
  });

  it('per-step retry: a failing task with maxRetries relaunches before routing to onFailure', async () => {
    launched.length = 0;
    const def = { start: 'a', trigger: { type: 'manual' }, steps: [{ id: 'a', type: 'task', prompt: 'flaky', maxRetries: 1, onSuccess: 'end', onFailure: 'fail' }] };
    const { workflow } = await svc.create(wsA, userId, { name: 'retry', definition: def });
    let run = await svc.startRun(wsA, workflow.id, 'manual');
    await svc.onTaskTerminal(run.id, launched[0]!.id, 'failed'); // attempt 0 failed -> retry (attempt 1)
    run = (await svc.getRun(wsA, run.id))!;
    expect(run.status).toBe('running');
    expect(launched.length).toBe(2); // relaunched
    await svc.onTaskTerminal(run.id, launched[1]!.id, 'failed'); // retry failed -> onFailure -> fail
    run = (await svc.getRun(wsA, run.id))!;
    expect(run.status).toBe('failed');
  });

  it('webhook trigger: wrong secret rejected (constant-time), correct secret starts a run', async () => {
    launched.length = 0;
    const def = { start: 'a', trigger: { type: 'webhook' }, steps: [{ id: 'a', type: 'task', prompt: 'hooked', onSuccess: 'end' }] };
    const { workflow, webhookToken } = await svc.create(wsA, userId, { name: 'hook', definition: def });
    expect(webhookToken).toMatch(/^wfh_/);
    await expect(svc.triggerWebhook(wsA, workflow.id, 'wrong')).rejects.toThrow(/Invalid webhook secret/);
    const run = await svc.triggerWebhook(wsA, workflow.id, webhookToken!);
    expect(run.triggeredBy).toBe('webhook');
    expect(run.status).toBe('running');
  });

  it('runtime-role DB-level RLS: agentos_app cannot read another workspace workflow', async () => {
    const { workflow } = await svc.create(wsA, userId, { name: 'rls', definition: MULTI });
    let app: PrismaClient | undefined;
    try {
      const u = new URL(process.env.DATABASE_URL as string);
      u.username = 'agentos_app';
      u.password = 'agentos_app';
      app = makeRlsClient(u.toString());
      await app.$connect();
    } catch {
      console.warn('workflow rls: agentos_app unavailable, skipping');
      return;
    }
    const client = app;
    try {
      await tenantContext.run({ workspaceId: wsB }, async () => {
        expect(await client.workflow.findUnique({ where: { id: workflow.id } })).toBeNull();
      });
      await tenantContext.run({ workspaceId: wsA }, async () => {
        expect((await client.workflow.findUnique({ where: { id: workflow.id } }))?.id).toBe(workflow.id);
      });
    } finally {
      await app.$disconnect().catch(() => undefined);
    }
  });

  it('flag WORKFLOW_BUILDER_ENABLED defaults false', () => {
    const prev = process.env.WORKFLOW_BUILDER_ENABLED;
    delete process.env.WORKFLOW_BUILDER_ENABLED;
    try {
      expect(loadServerEnv().WORKFLOW_BUILDER_ENABLED).toBe(false);
    } finally {
      if (prev !== undefined) process.env.WORKFLOW_BUILDER_ENABLED = prev;
    }
  });
});
