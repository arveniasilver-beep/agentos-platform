import { Logger, type Provider } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadServerEnv } from '@agentos/config';
import {
  AGENT_AUTOMATION_QUEUE,
  AGENT_TASK_QUEUE,
  AUTOMATION_QUEUE,
  REDIS_CONNECTION,
  TASK_QUEUE,
} from './queue.constants';

/**
 * A shared ioredis connection, or null when no REDIS_URL is configured. BullMQ requires
 * `maxRetriesPerRequest: null` on its connections.
 */
export const redisConnectionProvider: Provider = {
  provide: REDIS_CONNECTION,
  useFactory: (): Redis | null => {
    const env = loadServerEnv();
    if (!env.REDIS_URL) {
      return null;
    }
    const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    conn.on('error', (err) => new Logger('Redis').error(err.message));
    return conn;
  },
};

/**
 * The BullMQ task queue, or null in inline mode / without Redis. Producers inject TASK_QUEUE and
 * skip enqueueing when it is null (falling back to inline execution).
 */
export const taskQueueProvider: Provider = {
  provide: TASK_QUEUE,
  inject: [REDIS_CONNECTION],
  useFactory: (connection: Redis | null): Queue | null => {
    const env = loadServerEnv();
    if (env.EXECUTION_MODE !== 'queue' || !connection) {
      return null;
    }
    return new Queue(AGENT_TASK_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  },
};

/** The automations queue (cron job schedulers fire onto it). Null in inline mode / without Redis. */
export const automationQueueProvider: Provider = {
  provide: AUTOMATION_QUEUE,
  inject: [REDIS_CONNECTION],
  useFactory: (connection: Redis | null): Queue | null => {
    const env = loadServerEnv();
    if (env.EXECUTION_MODE !== 'queue' || !connection) {
      return null;
    }
    return new Queue(AGENT_AUTOMATION_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } },
    });
  },
};
