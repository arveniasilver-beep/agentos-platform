import { z } from 'zod';

export const registerRunnerSchema = z.object({
  version: z.string().max(40).optional(),
  capabilities: z.record(z.unknown()).optional(),
});
export type RegisterRunnerDto = z.infer<typeof registerRunnerSchema>;

export const setRunnerStatusSchema = z.object({
  status: z.enum(['active', 'idle', 'disabled']),
});
export type SetRunnerStatusDto = z.infer<typeof setRunnerStatusSchema>;
