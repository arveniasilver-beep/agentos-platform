import { z } from 'zod';
import { MEMORY_KINDS, MEMORY_SOURCES } from './memory.service';

const kind = z.enum(MEMORY_KINDS);
const source = z.enum(MEMORY_SOURCES);
const tags = z.array(z.string().min(1).max(40)).max(20).optional();

export const createMemorySchema = z.object({
  kind,
  content: z.string().min(1).max(8000),
  source: source.default('userProvided'),
  projectId: z.string().uuid().optional(),
  tags,
  confidence: z.number().min(0).max(1).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  sourceTaskId: z.string().optional(),
  sourceArtifactId: z.string().optional(),
  sourceCommitHash: z.string().max(80).optional(),
});
export type CreateMemoryDto = z.infer<typeof createMemorySchema>;

export const updateMemorySchema = z.object({
  kind: kind.optional(),
  content: z.string().min(1).max(8000).optional(),
  tags,
  confidence: z.number().min(0).max(1).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type UpdateMemoryDto = z.infer<typeof updateMemorySchema>;
