import { z } from 'zod';

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, and hyphens'),
});
export type CreateWorkspaceDto = z.infer<typeof createWorkspaceSchema>;

export const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']), // owner is the creator; not assignable here
});
export type AddMemberDto = z.infer<typeof addMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']), // owner role is immutable via this path
});
export type UpdateMemberRoleDto = z.infer<typeof updateMemberRoleSchema>;

export const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateProjectDto = z.infer<typeof createProjectSchema>;
