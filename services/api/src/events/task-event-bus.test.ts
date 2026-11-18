import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentEvent } from '@agentos/protocol';
import { TaskEventBus } from './task-event-bus';

// LIVE-COMPUTER live-path coverage: the screencast transport (publishFrame throttle + frame fan-out) and
// the per-task event pub/sub had ZERO tests. This is a pure in-process class, so these run without infra.

const ev = (taskId: string): AgentEvent => ({ type: 'status', taskId, seq: 0, state: 'running' } as AgentEvent);

afterEach(() => vi.useRealTimers());

describe('TaskEventBus (LIVE-COMPUTER transport)', () => {
  it('delivers a published event only to that task\'s subscriber, and stops after unsubscribe', () => {
    const bus = new TaskEventBus();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    const off = bus.subscribe('A', (e) => a.push(e));
    bus.subscribe('B', (e) => b.push(e));

    bus.publish('A', ev('A'));
    expect(a).toHaveLength(1); // reached A
    expect(b).toHaveLength(0); // per-task isolation: B did not

    off();
    bus.publish('A', ev('A'));
    expect(a).toHaveLength(1); // unsubscribed -> no further delivery
  });

  it('publishFrame throttles to the frame interval, dropping in-between frames', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000); // non-zero base so the first frame isn't dropped by now-0 < interval
    const bus = new TaskEventBus();
    const got: string[] = [];
    bus.subscribeFrames('t', (f) => got.push(f));

    bus.publishFrame('t', 'f1'); // first -> passes
    bus.publishFrame('t', 'f2'); // same ms -> dropped
    vi.advanceTimersByTime(40);
    bus.publishFrame('t', 'f3'); // 40ms < 80ms -> dropped
    vi.advanceTimersByTime(50); // 90ms since f1
    bus.publishFrame('t', 'f4'); // >= 80ms -> passes

    expect(got).toEqual(['f1', 'f4']);
  });

  it('fans a frame to every subscriber and resets throttle state when the last one leaves', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const bus = new TaskEventBus();
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.subscribeFrames('t', (f) => a.push(f));
    const offB = bus.subscribeFrames('t', (f) => b.push(f));

    bus.publishFrame('t', 'f1');
    expect(a).toEqual(['f1']);
    expect(b).toEqual(['f1']); // fan-out to both

    offA();
    offB(); // last subscriber leaves -> per-task throttle state is cleared

    const a2: string[] = [];
    bus.subscribeFrames('t', (f) => a2.push(f));
    bus.publishFrame('t', 'f2'); // SAME timestamp as f1, but throttle reset on last-unsubscribe -> passes
    expect(a2).toEqual(['f2']);
  });

  it('frames are isolated per task', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const bus = new TaskEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribeFrames('A', (f) => a.push(f));
    bus.subscribeFrames('B', (f) => b.push(f));

    bus.publishFrame('A', 'fa');
    expect(a).toEqual(['fa']);
    expect(b).toEqual([]); // task B saw nothing
  });
});
