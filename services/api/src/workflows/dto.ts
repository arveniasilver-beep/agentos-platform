import { z } from 'zod';

export const createWorkflowSchema = z.object({
  name: z.string().min(1).max(120),
  // The definition is structurally validated by the service (parseWorkflowDefinition); accept an object here.
  definition: z.record(z.unknown()),
  projectId: z.string().uuid().optional(),
});
export type CreateWorkflowDto = z.infer<typeof createWorkflowSchema>;

export const updateWorkflowSchema = z.object({ enabled: z.boolean() });
export type UpdateWorkflowDto = z.infer<typeof updateWorkflowSchema>;

export const decideWorkflowApprovalSchema = z.object({ decision: z.enum(['approve', 'deny']) });
export type DecideWorkflowApprovalDto = z.infer<typeof decideWorkflowApprovalSchema>;
