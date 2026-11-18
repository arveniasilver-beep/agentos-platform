import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { Worker, type Job } from 'bullmq';
import { loadServerEnv } from '@agentos/config';
import { TasksService } from '../tasks/tasks.service';
import { AGENT_TASK_QUEUE, type RunJobData } from './queue.constants';

/**
 * In-process BullMQ worker. In queue mode it drains the agent-task queue, running each task through
 * the same TasksService.runTask path the inline executor uses. Its own (blocking) Redis connection
 * is separate from the producer's, per BullMQ guidance. No-op when not in queue mode.
 */
@Injectable()
export class TaskWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskWorker.name);
  private worker?: Worker<RunJobData>;
  private connection?: Redis;

  constructor(private readonly tasks: TasksService) {}

  onModuleInit(): void {
    const env = loadServerEnv();
    if (env.EXECUTION_MODE !== 'queue' || !env.REDIS_URL) {
      return;
    }
    this.connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.worker = new Worker<RunJobData>(
      AGENT_TASK_QUEUE,
      async (job: Job<RunJobData>) => {
        await this.tasks.runTask(job.data.taskId);
      },
      {
        connection: this.connection,
        concurrency: 4,
        // Stalled-job recovery (Ticket-04b): if a worker dies mid-run (crash, OOM, deploy) its job would
        // otherwise sit locked forever. BullMQ re-queues a job whose lock wasn't renewed within
        // stalledInterval; maxStalledCount caps how many times it may be recovered before it's failed for
        // good (so a job that reliably KILLS its worker can't loop infinitely). With RESUME_ENABLED the
        // re-run resumes from the last checkpoint instead of restarting from scratch.
        stalledInterval: 30_000,
        maxStalledCount: 2,
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} (task ${job?.data.taskId}) failed: ${err.message}`);
    });
    this.worker.on('stalled', (jobId) => {
      this.logger.warn(`Job ${jobId} stalled (worker died mid-run); re-queued for recovery.`);
    });
    this.logger.log('Task worker started (queue mode).');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }
}
