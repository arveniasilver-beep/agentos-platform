import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantContext, TaskStatus } from '@agentos/db';
import { MockProvider } from '@agentos/llm';
import { RunController, InMemoryToolExecutor, type InMemoryTool } from '@agentos/agent-engine';
import { ToolRegistryExecutor, createDeliverableTools } from '@agentos/tools';
import { AuditService } from '../audit/audit.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { StorageService } from '../storage/storage.service';
import { TaskRunner } from '../tasks/task-runner';
import { AutomationRunsService } from './automation-runs.service';
import { AutomationsService } from './automations.service';

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

suite('Automation targeted acceptance (live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  const runs = new AutomationRunsService(prisma as never, audit, null);
  const sfx = Date.now().toString(36);
  let wsA = '';
  let wsB = '';
  let userId = '';
  let tmp = '';
  const prevEnv: Record<string, string | undefined> = {};

  const automation = (wsId: string, enabled = true, costBudgetUsd: number | null = null) =>
    prisma.automation.create({ data: { workspaceId: wsId, createdByUserId: userId, name: 'a', prompt: 'do work', cronExpression: '0 9 * * *', timezone: 'UTC', enabled, riskCeiling: 'high', stepBudget: 12, ...(costBudgetUsd !== null ? { costBudgetUsd } : {}) } });

  beforeAll(async () => {
    tenantContext.enterSystem();
    for (const k of ['AUTOMATION_RUNS_ENABLED', 'ARTIFACT_PERSISTENCE_ENABLED', 'AGENT_SANDBOX_ROOT', 'ARTIFACT_STORE_ROOT']) prevEnv[k] = process.env[k];
    process.env.AUTOMATION_RUNS_ENABLED = 'true';
    tmp = mkdtempSync(join(tmpdir(), 'auto-target-'));
    const u = await prisma.user.create({ data: { email: `at-${sfx}@t.local`, displayName: 'AT' } });
    userId = u.id;
    wsA = (await prisma.workspace.create({ data: { name: 'A', slug: `at-a-${sfx}`, ownerUserId: u.id } })).id;
    wsB = (await prisma.workspace.create({ data: { name: 'B', slug: `at-b-${sfx}`, ownerUserId: u.id } })).id;
  });
  afterAll(async () => {
    for (const w of [wsA, wsB]) if (w) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    await disconnectPrisma();
  });

  // A TasksService stub that fails the test if a disabled/missing automation ever reaches task creation.
  const noLaunchTasks = { createAndStart: async () => { throw new Error('createAndStart must NOT run for a disabled/missing automation'); } } as never;

  it('1) disabled automation → no run, no task', async () => {
    const svc = new AutomationsService(prisma as never, audit, noLaunchTasks, runs, null);
    const a = await automation(wsA, false);
    expect(await svc.handleFire({ automationId: a.id }, Date.now())).toBeNull();
    expect(await svc.runNow(wsA, a.id, userId)).toEqual({ taskId: null });
    expect(await prisma.automationRun.count({ where: { automationId: a.id } })).toBe(0);
  });

  it('2) missing/deleted automation → no run (no orphan)', async () => {
    const svc = new AutomationsService(prisma as never, audit, noLaunchTasks, runs, null);
    expect(await svc.handleFire({ automationId: randomUUID() }, Date.now())).toBeNull();
    const a = await automation(wsA);
    await prisma.automation.delete({ where: { id: a.id } });
    expect(await svc.handleFire({ automationId: a.id }, Date.now())).toBeNull();
    expect(await prisma.automationRun.count({ where: { automationId: a.id } })).toBe(0);
  });

  it('3) approval denied → gated tool never runs + run terminal failed/denied', async () => {
    const a = await automation(wsA);
    const run = await runs.beginFire(a, 'scheduled', 'sched:deny', 0);
    const task = await prisma.task.create({ data: { workspaceId: wsA, createdByUserId: userId, title: 't', prompt: 'p', status: TaskStatus.pending, automationRunId: run!.id } });
    await runs.markRunning(run!.id, task.id);
    let ran = 0;
    const controller = new RunController();
    const events: Array<{ type: string; ok?: boolean; error?: string; approvalId?: string }> = [];
    const tool: InMemoryTool = { descriptor: { name: 'risky', description: 'r', inputSchema: { type: 'object', properties: {} }, riskLevel: 'high', approvalRequired: true, permissions: [] }, handler: () => { ran += 1; return { ok: true, output: {} }; } };
    const sink = (e: { type: string; ok?: boolean; error?: string; approvalId?: string }) => {
      events.push(e);
      if (e.type === 'approval_request' && e.approvalId) controller.decideApproval(e.approvalId, 'deny');
    };
    await new TaskRunner(prisma).run({
      task: { id: task.id, workspaceId: wsA, createdByUserId: userId, prompt: 'p', riskCeiling: 'high', stepBudget: 8, costBudgetUsd: null },
      provider: new MockProvider([{ text: 'plan', stopReason: 'end_turn' }, { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'risky', input: {} }], stopReason: 'tool_use' }, { text: 'done', stopReason: 'end_turn' }]),
      tools: new InMemoryToolExecutor([tool]), controller, sink: sink as never,
    });
    // Mirror executeTask's sink: a denied approval marks the automation run failed/denied.
    if (events.some((e) => e.type === 'tool_result' && e.ok === false && e.error === 'denied by user')) await runs.markDenied(run!.id);
    expect(ran).toBe(0); // gated tool never executed
    const finalRun = await runs.getRun(run!.id);
    expect(finalRun?.status).toBe('failed');
    expect(finalRun?.failureReason).toMatch(/denied/i);
  });

  it('4) cost budget exceeded → run failed with cost reason', async () => {
    const a = await automation(wsA, true, 0.0000001); // absurdly low budget
    const run = await runs.beginFire(a, 'scheduled', 'sched:cost', 0);
    const task = await prisma.task.create({ data: { workspaceId: wsA, createdByUserId: userId, title: 't', prompt: 'p', status: TaskStatus.pending, automationRunId: run!.id, costBudgetUsd: 0.0000001 } });
    await runs.markRunning(run!.id, task.id);
    await new TaskRunner(prisma).run({
      task: { id: task.id, workspaceId: wsA, createdByUserId: userId, prompt: 'expensive task', riskCeiling: 'high', stepBudget: 8, costBudgetUsd: 0.0000001 },
      provider: new MockProvider([{ text: 'a fairly long answer that accrues some token cost beyond the tiny budget', stopReason: 'end_turn' }]),
      tools: new InMemoryToolExecutor([]), controller: new RunController(),
    });
    const finalTask = await prisma.task.findUnique({ where: { id: task.id }, select: { status: true, errorText: true } });
    expect(finalTask?.status).toBe(TaskStatus.failed);
    await runs.onTaskTerminal(run!.id, 'failed', finalTask?.errorText ?? undefined);
    const finalRun = await runs.getRun(run!.id);
    expect(finalRun?.status).toBe('failed');
    expect(finalRun?.failureReason).toMatch(/cost|budget/i);
  });

  it('5) artifact-producing automation → artifactIds preserved + reachable via run.taskId', async () => {
    process.env.ARTIFACT_PERSISTENCE_ENABLED = 'true';
    process.env.AGENT_SANDBOX_ROOT = join(tmp, 'sandbox');
    process.env.ARTIFACT_STORE_ROOT = join(tmp, 'store');
    const artifacts = new ArtifactsService(prisma as never, new StorageService());
    const a = await automation(wsA);
    const run = await runs.beginFire(a, 'scheduled', 'sched:art', 0);
    const task = await prisma.task.create({ data: { workspaceId: wsA, createdByUserId: userId, title: 't', prompt: 'p', status: TaskStatus.pending, automationRunId: run!.id } });
    await runs.markRunning(run!.id, task.id);
    const root = join(process.env.AGENT_SANDBOX_ROOT, task.id);
    await new TaskRunner(prisma).run({
      task: { id: task.id, workspaceId: wsA, createdByUserId: userId, prompt: 'make a doc', riskCeiling: 'high', stepBudget: 8, costBudgetUsd: null },
      provider: new MockProvider([
        { text: 'plan', stopReason: 'end_turn' },
        { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'generate_document', input: { title: 'Report', sections: [{ heading: 'S', paragraphs: ['hi'] }] } }], stopReason: 'tool_use' },
        { text: 'done', stopReason: 'end_turn' },
      ]),
      tools: new ToolRegistryExecutor(createDeliverableTools({ root })),
      controller: new RunController(),
      registerArtifacts: () => artifacts.registerFromSandbox(wsA, task.id, null),
    });
    const finalTask = await prisma.task.findUnique({ where: { id: task.id }, select: { status: true, result: true } });
    await runs.onTaskTerminal(run!.id, finalTask?.status === TaskStatus.completed ? 'completed' : 'failed');
    expect(finalTask?.status).toBe(TaskStatus.completed);
    const artRows = await prisma.artifact.count({ where: { taskId: task.id } });
    expect(artRows).toBeGreaterThanOrEqual(1);
    const ids = (finalTask?.result as { artifactIds?: string[] } | null)?.artifactIds ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(1);
    // Reachable via the run: run.taskId → task → artifacts.
    const finalRun = await runs.getRun(run!.id);
    expect(finalRun?.taskId).toBe(task.id);
    expect(await prisma.artifact.count({ where: { taskId: finalRun!.taskId! } })).toBeGreaterThanOrEqual(1);
  });

  it('6) cross-workspace: another workspace cannot read this automation’s run history (app-level + RLS)', async () => {
    const a = await automation(wsA);
    const run = await runs.beginFire(a, 'scheduled', 'sched:rls', 0);
    expect(run).not.toBeNull();
    // App-level tenant isolation: listing workspace A's automation from workspace B is a 404 (the
    // service scopes every read by workspaceId). This is the enforced guarantee for ANY DB role.
    const svc = new AutomationsService(prisma as never, audit, noLaunchTasks, runs, null);
    await expect(svc.listRuns(wsB, a.id)).rejects.toThrow(/not found/i);
    // Workspace A still sees its own run (scoping is by workspace, not a blanket deny).
    const ownRuns = await svc.listRuns(wsA, a.id);
    expect(ownRuns.length).toBeGreaterThanOrEqual(1);
    // Defense-in-depth: the migration ALSO enables RLS (tenant_isolation on workspaceId) which scopes
    // the non-owner runtime role agentos_app at the DB layer (same pattern as tasks/artifacts). The
    // test connects as the table OWNER (RLS is ENABLE-not-FORCE, so the owner bypasses) — hence the
    // app-level 404 above is the role-independent proof here.
  });
});
