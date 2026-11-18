import { z } from 'zod';
import { riskLevelSchema } from '@agentos/protocol';

// Skills v2 (TICKET-4): typed param definitions + capability/effort. Additive + optional, so legacy
// create/update payloads are unchanged.
const skillParamSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean']).default('string'),
  required: z.boolean().optional(),
  description: z.string().max(500).optional(),
});
const capabilitySchema = z.enum(['slides', 'document', 'website', 'chart', 'image', 'spreadsheet', 'chat']);
const effortSchema = z.enum(['low', 'medium', 'high', 'max']);

export const createSkillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  instructions: z.string().min(1).max(20_000),
  riskCeiling: riskLevelSchema.default('high'),
  stepBudget: z.number().int().min(1).max(50).optional(),
  costBudgetUsd: z.number().positive().max(1000).optional(),
  params: z.array(skillParamSchema).max(50).optional(),
  capability: capabilitySchema.optional(),
  effort: effortSchema.optional(),
});
export type CreateSkillDto = z.infer<typeof createSkillSchema>;

export const updateSkillSchema = createSkillSchema.partial();
export type UpdateSkillDto = z.infer<typeof updateSkillSchema>;

export const runSkillSchema = z.object({
  input: z.string().max(20_000).optional(),
  params: z.record(z.unknown()).optional(),
});
export type RunSkillDto = z.infer<typeof runSkillSchema>;
