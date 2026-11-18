import { z } from 'zod';
import { riskLevelSchema, TASK_CAPABILITIES } from '@agentos/protocol';

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  projectId: z.string().uuid().optional(),
  /** Deliverable mode that primes the agent (slides/document/website/...). Default general. */
  capability: z.enum(TASK_CAPABILITIES).optional(),
  /** Reasoning effort tier (cost/quality tradeoff). Default high. */
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  /** Tools above this level pause for explicit approval (default high). */
  riskCeiling: riskLevelSchema.default('high'),
  stepBudget: z.number().int().min(1).max(50).optional(),
  costBudgetUsd: z.number().positive().max(1000).optional(),
});
export type CreateTaskDto = z.infer<typeof createTaskSchema>;

export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  // Owner break-glass typed confirmation for elevated approvals in single-user mode (TICKET-POLICY).
  confirmation: z.string().max(64).optional(),
});
export type DecideApprovalDto = z.infer<typeof decideApprovalSchema>;

export const updateTaskMetaSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    favorite: z.boolean().optional(),
    archived: z.boolean().optional(),
    rating: z.number().int().min(1).max(5).optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.favorite !== undefined ||
      d.archived !== undefined ||
      d.rating !== undefined,
    { message: 'Provide at least one field to update (title, favorite, archived, or rating).' },
  );
export type UpdateTaskMetaDto = z.infer<typeof updateTaskMetaSchema>;

// Multi-turn follow-up (KEYSTONE): a new user message continuing a finished task.
export const followupMessageSchema = z.object({ text: z.string().min(1).max(20000) });
export type FollowupMessageDto = z.infer<typeof followupMessageSchema>;
