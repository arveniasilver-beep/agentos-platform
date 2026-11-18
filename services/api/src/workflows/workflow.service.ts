import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { generateToken } from '@agentos/auth';
import { loadServerEnv } from '@agentos/config';
import { Prisma, tenantContext, type Workflow, type WorkflowRun } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parseWorkflowDefinition, type WorkflowDefinition } from './workflow-dsl';
import { stepById, evalCondition, routeAfter, contextFrom, type StepState, type StepOutcome } from './workflow-engine';

/** Minimal task launcher — TasksService satisfies it; tests pass a stub. Avoids a circular import. */
export interface TaskLauncher {
  createAndStart(
    workspaceId: string,
    userId: string,
    dto: { title: string; prompt: string; riskCeiling: 'low' | 'medium' | 'high' | 'critical'; capability?: string; effort?: string },
    opts?: { workflowRunId?: string },
  ): Promise<{ id: string }>;
}

const MAX_DRIVE_ITERS = 200; // anti-infinite-loop backstop for condition chains (per drive() call)
const MAX_TASK_LAUNCHES = 50; // run-level ceiling on task launches (bounds cost + any routing cycle)
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const taskLaunchCount = (states: { type: string }[]) => states.filter((s) => s.type === 'task').length;

@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TaskLauncher,
  ) {}

  // ---- CRUD -------------------------------------------------------------------------------------

  /** Create a workflow from a raw definition (validated). For a webhook trigger, returns the secret ONCE. */
  async create(workspaceId: string, userId: string, input: { name: string; definition: unknown; projectId?: string }): Promise<{ workflow: Workflow; webhookToken?: string }> {
    let def: WorkflowDefinition;
    try {
      def = parseWorkflowDefinition(input.definition);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'invalid workflow definition');
    }
    let webhookToken: string | undefined;
    let webhookSecretHash: string | null = null;
    if (def.trigger.type === 'webhook') {
      webhookToken = `wfh_${generateToken()}`;
      webhookSecretHash = hash(webhookToken);
    }
    const workflow = await this.prisma.workflow.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        projectId: input.projectId ?? null,
        name: input.name,
        definition: def as unknown as Prisma.InputJsonValue,
        webhookSecretHash,
      },
    });
    await this.audit.record({ workspaceId, actorUserId: userId, action: 'workflow.created', targetType: 'workflow', targetId: workflow.id, metadata: { name: input.name, trigger: def.trigger.type, steps: def.steps.length } }).catch(() => undefined);
    return webhookToken ? { workflow, webhookToken } : { workflow };
  }

  list(workspaceId: string): Promise<Workflow[]> {
    return this.prisma.workflow.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  get(workspaceId: string, id: string): Promise<Workflow | null> {
    return this.prisma.workflow.findFirst({ where: { id, workspaceId } });
  }
  async setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<Workflow> {
    await this.require(workspaceId, id);
    return this.prisma.workflow.update({ where: { id }, data: { enabled } });
  }
  async remove(workspaceId: string, id: string, userId: string): Promise<{ deleted: true }> {
    await this.require(workspaceId, id);
    await this.prisma.workflow.delete({ where: { id } });
    await this.audit.record({ workspaceId, actorUserId: userId, action: 'workflow.deleted', targetType: 'workflow', targetId: id }).catch(() => undefined);
    return { deleted: true };
  }
  private async require(workspaceId: string, id: string): Promise<Workflow> {
    const w = await this.get(workspaceId, id);
    if (!w) throw new NotFoundException('Workflow not found in this workspace.');
    return w;
  }

  listRuns(workspaceId: string, workflowId: string): Promise<WorkflowRun[]> {
    return this.prisma.workflowRun.findMany({ where: { workspaceId, workflowId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }
  getRun(workspaceId: string, runId: string): Promise<WorkflowRun | null> {
    return this.prisma.workflowRun.findFirst({ where: { id: runId, workspaceId } });
  }

  // ---- Triggers ---------------------------------------------------------------------------------

  /** Start a run (manual / scheduled / webhook). Creates the run + drives it to the first halt. */
  async startRun(workspaceId: string, workflowId: string, triggeredBy: 'manual' | 'scheduled' | 'webhook'): Promise<WorkflowRun> {
    const wf = await this.require(workspaceId, workflowId);
    if (!wf.enabled) throw new BadRequestException('Workflow is disabled.');
    const def = wf.definition as unknown as WorkflowDefinition;
    const run = await this.prisma.workflowRun.create({
      data: { workspaceId, workflowId, status: 'pending', triggeredBy, currentStepId: def.start, stepStates: [] as unknown as Prisma.InputJsonValue, startedAt: new Date() },
    });
    await this.audit.record({ workspaceId, actorType: 'agent', action: 'workflow.run.created', targetType: 'workflow_run', targetId: run.id, metadata: { workflowId, triggeredBy } }).catch(() => undefined);
    await this.drive(run.id);
    return (await this.getRun(workspaceId, run.id))!;
  }

  /** Verify the per-workflow webhook secret (constant-time) and start a run. */
  async triggerWebhook(workspaceId: string, workflowId: string, token: string): Promise<WorkflowRun> {
    const wf = await this.require(workspaceId, workflowId);
    const def = wf.definition as unknown as WorkflowDefinition;
    if (def.trigger.type !== 'webhook' || !wf.webhookSecretHash) throw new ForbiddenException('Workflow has no webhook trigger.');
    const a = Buffer.from(hash(token ?? ''));
    const b = Buffer.from(wf.webhookSecretHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('Invalid webhook secret.');
    return this.startRun(workspaceId, workflowId, 'webhook');
  }

  /** Public webhook entry (no session): resolve the workflow + workspace in system context, then verify
   * the secret + start a run within that workspace's tenant context. Flag-gated. SECURITY: every failure
   * (flag off, unknown id, not-a-webhook, bad secret) returns a UNIFORM NotFound — no enumeration oracle. */
  async triggerWebhookById(workflowId: string, token: string): Promise<WorkflowRun> {
    const notFound = new NotFoundException('Workflow not found.');
    if (!loadServerEnv().WORKFLOW_BUILDER_ENABLED) throw notFound;
    const wf = await tenantContext.runSystem(() => this.prisma.workflow.findUnique({ where: { id: workflowId }, select: { id: true, workspaceId: true } }));
    if (!wf) throw notFound;
    try {
      return await tenantContext.run({ workspaceId: wf.workspaceId }, () => this.triggerWebhook(wf.workspaceId, workflowId, token));
    } catch {
      // Collapse the descriptive internal error (bad secret / not a webhook / disabled) into a uniform 404.
      throw notFound;
    }
  }

  // ---- Drive (state machine) --------------------------------------------------------------------

  private async loadDef(runId: string): Promise<{ run: WorkflowRun; def: WorkflowDefinition; ownerId: string; workspaceId: string } | null> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId }, include: { workflow: true } });
    if (!run) return null;
    return { run, def: run.workflow.definition as unknown as WorkflowDefinition, ownerId: run.workflow.createdByUserId, workspaceId: run.workspaceId };
  }

  /** Drive the run forward: resolve condition steps inline; halt at a task (await terminal), an approval
   * (await decision), or a terminal ('end'/'fail'). */
  private async drive(runId: string): Promise<void> {
    const ctx = await this.loadDef(runId);
    if (!ctx) return;
    const { run, def, ownerId, workspaceId } = ctx;
    let cur = run.currentStepId ?? def.start;
    const states = (run.stepStates as unknown as StepState[]) ?? [];

    for (let i = 0; i < MAX_DRIVE_ITERS; i++) {
      if (cur === 'end') return this.finish(runId, 'completed', states, null);
      if (cur === 'fail') return this.finish(runId, 'failed', states, 'workflow routed to fail');
      const step = stepById(def, cur);
      if (!step) return this.finish(runId, 'failed', states, `unknown step: ${cur}`);

      if (step.type === 'condition') {
        const branch = evalCondition(step.expr, contextFrom(states));
        states.push({ stepId: step.id, type: 'condition', status: 'condition', branch });
        cur = branch ? step.onTrue : step.onFalse;
        continue;
      }
      if (step.type === 'approval') {
        states.push({ stepId: step.id, type: 'approval', status: 'awaiting_approval' });
        await this.persist(runId, 'awaiting_approval', cur, states);
        await this.audit.record({ workspaceId, actorType: 'agent', action: 'workflow.run.awaiting_approval', targetType: 'workflow_run', targetId: runId, metadata: { stepId: step.id } }).catch(() => undefined);
        return;
      }
      // task step: launch a task and halt until it reaches a terminal state.
      if (taskLaunchCount(states) >= MAX_TASK_LAUNCHES) return this.finish(runId, 'failed', states, 'workflow exceeded the task-launch limit');
      const task = await this.tasks.createAndStart(
        workspaceId,
        ownerId,
        { title: step.name ?? `workflow:${step.id}`, prompt: step.prompt, riskCeiling: 'high', ...(step.capability ? { capability: step.capability } : {}), ...(step.effort ? { effort: step.effort } : {}) },
        { workflowRunId: runId },
      );
      states.push({ stepId: step.id, type: 'task', status: 'running', taskId: task.id, attempt: 0 });
      await this.persist(runId, 'running', cur, states);
      await this.audit.record({ workspaceId, actorType: 'agent', action: 'workflow.run.step_started', targetType: 'workflow_run', targetId: runId, metadata: { stepId: step.id, taskId: task.id } }).catch(() => undefined);
      return;
    }
    await this.finish(runId, 'failed', states, 'workflow exceeded the step limit');
  }

  /** Advance a run after its current task step reached a terminal state (called from the task sink). */
  async onTaskTerminal(runId: string, taskId: string, taskStatus: 'completed' | 'failed' | 'stopped'): Promise<void> {
    const ctx = await this.loadDef(runId);
    if (!ctx) return;
    const { run, def } = ctx;
    if (run.status !== 'running' || run.currentStepId == null) return;
    const step = stepById(def, run.currentStepId);
    if (!step || step.type !== 'task') return;
    const states = (run.stepStates as unknown as StepState[]) ?? [];
    const cs = [...states].reverse().find((s) => s.taskId === taskId && s.status === 'running');
    const ok = taskStatus === 'completed';

    // Per-step retry: re-launch the same task step up to maxRetries before routing to onFailure.
    if (!ok && cs && step.maxRetries && (cs.attempt ?? 0) < step.maxRetries && taskLaunchCount(states) < MAX_TASK_LAUNCHES) {
      cs.status = 'failed';
      const attempt = (cs.attempt ?? 0) + 1;
      const task = await this.tasks.createAndStart(ctx.workspaceId, ctx.ownerId, { title: step.name ?? `workflow:${step.id}`, prompt: step.prompt, riskCeiling: 'high', ...(step.capability ? { capability: step.capability } : {}), ...(step.effort ? { effort: step.effort } : {}) }, { workflowRunId: runId });
      states.push({ stepId: step.id, type: 'task', status: 'running', taskId: task.id, attempt });
      await this.persist(runId, 'running', step.id, states);
      return;
    }
    if (cs) cs.status = ok ? 'completed' : 'failed';
    const outcome: StepOutcome = ok ? 'task_done' : 'task_failed';
    await this.persist(runId, 'running', routeAfter(step, outcome), states);
    await this.drive(runId);
  }

  /** Decide a workflow approval step (member action). */
  async decideApproval(workspaceId: string, runId: string, decision: 'approve' | 'deny', userId: string): Promise<WorkflowRun> {
    const ctx = await this.loadDef(runId);
    if (!ctx || ctx.run.workspaceId !== workspaceId) throw new NotFoundException('Workflow run not found.');
    const { run, def } = ctx;
    if (run.status !== 'awaiting_approval' || run.currentStepId == null) throw new BadRequestException('Run is not awaiting approval.');
    const step = stepById(def, run.currentStepId);
    if (!step || step.type !== 'approval') throw new BadRequestException('Current step is not an approval.');
    const states = (run.stepStates as unknown as StepState[]) ?? [];
    const cs = [...states].reverse().find((s) => s.stepId === step.id && s.status === 'awaiting_approval');
    if (cs) cs.status = decision === 'approve' ? 'completed' : 'failed';
    await this.audit.record({ workspaceId, actorUserId: userId, action: decision === 'approve' ? 'workflow.run.approved' : 'workflow.run.denied', targetType: 'workflow_run', targetId: runId, risk: 'high', metadata: { stepId: step.id } }).catch(() => undefined);
    await this.persist(runId, 'running', routeAfter(step, decision === 'approve' ? 'approved' : 'denied'), states);
    await this.drive(runId);
    return (await this.getRun(workspaceId, runId))!;
  }

  // ---- persistence helpers ----------------------------------------------------------------------

  private persist(runId: string, status: string, currentStepId: string, states: StepState[]): Promise<unknown> {
    return this.prisma.workflowRun.update({ where: { id: runId }, data: { status, currentStepId, stepStates: states as unknown as Prisma.InputJsonValue } });
  }
  private async finish(runId: string, status: 'completed' | 'failed', states: StepState[], failureReason: string | null): Promise<void> {
    await this.prisma.workflowRun.update({ where: { id: runId }, data: { status, currentStepId: null, stepStates: states as unknown as Prisma.InputJsonValue, finishedAt: new Date(), failureReason } });
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId }, select: { workspaceId: true } });
    if (run) await this.audit.record({ workspaceId: run.workspaceId, actorType: 'agent', action: `workflow.run.${status}`, targetType: 'workflow_run', targetId: runId, ...(failureReason ? { metadata: { failureReason } } : {}) }).catch(() => undefined);
  }
}
