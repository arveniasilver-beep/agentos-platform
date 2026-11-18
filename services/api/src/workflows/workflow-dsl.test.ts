import { describe, it, expect } from 'vitest';
import { workflowDefinitionSchema, validateWorkflow, parseWorkflowDefinition, type WorkflowDefinition } from './workflow-dsl';
import { evalCondition, routeAfter, contextFrom, stepById, type StepState } from './workflow-engine';

const good: WorkflowDefinition = {
  start: 'a',
  trigger: { type: 'manual' },
  steps: [
    { id: 'a', type: 'task', prompt: 'do A', onSuccess: 'c', onFailure: 'fail' },
    { id: 'c', type: 'condition', expr: { left: 'lastStatus', op: 'eq', value: 'completed' }, onTrue: 'end', onFalse: 'fail' },
  ],
};

describe('workflow DSL + engine (TICKET-8)', () => {
  it('accepts a well-formed definition', () => {
    expect(workflowDefinitionSchema.parse(good)).toBeTruthy();
    expect(validateWorkflow(good).ok).toBe(true);
    expect(parseWorkflowDefinition(good)).toBeTruthy();
  });

  it('rejects duplicate ids, unknown targets, missing start', () => {
    expect(validateWorkflow({ ...good, start: 'nope' }).ok).toBe(false);
    const dup = { ...good, steps: [good.steps[0]!, good.steps[0]!] };
    expect(validateWorkflow(dup as WorkflowDefinition).errors.some((e) => /duplicate/.test(e))).toBe(true);
    const badTarget = { ...good, steps: [{ id: 'a', type: 'task', prompt: 'x', onSuccess: 'ghost' }] } as WorkflowDefinition;
    expect(validateWorkflow(badTarget).errors.some((e) => /unknown target/.test(e))).toBe(true);
    expect(() => parseWorkflowDefinition({ start: 'a', trigger: { type: 'manual' }, steps: [] })).toThrow();
  });

  it('evalCondition compares whitelisted context keys (no eval)', () => {
    const ctx = { lastStatus: 'completed', stepCount: 2, failedCount: 1 };
    expect(evalCondition({ left: 'lastStatus', op: 'eq', value: 'completed' }, ctx)).toBe(true);
    expect(evalCondition({ left: 'lastStatus', op: 'neq', value: 'completed' }, ctx)).toBe(false);
    expect(evalCondition({ left: 'failedCount', op: 'gte', value: 1 }, ctx)).toBe(true);
    expect(evalCondition({ left: 'stepCount', op: 'lt', value: 2 }, ctx)).toBe(false);
  });

  it('routeAfter resolves task/approval branches with end/fail defaults', () => {
    const taskStep = good.steps[0]!;
    expect(routeAfter(taskStep, 'task_done')).toBe('c');
    expect(routeAfter(taskStep, 'task_failed')).toBe('fail');
    const approval = { id: 'ap', type: 'approval' as const, onSuccess: 'x' };
    expect(routeAfter(approval, 'approved')).toBe('x');
    expect(routeAfter(approval, 'denied')).toBe('fail'); // default
  });

  it('contextFrom derives lastStatus / counts from step states', () => {
    const states: StepState[] = [
      { stepId: 'a', type: 'task', status: 'failed' },
      { stepId: 'b', type: 'task', status: 'completed' },
    ];
    const ctx = contextFrom(states);
    expect(ctx.lastStatus).toBe('completed');
    expect(ctx.stepCount).toBe(2);
    expect(ctx.failedCount).toBe(1);
  });

  it('stepById finds steps', () => {
    expect(stepById(good, 'a')?.type).toBe('task');
    expect(stepById(good, 'zzz')).toBeUndefined();
  });
});
