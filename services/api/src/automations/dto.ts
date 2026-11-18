import { z } from 'zod';
import { riskLevelSchema } from '@agentos/protocol';

// A 5-field cron validator (minute hour day-of-month month day-of-week). Each field is a number,
// *, range, list, or step. Syntax AND value-range are checked, so out-of-range inputs like
// '60 24 * * *' or a zero step '*/0 * * * *' are rejected here — before a row is persisted and
// before BullMQ's eager cron-parser would throw a 500 from schedule().
const CRON_FIELD = /^(\*|\?|(\d+|\*)(\/\d+)?(-\d+(\/\d+)?)?)(,(\d+|\*)(\/\d+)?(-\d+(\/\d+)?)?)*$/;
const CRON_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];
function cronFieldInRange(field: string, idx: number): boolean {
  const range = CRON_RANGES[idx];
  if (!range) return false;
  const [lo, hi] = range;
  if (field === '*' || field === '?') return true;
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined) {
      const step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) return false;
    }
    if (rangePart === '*' || rangePart === undefined) continue;
    const bounds = rangePart.split('-').map(Number);
    if (bounds.some((n) => !Number.isInteger(n) || n < lo || n > hi)) return false;
    if (bounds.length === 2 && bounds[0]! > bounds[1]!) return false;
  }
  return true;
}
const cronExpression = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).length === 5, 'cron must have 5 fields')
  .refine(
    (v) => v.split(/\s+/).every((f, i) => CRON_FIELD.test(f) && cronFieldInRange(f, i)),
    'invalid cron field (check syntax and value ranges)',
  );

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  cronExpression,
  timezone: z.string().min(1).max(64).default('UTC'),
  projectId: z.string().uuid().optional(),
  riskCeiling: riskLevelSchema.default('high'),
  stepBudget: z.number().int().min(1).max(50).optional(),
  costBudgetUsd: z.number().positive().max(1000).optional(),
  enabled: z.boolean().default(true),
});
export type CreateAutomationDto = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = createAutomationSchema.partial();
export type UpdateAutomationDto = z.infer<typeof updateAutomationSchema>;
