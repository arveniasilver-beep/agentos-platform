import { z } from 'zod';

export const createApiKeySchema = z.object({
  label: z.string().min(1).max(120).optional(),
  /** Optional expiry in days from now. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;
