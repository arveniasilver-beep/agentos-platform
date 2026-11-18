import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from '../queue/queue.constants';

/**
 * A cross-replica notification that a task's durable control state (its kill-switch flag or a
 * pending approval) changed in the database and should be re-read. It carries ONLY the taskId —
 * never the decision itself. This makes the live channel a pure latency optimization over the
 * persisted state: a delivered signal just prompts an earlier DB re-read, and a forged or
 * malformed signal can at most trigger a harmless re-read (the applied result always comes from
 * the DB row, never from the wire).
 */
export interface TaskControlSignal {
  taskId: string;
}

/** Applies a signal by reconciling the named task against the DB, if it runs on this replica. */
export type TaskControlHandler = (signal: TaskControlSignal) => void;

/** Redis pub/sub channel the control notifications fan out on. */
export const TASK_CONTROL_CHANNEL = 'agentos:task-control';

/**
 * Cross-replica delivery of stop/approval notifications.
 *
 * The RunController for a running task lives in-memory on exactly one process — the replica that
 * picked the job off the queue. An operator's stop/approve request, however, can land on ANY
 * replica's HTTP layer. This bus closes that gap: the receiving replica broadcasts the taskId on a
 * Redis channel, every replica receives it, and the one running the task re-reads the durable
 * control state and applies it to its local controller (the rest no-op).
 *
 * Delivery is fire-and-forget, by design. The durable source of truth is the database (the
 * `killRequested` flag and the `approvals` row); this channel only makes a replica re-read it
 * sooner. A signal lost to a Redis blip or the brief subscribe-on-startup window is recovered by
 * the periodic DB reconciliation in TasksService, so no stop or decision is ever lost — it is only
 * ever delivered a little later. ioredis automatically re-subscribes tracked channels after a
 * reconnect, so the subscription itself survives connection drops.
 *
 * Without Redis (inline / single-process mode) there are no peers to notify, so publish() is a
 * no-op: the single process applies the change to its local controller directly.
 */
@Injectable()
export class TaskControlBus implements OnModuleDestroy {
  private readonly logger = new Logger(TaskControlBus.name);
  private readonly sub: Redis | null;
  private handler: TaskControlHandler | null = null;

  constructor(@Inject(REDIS_CONNECTION) private readonly pub: Redis | null) {
    // A connection in subscriber mode can't issue normal commands, so the subscriber must be a
    // dedicated connection — duplicate() clones the shared connection's options.
    this.sub = pub ? pub.duplicate() : null;
    if (this.sub) {
      this.sub.on('error', (err) => this.logger.error(`control subscriber: ${err.message}`));
      this.sub.on('message', (channel, message) => {
        if (channel === TASK_CONTROL_CHANNEL) this.dispatch(message);
      });
      void this.sub
        .subscribe(TASK_CONTROL_CHANNEL)
        .catch((err: unknown) =>
          this.logger.error(`control subscribe failed: ${err instanceof Error ? err.message : err}`),
        );
    }
  }

  /** Register the local applier. Called once by TasksService. Last registration wins. */
  onSignal(handler: TaskControlHandler): void {
    this.handler = handler;
  }

  /**
   * Notify every replica that taskId's control state changed. Fire-and-forget: a Redis stall must
   * never block the operator's stop/approval request — the durable DB write has already committed,
   * and the periodic reconciler is the backstop. A no-op without Redis (a single process has no
   * peers and applies the change directly).
   */
  publish(taskId: string): void {
    if (!this.pub) return;
    void this.pub
      .publish(TASK_CONTROL_CHANNEL, JSON.stringify({ taskId }))
      .catch((err: unknown) =>
        this.logger.error(`control publish failed: ${err instanceof Error ? err.message : err}`),
      );
  }

  private dispatch(message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.logger.warn('dropped malformed task-control message');
      return;
    }
    // The channel is internal, but never trust wire data: require the exact shape before applying.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { taskId?: unknown }).taskId !== 'string'
    ) {
      this.logger.warn('dropped task-control message with unexpected shape');
      return;
    }
    this.handler?.({ taskId: (parsed as { taskId: string }).taskId });
  }

  async onModuleDestroy(): Promise<void> {
    // Only the dedicated subscriber is owned here; the shared `pub` connection is closed by the
    // QueueModule lifecycle.
    if (this.sub) await this.sub.quit().catch(() => undefined);
  }
}
