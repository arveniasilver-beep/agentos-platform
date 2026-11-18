import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@agentos/protocol';
import { reduceEvents, deriveCursors, RESUMABLE_STATE_VERSION } from './resume';

const TASK = 't1';
function ev(partial: Partial<AgentEvent> & { type: AgentEvent['type']; seq: number }): AgentEvent {
  return { taskId: TASK, ...partial } as AgentEvent;
}

// A small representative log: plan -> running -> one tool call (ok) -> one approval -> cost.
function sampleEvents(): AgentEvent[] {
  return [
    ev({ type: 'status', seq: 0, state: 'planning' }),
    ev({ type: 'plan', seq: 1, summary: 'p', steps: [{ id: 's0', title: 'a', description: '', status: 'pending' }] }),
    ev({ type: 'cost_estimate', seq: 2, inputTokens: 10, outputTokens: 2, estimatedUsd: 0.01, overThreshold: false }),
    ev({ type: 'status', seq: 3, state: 'running' }),
    ev({ type: 'cost_estimate', seq: 4, inputTokens: 30, outputTokens: 5, estimatedUsd: 0.03, overThreshold: false }),
    ev({ type: 'tool_call', seq: 5, callId: `${TASK}-c0`, tool: 'web_search', riskLevel: 'low', input: { q: 'x' } }),
    ev({ type: 'tool_result', seq: 6, callId: `${TASK}-c0`, ok: true, output: { r: 1 } }),
    ev({ type: 'approval_request', seq: 7, approvalId: `${TASK}-a0`, riskLevel: 'high', action: 'shell_exec', reason: 'r' }),
  ];
}

describe('resume reducer', () => {
  it('is pure/deterministic — same input yields deep-equal output', () => {
    const e = sampleEvents();
    const a = reduceEvents(e, 'do it');
    const b = reduceEvents(e, 'do it');
    expect(a).toEqual(b);
  });

  it('order-independent: shuffled events reduce to the same state (normalized by seq)', () => {
    const e = sampleEvents();
    const shuffled = [e[4]!, e[0]!, e[6]!, e[2]!, e[7]!, e[1]!, e[5]!, e[3]!];
    expect(reduceEvents(shuffled, 'do it')).toEqual(reduceEvents(e, 'do it'));
  });

  it('derives seq and callId/approvalId cursors past the highest persisted ids', () => {
    const c = deriveCursors(sampleEvents());
    expect(c.seq).toBe(8); // lastSeq 7 + 1
    expect(c.callCounter).toBe(1); // -c0 -> next 1
    expect(c.approvalCounter).toBe(1); // -a0 -> next 1
  });

  it('recovers usage from the latest cost_estimate, planned flag, and tool tallies', () => {
    const s = reduceEvents(sampleEvents(), 'do it');
    expect(s.v).toBe(RESUMABLE_STATE_VERSION);
    expect(s.usage.inputTokens).toBe(30);
    expect(s.usage.outputTokens).toBe(5);
    expect(s.usage.costUsd).toBeCloseTo(0.03);
    expect(s.planned).toBe(true);
    expect(s.toolCallCount).toBe(1);
    expect(s.toolErrors).toBe(0);
  });

  it('fallback restarts at step 0 with messages = [prompt]', () => {
    const s = reduceEvents(sampleEvents(), 'my prompt');
    expect(s.step).toBe(0);
    expect(s.messages).toEqual([{ role: 'user', content: 'my prompt' }]);
    expect(s.runningSummary).toBe('');
  });

  it('counts failed tool results toward toolErrors and marks planned on running status alone', () => {
    const e: AgentEvent[] = [
      ev({ type: 'status', seq: 0, state: 'running' }),
      ev({ type: 'tool_call', seq: 1, callId: `${TASK}-c0`, tool: 'x', riskLevel: 'low', input: {} }),
      ev({ type: 'tool_result', seq: 2, callId: `${TASK}-c0`, ok: false, error: 'boom' }),
    ];
    const s = reduceEvents(e, 'p');
    expect(s.planned).toBe(true);
    expect(s.toolErrors).toBe(1);
    expect(s.toolCallCount).toBe(0);
  });

  it('in-flight tool_call with NO tool_result advances callCounter so resume uses a NEW callId', () => {
    // Models the "uncertain / in-flight" case from the resume contract: a persisted tool_call whose
    // result never landed. The counter must move PAST it so the re-run cannot reuse the same callId.
    const e: AgentEvent[] = [
      ev({ type: 'status', seq: 0, state: 'running' }),
      ev({ type: 'tool_call', seq: 1, callId: `${TASK}-c0`, tool: 'fs_write', riskLevel: 'medium', input: {} }),
      // no tool_result for c0 — the process crashed mid-execution.
    ];
    const s = reduceEvents(e, 'p');
    expect(s.callCounter).toBe(1); // next callId is c1, never c0
    expect(s.toolCallCount).toBe(0); // not counted as a success
    expect(s.toolErrors).toBe(0); // and not counted as an error either (truly uncertain)
  });

  it('empty log => fresh state (seq 0, not planned)', () => {
    const s = reduceEvents([], 'p');
    expect(s.seq).toBe(0);
    expect(s.callCounter).toBe(0);
    expect(s.approvalCounter).toBe(0);
    expect(s.planned).toBe(false);
  });
});
