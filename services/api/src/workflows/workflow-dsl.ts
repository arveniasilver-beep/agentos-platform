import { z } from 'zod';

// Workflow Builder DSL (TICKET-8). A SAFE, structured JSON definition — no code/eval anywhere. A workflow
// is a set of steps with branching: each step routes to another step id, 'end', or 'fail'.

const stepId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const target = z.union([stepId, z.literal('end'), z.literal('fail')]);

// A condition compares a whitelisted run-context key against a literal — deterministic, no expressions.
const conditionExpr = z.object({
  left: z.enum(['lastStatus', 'stepCount', 'failedCount']),
  op: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte']),
  value: z.union([z.string().max(40), z.number()]),
});
export type ConditionExpr = z.infer<typeof conditionExpr>;

const base = z.object({ id: stepId, name: z.string().max(80).optional() });

const taskStep = base.extend({
  type: z.literal('task'),
  prompt: z.string().min(1).max(8000),
  capability: z.enum(['slides', 'document', 'website', 'chart', 'image', 'spreadsheet', 'chat']).optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  onSuccess: target.optional(),
  onFailure: target.optional(),
});
const conditionStep = base.extend({
  type: z.literal('condition'),
  expr: conditionExpr,
  onTrue: target,
  onFalse: target,
});
const approvalStep = base.extend({
  type: z.literal('approval'),
  prompt: z.string().max(500).optional(),
  onSuccess: target.optional(), // after approval
  onFailure: target.optional(), // after denial
});
export const workflowStepSchema = z.discriminatedUnion('type', [taskStep, conditionStep, approvalStep]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

// Triggers: manual + webhook are fully wired in TICKET-8. A SCHEDULE (cron) trigger is intentionally NOT
// accepted yet — it would need a BullMQ scheduler + worker (mirroring AutomationsService); shipping a
// stored-but-never-fired cron would be a visible-but-broken feature. Scheduled workflows are a documented
// follow-on. (The workflows.cronExpression/timezone columns exist additively for that future wiring.)
export const workflowTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('webhook') }),
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export const workflowDefinitionSchema = z.object({
  start: stepId,
  trigger: workflowTriggerSchema,
  steps: z.array(workflowStepSchema).min(1).max(50),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Structural validation beyond the Zod shape: unique ids, start exists, all routing targets resolve. */
export function validateWorkflow(def: WorkflowDefinition): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const s of def.steps) {
    if (ids.has(s.id)) errors.push(`duplicate step id: ${s.id}`);
    ids.add(s.id);
  }
  if (!ids.has(def.start)) errors.push(`start step not found: ${def.start}`);
  const ok = (t?: string) => !t || t === 'end' || t === 'fail' || ids.has(t);
  for (const s of def.steps) {
    const targets = s.type === 'condition' ? [s.onTrue, s.onFalse] : [s.onSuccess, s.onFailure];
    for (const t of targets) if (t && !ok(t)) errors.push(`step "${s.id}": unknown target "${t}"`);
  }
  return { ok: errors.length === 0, errors };
}

/** Parse + structurally validate a raw definition. Throws a flat error list on failure. */
export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  const def = workflowDefinitionSchema.parse(raw);
  const v = validateWorkflow(def);
  if (!v.ok) throw new Error(`invalid workflow: ${v.errors.join('; ')}`);
  return def;
}
