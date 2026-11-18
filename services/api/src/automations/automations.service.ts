import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { loadServerEnv } from '@agentos/config';
import { tenantContext, type Automation, type AutomationRun, type RiskLevel } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TasksService } from '../tasks/tasks.service';
import { AutomationRunsService } from './automation-runs.service';
import { AUTOMATION_QUEUE, type AutomationJobData } from '../queue/queue.constants';
import type { CreateAutomationDto, UpdateAutomationDto } from './dto';

/**
 * Recurring, self-running agent tasks. Each enabled automation is registered as a BullMQ job
 * scheduler (cron); on each tick a fresh Task is created and dispatched through the normal task
 * pipeline. Scheduling requires queue mode (Redis); without it, CRUD still works but nothing fires.
 */
@Injectable()
export class AutomationsService implements OnModuleInit {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly runs: AutomationRunsService,
    @Inject(AUTOMATION_QUEUE) private readonly queue: Queue<AutomationJobData> | null,
  ) {}

  /**
   * On boot, reconcile schedulers with the DB: (re)register every enabled automation (upsert is
   * idempotent) and PRUNE any persisted scheduler in Redis that no longer maps to an enabled
   * automation (deleted while the process was down, or left by a prior instance).
   */
  async onModuleInit(): Promise<void> {
    if (!this.queue) return;
    // Cross-workspace boot reconcile runs outside any request → system (RLS-bypass) context, or the
    // policy would deny the read and we'd prune every live scheduler as an orphan. Mirrors the
    // TasksService boot reaper.
    const enabled = await tenantContext.runSystem(async () => {
      const rows = await this.prisma.automation.findMany({ where: { enabled: true } });
      return rows;
    });
    const enabledIds = new Set(enabled.map((a) => a.id));
    for (const a of enabled) {
      await this.schedule(a).catch((err) =>
        this.logger.error(`reconcile ${a.id} failed: ${err instanceof Error ? err.message : err}`),
      );
    }
    // Prune orphaned schedulers (their scheduler id is the automation id). BullMQ returns the
    // scheduler id in `key`, NOT `id` (which is an unset legacy field) — using `id` here meant the
    // guard was always false and nothing was ever pruned, so disabled/deleted automations kept
    // firing forever.
    let pruned = 0;
    const existing = await this.queue.getJobSchedulers(0, -1).catch(() => []);
    for (const sched of existing) {
      if (sched.key && !enabledIds.has(sched.key)) {
        await this.queue.removeJobScheduler(sched.key).catch(() => undefined);
        pruned += 1;
      }
    }
    if (enabled.length || pruned) {
      this.logger.log(`Reconciled ${enabled.length} automation schedule(s); pruned ${pruned} orphan(s).`);
    }
  }

  /** A referenced project must belong to THIS workspace (no cross-tenant project references). */
  private async assertProject(workspaceId: string, projectId: string | undefined): Promise<void> {
    if (!projectId) return;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found in this workspace.');
  }

  async create(workspaceId: string, userId: string, dto: CreateAutomationDto): Promise<Automation> {
    await this.assertProject(workspaceId, dto.projectId);
    const automation = await this.prisma.automation.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        projectId: dto.projectId ?? null,
        name: dto.name,
        prompt: dto.prompt,
        cronExpression: dto.cronExpression,
        timezone: dto.timezone,
        riskCeiling: dto.riskCeiling as RiskLevel,
        enabled: dto.enabled,
        ...(dto.stepBudget !== undefined ? { stepBudget: dto.stepBudget } : {}),
        ...(dto.costBudgetUsd !== undefined ? { costBudgetUsd: dto.costBudgetUsd } : {}),
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'automation.create',
      targetType: 'automation',
      targetId: automation.id,
      metadata: { name: automation.name, cron: automation.cronExpression },
    });
    if (automation.enabled) await this.schedule(automation);
    return automation;
  }

  async update(
    workspaceId: string,
    automationId: string,
    userId: string,
    dto: UpdateAutomationDto,
  ): Promise<Automation> {
    await this.require(workspaceId, automationId);
    await this.assertProject(workspaceId, dto.projectId);
    const automation = await this.prisma.automation.update({
      where: { id: automationId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.prompt !== undefined ? { prompt: dto.prompt } : {}),
        ...(dto.cronExpression !== undefined ? { cronExpression: dto.cronExpression } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.riskCeiling !== undefined ? { riskCeiling: dto.riskCeiling as RiskLevel } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.stepBudget !== undefined ? { stepBudget: dto.stepBudget } : {}),
        ...(dto.costBudgetUsd !== undefined ? { costBudgetUsd: dto.costBudgetUsd } : {}),
        ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
      },
    });
    // Re-sync the schedule with the new state.
    if (automation.enabled) await this.schedule(automation);
    else await this.unschedule(automationId);
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'automation.update',
      targetType: 'automation',
      targetId: automationId,
    });
    return automation;
  }

  async remove(workspaceId: string, automationId: string, userId: string): Promise<{ deleted: true }> {
    await this.require(workspaceId, automationId);
    await this.unschedule(automationId);
    await this.prisma.automation.delete({ where: { id: automationId } });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'automation.delete',
      targetType: 'automation',
      targetId: automationId,
    });
    return { deleted: true };
  }

  list(workspaceId: string): Promise<Automation[]> {
    return this.prisma.automation.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  get(workspaceId: string, automationId: string): Promise<Automation> {
    return this.require(workspaceId, automationId);
  }

  /** Run an automation now: create a Task from it and dispatch through the task pipeline. */
  async runAutomation(automationId: string): Promise<string | null> {
    const automation = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!automation || !automation.enabled) return null;
    const task = await this.tasks.createAndStart(automation.workspaceId, automation.createdByUserId, {
      title: automation.name,
      prompt: automation.prompt,
      riskCeiling: automation.riskCeiling,
      ...(automation.projectId ? { projectId: automation.projectId } : {}),
      stepBudget: automation.stepBudget,
      ...(automation.costBudgetUsd !== null ? { costBudgetUsd: Number(automation.costBudgetUsd) } : {}),
    });
    await this.prisma.automation.update({
      where: { id: automationId },
      data: { lastRunAt: new Date(), lastTaskId: task.id },
    });
    return task.id;
  }

  // --- Durable AutomationRun layer (TICKET-AUTOMATION) — only active when AUTOMATION_RUNS_ENABLED ---

  /** Worker entry point for a fire. Flag-off → legacy fire (byte-identical). Flag-on → durable run:
   * a retry job (runId) re-launches its pre-created run; a scheduled tick creates/reuses a run for its
   * scheduled-time key (idempotent + overlap-skipped) and launches the task. */
  async handleFire(data: AutomationJobData, firedAtMs: number): Promise<string | null> {
    if (!loadServerEnv().AUTOMATION_RUNS_ENABLED) return this.runAutomation(data.automationId);
    if (data.runId) return this.runRetryRun(data.runId);
    const automation = await this.prisma.automation.findUnique({ where: { id: data.automationId } });
    if (!automation || !automation.enabled) return null; // disabled/deleted → no run
    const key = this.runs.scheduledFireKeyFor(firedAtMs);
    // Reuse an existing run for this EXACT fire (a BullMQ retry of a failed dispatch re-launches the
    // still-pending run); a non-pending existing run means it's already handled (idempotent).
    const existing = await this.prisma.automationRun.findUnique({
      where: { automationId_scheduledFireKey_attempt: { automationId: automation.id, scheduledFireKey: key, attempt: 0 } },
    });
    if (existing) return existing.status === 'pending' ? this.launchTask(automation, existing) : null;
    const run = await this.runs.beginFire(automation, 'scheduled', key, 0);
    if (!run) return null; // overlap-skipped or duplicate delivery
    return this.launchTask(automation, run);
  }

  /** Execute a pre-created retry run (enqueued by the run-level retry on task failure). */
  private async runRetryRun(runId: string): Promise<string | null> {
    const run = await this.runs.getRun(runId);
    if (!run || run.status !== 'pending') return null;
    const automation = await this.prisma.automation.findUnique({ where: { id: run.automationId } });
    if (!automation || !automation.enabled) {
      await this.runs.markFireFailed(runId, 'automation disabled or deleted before retry');
      return null;
    }
    return this.launchTask(automation, run);
  }

  /** Create + start the Task for a run, linked back via automationRunId. If task creation throws, the
   * run stays pending so BullMQ's fire-dispatch retry can re-attempt; onFireExhausted fails it finally. */
  private async launchTask(automation: Automation, run: AutomationRun): Promise<string | null> {
    const task = await this.tasks.createAndStart(
      automation.workspaceId,
      automation.createdByUserId,
      {
        title: automation.name,
        prompt: automation.prompt,
        riskCeiling: automation.riskCeiling,
        ...(automation.projectId ? { projectId: automation.projectId } : {}),
        stepBudget: automation.stepBudget,
        ...(automation.costBudgetUsd !== null ? { costBudgetUsd: Number(automation.costBudgetUsd) } : {}),
      },
      { automationRunId: run.id },
    );
    await this.runs.markRunning(run.id, task.id);
    await this.prisma.automation.update({ where: { id: automation.id }, data: { lastRunAt: new Date(), lastTaskId: task.id } });
    return task.id;
  }

  /** Called when a fire job exhausts its BullMQ attempts: mark the still-pending run failed (no orphan). */
  async onFireExhausted(data: AutomationJobData, firedAtMs: number): Promise<void> {
    if (!loadServerEnv().AUTOMATION_RUNS_ENABLED) return;
    if (data.runId) {
      const r = await this.runs.getRun(data.runId);
      if (r && r.status === 'pending') await this.runs.markFireFailed(data.runId, 'fire dispatch exhausted retries');
      return;
    }
    const key = this.runs.scheduledFireKeyFor(firedAtMs);
    const run = await this.prisma.automationRun.findUnique({
      where: { automationId_scheduledFireKey_attempt: { automationId: data.automationId, scheduledFireKey: key, attempt: 0 } },
    });
    if (run && run.status === 'pending') await this.runs.markFireFailed(run.id, 'fire dispatch exhausted retries');
  }

  /** Trigger an automation immediately (user-initiated), independent of its schedule. */
  async runNow(workspaceId: string, automationId: string, userId: string): Promise<{ taskId: string | null }> {
    const automation = await this.require(workspaceId, automationId);
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'automation.run_now',
      targetType: 'automation',
      targetId: automationId,
    });
    if (loadServerEnv().AUTOMATION_RUNS_ENABLED) {
      if (!automation.enabled) return { taskId: null };
      const run = await this.runs.beginManualFire(automation);
      if (!run) return { taskId: null }; // overlap-skipped (an active run is in progress)
      return { taskId: await this.launchTask(automation, run) };
    }
    return { taskId: await this.runAutomation(automationId) };
  }

  /** Read run history for an automation (UI/API). */
  async listRuns(workspaceId: string, automationId: string): Promise<AutomationRun[]> {
    await this.require(workspaceId, automationId);
    return this.runs.listRuns(automationId);
  }

  private async schedule(a: Automation): Promise<void> {
    if (!this.queue) return;
    const env = loadServerEnv();
    // Fire-dispatch retry (TICKET-AUTOMATION): when durable runs are on, transient errors creating the
    // run/task are retried by BullMQ (idempotent via the scheduled-fire key). Off → attempts:1 as today.
    const opts = env.AUTOMATION_RUNS_ENABLED
      ? { attempts: env.AUTOMATION_MAX_RETRIES + 1, backoff: { type: 'exponential' as const, delay: env.AUTOMATION_RETRY_BACKOFF_MS } }
      : undefined;
    await this.queue.upsertJobScheduler(
      a.id,
      { pattern: a.cronExpression, tz: a.timezone },
      { name: 'fire', data: { automationId: a.id }, ...(opts ? { opts } : {}) },
    );
  }

  private async unschedule(automationId: string): Promise<void> {
    if (!this.queue) return;
    await this.queue.removeJobScheduler(automationId).catch(() => undefined);
  }

  private async require(workspaceId: string, automationId: string): Promise<Automation> {
    const a = await this.prisma.automation.findFirst({ where: { id: automationId, workspaceId } });
    if (!a) throw new NotFoundException('Automation not found in this workspace.');
    return a;
  }
}
