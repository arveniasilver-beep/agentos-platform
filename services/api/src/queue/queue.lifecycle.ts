import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AUTOMATION_QUEUE, REDIS_CONNECTION, TASK_QUEUE } from './queue.constants';

/**
 * Closes the producer-side BullMQ queues and the shared Redis connection on shutdown (workers close
 * their own connections). Without this they leak open sockets and hold up a graceful drain.
 */
@Injectable()
export class QueueLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(QueueLifecycle.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis | null,
    @Inject(TASK_QUEUE) private readonly taskQueue: Queue | null,
    @Inject(AUTOMATION_QUEUE) private readonly automationQueue: Queue | null,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.taskQueue?.close().catch(() => undefined);
    await this.automationQueue?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
    if (this.connection) this.logger.log('Closed task/automation queues + Redis connection.');
  }
}
