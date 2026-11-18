/** Injection tokens + names for the agent task + automation queues. */
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
export const TASK_QUEUE = Symbol('TASK_QUEUE');
export const AUTOMATION_QUEUE = Symbol('AUTOMATION_QUEUE');

/** BullMQ queue name for agent task runs. */
export const AGENT_TASK_QUEUE = 'agent-tasks';
/** BullMQ queue name for scheduled automation fires (cron via job schedulers). */
export const AGENT_AUTOMATION_QUEUE = 'agent-automations';

/** Payload for a queued task run. The row already holds everything else. */
export interface RunJobData {
  taskId: string;
}

/** Payload for an automation fire — a scheduler emits this on the cron tick. With AUTOMATION_RUNS_ENABLED,
 * a run-level retry enqueues the same payload carrying the pre-created retry `runId`. */
export interface AutomationJobData {
  automationId: string;
  /** Set for a run-level retry job: the AutomationRun to execute (instead of starting a fresh fire). */
  runId?: string;
}
