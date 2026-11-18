import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { Worker, type Job } from 'bullmq';
import { tenantContext } from '@agentos/db';
import { loadServerEnv } from '@agentos/config';
import { AutomationsService } from './automations.service';
import { AGENT_AUTOMATION_QUEUE, type AutomationJobData } from '../queue/queue.constants';

/**
 * In-process worker that drains scheduled automation fires: on each cron tick it asks the
 * AutomationsService to create + run a task. No-op outside queue mode.
 */
@Injectable()
export class AutomationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationWorker.name);
  private worker?: Worker<AutomationJobData>;
  private connection?: Redis;

  constructor(private readonly automations: AutomationsService) {}

  onModuleInit(): void {
    const env = loadServerEnv();
    if (env.EXECUTION_MODE !== 'queue' || !env.REDIS_URL) return;
    this.connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.worker = new Worker<AutomationJobData>(
      AGENT_AUTOMATION_QUEUE,
      async (job: Job<AutomationJobData>) => {
        // The fire is resolved by automationId across workspaces → trusted system (RLS-bypass) work.
        // handleFire branches on AUTOMATION_RUNS_ENABLED (durable run vs legacy fire). job.timestamp is
        // the scheduled-tick time, used to derive a stable, drift-tolerant fire key (not "now").
        await tenantContext.runSystem(() => this.automations.handleFire(job.data, job.timestamp));
      },
      // Stalled-job recovery (Ticket-04b): re-claim an automation fire whose worker died mid-run; cap the
      // recoveries so a poison fire can't loop. The fire key is derived from the scheduled tick, so a
      // recovered fire is still idempotent (no duplicate run for the same tick).
      { connection: this.connection, concurrency: 2, stalledInterval: 30_000, maxStalledCount: 2 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Automation ${job?.data.automationId} fire failed: ${err.message}`);
      // After all BullMQ fire-dispatch attempts are exhausted, finalize the still-pending run as failed.
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void tenantContext
          .runSystem(() => this.automations.onFireExhausted(job.data, job.timestamp))
          .catch(() => undefined);
      }
    });
    this.logger.log('Automation worker started (queue mode).');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }
}
