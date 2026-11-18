import type { WorkflowDefinition, WorkflowStep, ConditionExpr } from './workflow-dsl';

// Workflow Builder engine (TICKET-8) — PURE routing + condition evaluation. The service drives a run by
// composing these with DB persistence + task launches. No side effects here (fully unit-testable).

export type StepOutcome = 'task_done' | 'task_failed' | 'approved' | 'denied';

export interface RunContext {
  lastStatus: string; // status of the most recent task step ('completed' | 'failed' | '')
  stepCount: number; // task/approval steps executed so far
  failedCount: number; // failed task steps so far
}

export function stepById(def: WorkflowDefinition, id: string): WorkflowStep | undefined {
  return def.steps.find((s) => s.id === id);
}

/** Evaluate a condition against the run context — deterministic, whitelist-only, never eval. */
export function evalCondition(expr: ConditionExpr, ctx: RunContext): boolean {
  const left: string | number = ctx[expr.left];
  const right = expr.value;
  switch (expr.op) {
    case 'eq':
      return String(left) === String(right);
    case 'neq':
      return String(left) !== String(right);
    case 'gt':
      return Number(left) > Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

/** Routing target after a task/approval step resolves with an outcome ('end' | 'fail' | a step id). */
export function routeAfter(step: WorkflowStep, outcome: StepOutcome): string {
  if (step.type === 'task') return outcome === 'task_done' ? step.onSuccess ?? 'end' : step.onFailure ?? 'fail';
  if (step.type === 'approval') return outcome === 'approved' ? step.onSuccess ?? 'end' : step.onFailure ?? 'fail';
  return 'end';
}

export interface StepState {
  stepId: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'awaiting_approval' | 'condition';
  taskId?: string;
  attempt?: number;
  branch?: boolean; // condition result
  error?: string;
}

/** Build the run context from accumulated step states (for condition evaluation). */
export function contextFrom(states: StepState[]): RunContext {
  const taskish = states.filter((s) => s.type === 'task' || s.type === 'approval');
  const lastTask = [...states].reverse().find((s) => s.type === 'task' && (s.status === 'completed' || s.status === 'failed'));
  return {
    lastStatus: lastTask?.status ?? '',
    stepCount: taskish.length,
    failedCount: states.filter((s) => s.type === 'task' && s.status === 'failed').length,
  };
}
