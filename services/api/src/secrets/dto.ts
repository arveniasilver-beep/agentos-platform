import { z } from 'zod';

export const setLlmKeySchema = z.object({
  apiKey: z.string().min(8).max(400),
  provider: z.enum(['anthropic']).default('anthropic'),
});
export type SetLlmKeyDto = z.infer<typeof setLlmKeySchema>;
