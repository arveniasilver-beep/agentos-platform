import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@agentos/protocol';
import { reduceEvents, applyEvent, emptyTaskView, resolveApproval } from './task-view';

const ev = (e: Partial<AgentEvent> & { type: AgentEvent['type']; seq: number }): AgentEvent =>
  ({ taskId: 't1', ...e }) as AgentEvent;

describe('task-view reducer', () => {
  it('folds a full happy-path stream into a coherent view', () => {
    const events: AgentEvent[] = [
      ev({ type: 'status', seq: 0, state: 'planning' } as never),
      ev({ type: 'plan', seq: 1, summary: 'do it', steps: [{ id: 's1', title: 'Step 1', description: '' }] } as never),
      ev({ type: 'status', seq: 2, state: 'running' } as never),
      ev({ type: 'tool_call', seq: 3, callId: 'c1', tool: 'fs_read', riskLevel: 'low', input: { path: 'a' } } as never),
      ev({ type: 'tool_result', seq: 4, callId: 'c1', ok: true, output: { content: 'hi' } } as never),
      ev({ type: 'message', seq: 5, role: 'assistant', text: 'working' } as never),
      ev({ type: 'final_output', seq: 6, summary: 'all done', artifactIds: [] } as never),
      ev({ type: 'status', seq: 7, state: 'completed' } as never),
    ];
    const view = reduceEvents(events);

    expect(view.status).toBe('completed');
    expect(view.planSteps).toHaveLength(1);
    expect(view.planSteps[0]?.title).toBe('Step 1');
    expect(view.toolCalls).toHaveLength(1);
    expect(view.toolCalls[0]?.status).toBe('ok');
    expect(view.messages).toHaveLength(1);
    expect(view.finalOutput).toBe('all done');
  });

  it('tracks a failing tool call', () => {
    const view = reduceEvents([
      ev({ type: 'tool_call', seq: 0, callId: 'c1', tool: 'http_fetch', riskLevel: 'low', input: {} } as never),
      ev({ type: 'tool_result', seq: 1, callId: 'c1', ok: false, error: 'boom' } as never),
    ]);
    expect(view.toolCalls[0]?.status).toBe('error');
    expect(view.toolCalls[0]?.error).toBe('boom');
  });

  it('records approvals and can resolve them optimistically', () => {
    let view = applyEvent(emptyTaskView(), ev({
      type: 'approval_request',
      seq: 0,
      approvalId: 'a1',
      action: 'fs_write',
      riskLevel: 'high',
      reason: 'risky',
    } as never));
    expect(view.approvals[0]?.resolved).toBe(false);
    view = resolveApproval(view, 'a1');
    expect(view.approvals[0]?.resolved).toBe(true);
  });

  it('is idempotent against re-delivered events (reconnect replay)', () => {
    const events: AgentEvent[] = [
      ev({ type: 'plan', seq: 0, summary: 'p', steps: [{ id: 's1', title: 'S1', description: '' }] } as never),
      ev({ type: 'message', seq: 1, role: 'assistant', text: 'hi' } as never),
      ev({ type: 'approval_request', seq: 2, approvalId: 'a1', action: 'fs_write', riskLevel: 'high', reason: '' } as never),
    ];
    let view = reduceEvents(events);
    view = resolveApproval(view, 'a1'); // user answered it
    // Server replays the whole backlog from seq 0 on reconnect:
    for (const e of events) view = applyEvent(view, e);
    expect(view.messages).toHaveLength(1); // not duplicated
    expect(view.approvals).toHaveLength(1); // not re-added
    expect(view.approvals[0]?.resolved).toBe(true); // stays resolved, not reopened
  });

  it('captures stop reason and errors', () => {
    const view = reduceEvents([
      ev({ type: 'error', seq: 0, message: 'too many tool errors', recoverable: false } as never),
      ev({ type: 'stopped', seq: 1, reason: 'user_requested' } as never),
    ]);
    expect(view.errors).toContain('too many tool errors');
    expect(view.stoppedReason).toBe('user_requested');
  });
});
