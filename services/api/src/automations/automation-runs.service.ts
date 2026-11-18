import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { loadServerEnv } from '@agentos/config';
import type { Automation, AutomationRun } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AUTOMATION_QUEUE, type AutomationJobData } from '../queue/queue.constants';

/** A run is "active" (blocks a new overlapping fire) while in any of these states. */
const ACTIVE_STATES = ['pending', 'running', 'awaiting_approval'];
/** Task terminal states the run mirrors. */
type TaskTerminal = 'completed' | 'failed' | 'stopped';

/**
 * Durable AutomationRun lifecycle (TICKET-AUTOMATION). Deliberately has NO dependency on TasksService,
 * so BOTH AutomationsService (which owns TasksService) and TasksService (terminal sync) can inject it
 * without a circular module graph. Idempotency + retry-safety come from the DB unique
 * [automationId, scheduledFireKey, attempt]; overlap is prevented by the ACTIVE_STATES check.
 * Every method is a no-op caller-side unless AUTOMATION_RUNS_ENABLED — the caller gates on the flag.
 */
@Injectable()
export class AutomationRunsService {
  private readonly logger = new Logger(AutomationRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(AUTOMATION_QUEUE) private readonly queue: Queue<AutomationJobData> | null,
  ) {}

  /** A deterministic, scheduled-timestamp-derived fire key (NOT "now"): the minute bucket of the
   * scheduled tick. Two deliveries of the same tick share it (dedup); consecutive ticks differ. */
  scheduledFireKeyFor(firedAtMs: number): string {
    return `sched:${Math.floor(firedAtMs / 60_000)}`;
  }

  private isUniqueViolation(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
  }

  private async record(action: string, run: AutomationRun, extra?: Record<string, unknown>): Promise<void> {
    await this.audit
      .record({
        workspaceId: run.workspaceId,
        actorType: 'system',
        action,
        targetType: 'automation_run',
        targetId: run.id,
        metadata: { automationId: run.automationId, triggeredBy: run.triggeredBy, attempt: run.attempt, scheduledFireKey: run.scheduledFireKey, ...extra },
      })
      .catch(() => undefined);
  }

  /** True if the automation already has an active (pending/running/awaiting_approval) run. */
  private async hasActiveRun(automationId: string): Promise<boolean> {
    const active = await this.prisma.automationRun.findFirst({
      where: { automationId, status: { in: ACTIVE_STATES } },
      select: { id: true },
    });
    return !!active;
  }

  /** Record a skipped fire (overlap or duplicate) for observability. Idempotent on the unique key. */
  private async recordSkipped(automation: Automation, triggeredBy: string, scheduledFireKey: string, reason: string): Promise<void> {
    try {
      const run = await this.prisma.automationRun.create({
        data: { automationId: automation.id, workspaceId: automation.workspaceId, status: 'skipped', triggeredBy, scheduledFireKey, attempt: 0, skipReason: reason, finishedAt: new Date() },
      });
      await this.record('automation.run.skipped', run, { reason });
    } catch (e) {
      if (!this.isUniqueViolation(e)) throw e; // duplicate skip record — fine
    }
  }

  /**
   * Begin a fire: overlap-skip if an active run exists, else create a pending run. Returns the run, or
   * null when skipped (overlap) or when the same fire was already created (duplicate delivery).
   */
  async beginFire(automation: Automation, triggeredBy: 'manual' | 'scheduled', scheduledFireKey: string, attempt = 0, retryOfRunId?: string): Promise<AutomationRun | null> {
    if (attempt === 0 && (await this.hasActiveRun(automation.id))) {
      await this.recordSkipped(automation, triggeredBy, scheduledFireKey, 'overlap: an active run is still in progress');
      return null;
    }
    try {
      const run = await this.prisma.automationRun.create({
        data: {
          automationId: automation.id,
          workspaceId: automation.workspaceId,
          status: 'pending',
          triggeredBy,
          scheduledFireKey,
          attempt,
          ...(retryOfRunId ? { retryOfRunId } : {}),
        },
      });
      await this.record('automation.run.created', run);
      return run;
    } catch (e) {
      if (this.isUniqueViolation(e)) return null; // duplicate delivery of the same (fireKey, attempt)
      throw e;
    }
  }

  /** New scheduled-fire convenience: derives a manual UUID key or accepts a scheduled key. */
  beginManualFire(automation: Automation): Promise<AutomationRun | null> {
    return this.beginFire(automation, 'manual', `manual:${randomUUID()}`, 0);
  }

  /** Mark a run as launched (its task created + dispatched). */
  async markRunning(runId: string, taskId: string): Promise<void> {
    const run = await this.prisma.automationRun.update({ where: { id: runId }, data: { status: 'running', taskId, startedAt: new Date() } });
    await this.record('automation.run.started', run, { taskId });
  }

  /** Mark a run as waiting on a human approval (mirrors the task's waiting_for_approval state). */
  async markAwaitingApproval(runId: string): Promise<void> {
    const run = await this.prisma.automationRun.findUnique({ where: { id: runId } });
    if (!run || run.status === 'awaiting_approval') return;
    const updated = await this.prisma.automationRun.update({ where: { id: runId }, data: { status: 'awaiting_approval' } });
    await this.record('automation.run.awaiting_approval', updated);
  }

  /** Sync a run from its launched task's terminal status. On failure, schedule a run-level retry
   * (new attempt) up to AUTOMATION_MAX_RETRIES; otherwise the run is terminal. */
  async onTaskTerminal(runId: string, taskStatus: TaskTerminal, errorText?: string): Promise<void> {
    const run = await this.prisma.automationRun.findUnique({ where: { id: runId } });
    if (!run || ['completed', 'failed', 'skipped'].includes(run.status)) return; // already terminal/idempotent
    if (taskStatus === 'completed') {
      const updated = await this.prisma.automationRun.update({ where: { id: runId }, data: { status: 'completed', finishedAt: new Date() } });
      await this.record('automation.run.completed', updated, { taskId: run.taskId });
      return;
    }
    // failed or stopped → mark this attempt failed, then maybe schedule a retry attempt.
    const reason = `task ${taskStatus}${errorText ? `: ${errorText}` : ''}`.slice(0, 500);
    const failed = await this.prisma.automationRun.update({ where: { id: runId }, data: { status: 'failed', failureReason: reason, finishedAt: new Date() } });
    await this.record('automation.run.failed', failed, { taskStatus });
    const env = loadServerEnv();
    if (taskStatus === 'failed' && run.attempt < env.AUTOMATION_MAX_RETRIES && this.queue) {
      const automation = await this.prisma.automation.findUnique({ where: { id: run.automationId } });
      if (automation && automation.enabled) {
        const retry = await this.beginFire(automation, run.triggeredBy as 'manual' | 'scheduled', run.scheduledFireKey, run.attempt + 1, run.id);
        if (retry) {
          const delay = env.AUTOMATION_RETRY_BACKOFF_MS * Math.pow(2, run.attempt);
          await this.queue.add('retry', { automationId: automation.id, runId: retry.id }, { delay, attempts: 1, removeOnComplete: true, removeOnFail: true }).catch(() => undefined);
          await this.record('automation.run.retry_scheduled', retry, { delayMs: delay, ofRunId: run.id });
        }
      }
    }
  }

  /** A human denied this run's approval → terminal failure (the gated action never ran). Guarded so a
   * later terminal sync can't override it. (TICKET-AUTOMATION condition 5.) */
  async markDenied(runId: string): Promise<void> {
    const run = await this.prisma.automationRun.findUnique({ where: { id: runId } });
    if (!run || ['completed', 'failed', 'skipped'].includes(run.status)) return;
    const updated = await this.prisma.automationRun.update({ where: { id: runId }, data: { status: 'failed', failureReason: 'approval denied by user', finishedAt: new Date() } });
    await this.record('automation.run.failed', updated, { phase: 'approval_denied' });
  }

  /** Mark a run failed without a task (e.g., the fire could not create a task). */
  async markFireFailed(runId: string, reason: string): Promise<void> {
    const run = await this.prisma.automationRun.update({ where: { id: runId }, data: { status: 'failed', failureReason: reason.slice(0, 500), finishedAt: new Date() } }).catch(() => null);
    if (run) await this.record('automation.run.failed', run, { phase: 'fire' });
  }

  /** Run history for an automation (newest first), for the UI/API. */
  listRuns(automationId: string, limit = 50): Promise<AutomationRun[]> {
    return this.prisma.automationRun.findMany({ where: { automationId }, orderBy: { createdAt: 'desc' }, take: limit });
  }

  getRun(runId: string): Promise<AutomationRun | null> {
    return this.prisma.automationRun.findUnique({ where: { id: runId } });
  }
}
