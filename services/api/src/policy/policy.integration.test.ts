import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, TaskStatus, MemberRole } from '@agentos/db';
import { MockProvider } from '@agentos/llm';
import { RunController, InMemoryToolExecutor, type InMemoryTool } from '@agentos/agent-engine';
import { AuditService } from '../audit/audit.service';
import { TaskControlBus } from '../tasks/task-control-bus';
import { TasksService } from '../tasks/tasks.service';
import { TaskRunner } from '../tasks/task-runner';
import { PolicyService } from './policy.service';
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

function makeTasksService(prisma: unknown): TasksService {
  type Args = ConstructorParameters<typeof TasksService>;
  return new TasksService(
    prisma as Args[0], new AuditService(prisma as never), null as never, null as never, null as never,
    new TaskControlBus(null), null, null as never, null as never, null as never, null as never,
    null as never, null as never, null as never, null as never, new PolicyService(), new CodingWorkspaceService(), null as never, null as never,
  );
}

suite('Policy engine (live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  const policy = new PolicyService();
  const suffix = Date.now().toString(36);
  let ownerId = '';
  let adminId = '';
  let wsId = '';
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['POLICY_ELEVATED_APPROVAL_MODE', 'POLICY_OWNER_BREAKGLASS_ENABLED']) prevEnv[k] = process.env[k];
    const owner = await prisma.user.create({ data: { email: `pol-o-${suffix}@t.local`, displayName: 'Owner' } });
    ownerId = owner.id;
    const admin = await prisma.user.create({ data: { email: `pol-a-${suffix}@t.local`, displayName: 'Admin' } });
    adminId = admin.id;
    const ws = await prisma.workspace.create({ data: { name: 'Pol WS', slug: `pol-${suffix}`, ownerUserId: owner.id } });
    wsId = ws.id;
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: owner.id, role: MemberRole.owner } });
  });
  afterAll(async () => {
    if (wsId) await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    for (const id of [ownerId, adminId]) if (id) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await disconnectPrisma();
  });

  async function seedElevatedApproval(): Promise<{ taskId: string; approvalId: string }> {
    const t = await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: ownerId, title: 't', prompt: 'p', status: TaskStatus.awaiting_approval } });
    const approvalId = `${t.id}-a0`;
    await prisma.approval.create({ data: { taskId: t.id, workspaceId: wsId, approvalId, action: 'shell_exec', risk: 'critical', elevated: true, policyReason: 'destructive' } });
    return { taskId: t.id, approvalId };
  }

  it('personal/single-user: elevated approve requires owner break-glass typed confirmation', async () => {
    process.env.POLICY_ELEVATED_APPROVAL_MODE = 'personal';
    process.env.POLICY_OWNER_BREAKGLASS_ENABLED = 'true';
    const svc = makeTasksService(prisma);
    const { taskId, approvalId } = await seedElevatedApproval();
    // Owner without confirmation → blocked with a clear error.
    await expect(svc.decideApproval(wsId, taskId, approvalId, 'approve', ownerId)).rejects.toThrow(/confirmation/i);
    // Owner WITH typed confirmation → approved (break-glass).
    const res = await svc.decideApproval(wsId, taskId, approvalId, 'approve', ownerId, 'CONFIRM-ELEVATED');
    expect(res.decision).toBe('approve');
    expect((await prisma.approval.findFirstOrThrow({ where: { taskId, approvalId } })).status).toBe('approved');
  });

  it('personal: break-glass disabled → elevated approve is blocked', async () => {
    process.env.POLICY_ELEVATED_APPROVAL_MODE = 'personal';
    process.env.POLICY_OWNER_BREAKGLASS_ENABLED = 'false';
    const svc = makeTasksService(prisma);
    const { taskId, approvalId } = await seedElevatedApproval();
    await expect(svc.decideApproval(wsId, taskId, approvalId, 'approve', ownerId, 'CONFIRM-ELEVATED')).rejects.toThrow(/break-glass/i);
  });

  it('team mode: elevated cannot be self-approved; a non-self admin can', async () => {
    process.env.POLICY_ELEVATED_APPROVAL_MODE = 'team';
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: wsId, userId: adminId } },
      create: { workspaceId: wsId, userId: adminId, role: MemberRole.admin },
      update: { role: MemberRole.admin },
    });
    const svc = makeTasksService(prisma);
    const { taskId, approvalId } = await seedElevatedApproval(); // created by ownerId
    // Self-approval (owner created it) → blocked.
    await expect(svc.decideApproval(wsId, taskId, approvalId, 'approve', ownerId)).rejects.toThrow(/self-approved/i);
    // Non-self admin → approved.
    const res = await svc.decideApproval(wsId, taskId, approvalId, 'approve', adminId);
    expect(res.decision).toBe('approve');
  });

  it('elevated DENY is always allowed (deny is never less safe)', async () => {
    process.env.POLICY_ELEVATED_APPROVAL_MODE = 'team';
    const svc = makeTasksService(prisma);
    const { taskId, approvalId } = await seedElevatedApproval();
    const res = await svc.decideApproval(wsId, taskId, approvalId, 'deny', ownerId); // self-deny ok
    expect(res.decision).toBe('deny');
  });

  it('end-to-end audit trail + capability enforcement via the real engine', async () => {
    // Replicates tasks.service's policy hook + audit sink against the REAL PolicyService/AuditService/engine.
    const grantedScopes = new Set(['fs.read']); // net.request NOT granted
    const tool = (name: string, permissions: string[], onRun: () => void): InMemoryTool => ({
      descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, riskLevel: 'low', approvalRequired: false, permissions },
      handler: () => { onRun(); return { ok: true, output: {} }; },
    });

    async function runWith(toolName: string, perms: string[]): Promise<{ taskId: string; ran: number }> {
      const t = await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: ownerId, title: 't', prompt: 'p', status: TaskStatus.pending } });
      let ran = 0;
      const policyHook = async (c: { tool: string; riskLevel: 'low'|'medium'|'high'|'critical'; permissions: string[]; input: unknown }) => {
        const d = policy.evaluate(c, { grantedScopes });
        await audit.record({ workspaceId: wsId, actorType: 'agent', action: 'policy.decision', targetType: 'task', targetId: t.id, risk: c.riskLevel, metadata: { tool: c.tool, effect: d.effect } }).catch(() => undefined);
        if (d.effect === 'allow') await audit.record({ workspaceId: wsId, actorType: 'agent', action: 'tool.execution.allowed', targetType: 'task', targetId: t.id }).catch(() => undefined);
        return d;
      };
      const sink = (event: { type: string; ok?: boolean; error?: string }) => {
        let action: string | null = null;
        if (event.type === 'tool_call') action = 'tool.execution.started';
        else if (event.type === 'tool_result') action = event.ok ? 'tool.execution.completed' : (event.error ?? '').startsWith('denied by policy') ? 'tool.execution.denied' : 'tool.execution.failed';
        if (action) void audit.record({ workspaceId: wsId, actorType: 'agent', action, targetType: 'task', targetId: t.id }).catch(() => undefined);
      };
      await new TaskRunner(prisma).run({
        task: { id: t.id, workspaceId: wsId, createdByUserId: ownerId, prompt: 'p', riskCeiling: 'high', stepBudget: 12, costBudgetUsd: null },
        provider: new MockProvider([
          { text: '1. act', stopReason: 'end_turn' },
          { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: toolName, input: {} }], stopReason: 'tool_use' },
          { text: 'done', stopReason: 'end_turn' },
        ]),
        tools: new InMemoryToolExecutor([tool(toolName, perms, () => { ran += 1; })]),
        controller: new RunController(),
        sink: sink as never,
        policy: policyHook,
      });
      return { taskId: t.id, ran };
    }

    // Allowed: tool needs fs.read (granted), low-risk, not special → allow → runs.
    const allowed = await runWith('reader', ['fs.read']);
    expect(allowed.ran).toBe(1);
    const aActions = (await prisma.auditLog.findMany({ where: { workspaceId: wsId, targetId: allowed.taskId } })).map((r) => r.action);
    expect(aActions).toContain('policy.decision');
    expect(aActions).toContain('tool.execution.allowed');
    expect(aActions).toContain('tool.execution.started');
    expect(aActions).toContain('tool.execution.completed');

    // Denied capability: tool needs net.request (NOT granted) → deny → does NOT run.
    const denied = await runWith('netcall', ['net.request']);
    expect(denied.ran).toBe(0);
    const dActions = (await prisma.auditLog.findMany({ where: { workspaceId: wsId, targetId: denied.taskId } })).map((r) => r.action);
    expect(dActions).toContain('policy.decision');
    expect(dActions).toContain('tool.execution.denied');
  });
});
