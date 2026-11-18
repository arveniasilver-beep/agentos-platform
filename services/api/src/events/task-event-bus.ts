import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@agentos/protocol';

type Handler = (event: AgentEvent) => void;

/**
 * In-process pub/sub for live task events, keyed by taskId. The run path publishes each persisted
 * event here; the WebSocket gateway subscribes per task and forwards to connected clients.
 *
 * This is the seam for cross-process streaming: when the worker is split out, swap this for a
 * Redis pub/sub implementation behind the same publish/subscribe interface — no caller changes.
 */
@Injectable()
export class TaskEventBus {
  private readonly emitter = new EventEmitter();

  // Separate channel for the live browser screencast (transient JPEG frames — NOT persisted, kept off
  // the ordered/flushed agent-event path).
  private readonly frames = new EventEmitter();
  // Per-task throttle so a fast screencast coalesces to ~latest-frame at a bounded rate (drop the
  // in-between frames) — prevents unbounded fan-out/memory under load.
  private readonly lastFrameAt = new Map<string, number>();
  private static readonly FRAME_MIN_INTERVAL_MS = 80; // ~12fps ceiling

  constructor() {
    // Many sockets may watch one busy task; lift the default 10-listener warning ceiling.
    this.emitter.setMaxListeners(0);
    this.frames.setMaxListeners(0);
  }

  publish(taskId: string, event: AgentEvent): void {
    this.emitter.emit(taskId, event);
  }

  /** Subscribe to a task's events. Returns an unsubscribe function. */
  subscribe(taskId: string, handler: Handler): () => void {
    this.emitter.on(taskId, handler);
    return () => this.emitter.off(taskId, handler);
  }

  /** Publish a live browser frame (base64 JPEG) for a task — throttled to a bounded rate. */
  publishFrame(taskId: string, jpegBase64: string): void {
    const now = Date.now();
    const last = this.lastFrameAt.get(taskId) ?? 0;
    if (now - last < TaskEventBus.FRAME_MIN_INTERVAL_MS) return; // drop the in-between frame
    this.lastFrameAt.set(taskId, now);
    this.frames.emit(taskId, jpegBase64);
  }

  /** Subscribe to a task's live browser frames. Returns an unsubscribe function. */
  subscribeFrames(taskId: string, handler: (jpegBase64: string) => void): () => void {
    this.frames.on(taskId, handler);
    return () => {
      this.frames.off(taskId, handler);
      if (this.frames.listenerCount(taskId) === 0) this.lastFrameAt.delete(taskId);
    };
  }
}
