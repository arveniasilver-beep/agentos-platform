import type { PlanStep } from '@agentos/protocol';

/** Parse a numbered/bulleted plan from the planner's text into structured steps. */
export function parsePlanSteps(text: string, taskId: string): PlanStep[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, '').trim())
    .filter((l) => l.length > 0);

  const steps = lines.slice(0, 12);
  if (steps.length === 0) {
    return [{ id: `${taskId}-s0`, title: 'Complete the task', description: '', status: 'pending' }];
  }
  return steps.map((title, i) => ({ id: `${taskId}-s${i}`, title, description: '', status: 'pending' }));
}
