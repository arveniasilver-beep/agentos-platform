import { describe, it, expect } from 'vitest';
import {
  agentEventSchema,
  clientMessageSchema,
  planEventSchema,
  requiresApproval,
  maxRisk,
  PROTOCOL_VERSION,
  type AgentEventType,
} from './index';

const EXPECTED_EVENT_TYPES: AgentEventType[] = [
  'approval_request',
  'cost_estimate',
  'error',
  'final_output',
  'message',
  'plan',
  'status',
  'step_completed',
  'step_started',
  'stopped',
  'tool_call',
  'tool_result',
];

describe('risk model', () => {
  it('gates high and critical for approval, not low/medium', () => {
    expect(requiresApproval('low')).toBe(false);
    expect(requiresApproval('medium')).toBe(false);
    expect(requiresApproval('high')).toBe(true);
    expect(requiresApproval('critical')).toBe(true);
  });

  it('maxRisk returns the higher level', () => {
    expect(maxRisk('low', 'critical')).toBe('critical');
    expect(maxRisk('high', 'medium')).toBe('high');
  });
});

describe('event ABI', () => {
  it('parses a valid plan event', () => {
    const event = planEventSchema.parse({
      type: 'plan',
      taskId: 't1',
      seq: 0,
      summary: 'Do the thing',
      steps: [{ id: 's1', title: 'Step one' }],
    });
    expect(event.steps[0]?.description).toBe(''); // default applied
  });

  it('rejects a plan event with no steps', () => {
    expect(() =>
      planEventSchema.parse({ type: 'plan', taskId: 't1', seq: 0, summary: 'x', steps: [] }),
    ).toThrow();
  });

  it('routes the discriminated union by type', () => {
    const toolCall = agentEventSchema.parse({
      type: 'tool_call',
      taskId: 't1',
      seq: 3,
      callId: 'c1',
      tool: 'web_search',
      riskLevel: 'low',
      input: { query: 'hello' },
    });
    expect(toolCall.type).toBe('tool_call');
  });

  it('rejects an unknown event type', () => {
    expect(() => agentEventSchema.parse({ type: 'nope', taskId: 't1', seq: 0 })).toThrow();
  });

  it('covers exactly the expected event types (drift guard)', () => {
    const actual = agentEventSchema.options.map((o) => o.shape.type.value).sort();
    expect(actual).toEqual([...EXPECTED_EVENT_TYPES].sort());
  });
});

describe('client control messages', () => {
  it('parses submit/approve/stop', () => {
    expect(clientMessageSchema.parse({ type: 'submit_task', prompt: 'hi' }).type).toBe('submit_task');
    expect(
      clientMessageSchema.parse({ type: 'approve', taskId: 't1', approvalId: 'a1' }).type,
    ).toBe('approve');
    expect(clientMessageSchema.parse({ type: 'stop', taskId: 't1' }).type).toBe('stop');
  });

  it('rejects submit_task with an empty prompt', () => {
    expect(() => clientMessageSchema.parse({ type: 'submit_task', prompt: '' })).toThrow();
  });
});

describe('protocol version', () => {
  it('exposes a semver string', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
