import { Global, Module } from '@nestjs/common';
import {
  redisConnectionProvider,
  taskQueueProvider,
  automationQueueProvider,
} from './queue.providers';
import { QueueLifecycle } from './queue.lifecycle';
import { AUTOMATION_QUEUE, REDIS_CONNECTION, TASK_QUEUE } from './queue.constants';

/**
 * Provides the Redis connection + BullMQ task/automation queues (all null in inline mode). Global
 * so the tasks/automations layers can inject the queue tokens without importing this module
 * everywhere. Workers live in their feature modules (they depend on the feature services).
 */
@Global()
@Module({
  providers: [redisConnectionProvider, taskQueueProvider, automationQueueProvider, QueueLifecycle],
  exports: [REDIS_CONNECTION, TASK_QUEUE, AUTOMATION_QUEUE],
})
export class QueueModule {}
