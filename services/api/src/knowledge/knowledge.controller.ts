import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KnowledgeService } from './knowledge.service';
import { SecretsService } from '../secrets/secrets.service';

const ingestSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(200_000),
});
type IngestDto = z.infer<typeof ingestSchema>;

const embeddingsConfigSchema = z.object({
  provider: z.enum(['openai', 'voyage', 'gemini', 'local']),
  apiKey: z.string().max(400).optional(),
  model: z.string().max(100).optional(),
  baseUrl: z.string().url().max(300).optional(),
});
type EmbeddingsConfigDto = z.infer<typeof embeddingsConfigSchema>;

@Controller('workspaces/:workspaceId/knowledge')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly secrets: SecretsService,
  ) {}

  @Post('documents')
  @MinRole('member')
  ingest(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(ingestSchema)) dto: IngestDto,
  ) {
    return this.knowledge.ingest(workspaceId, 'knowledge', dto.title, dto.content);
  }

  @Get('documents')
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.knowledge.list(workspaceId);
  }

  @Delete('documents')
  @MinRole('member')
  remove(@Param('workspaceId') workspaceId: string, @Query('title') title: string) {
    return this.knowledge.deleteByTitle(workspaceId, title ?? '');
  }

  @Get('search')
  @MinRole('viewer')
  search(
    @Param('workspaceId') workspaceId: string,
    @Query('q') q: string,
    @Query('k') k?: string,
  ) {
    const topK = k !== undefined ? Number.parseInt(k, 10) : 5;
    return this.knowledge.search(workspaceId, q ?? '', Number.isFinite(topK) ? topK : 5);
  }

  @Get('embeddings')
  @MinRole('viewer')
  embeddingsInfo(@Param('workspaceId') workspaceId: string) {
    return this.secrets.getEmbeddingsInfo(workspaceId);
  }

  @Post('embeddings')
  @MinRole('admin')
  setEmbeddings(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(embeddingsConfigSchema)) dto: EmbeddingsConfigDto,
  ) {
    return this.secrets.setEmbeddingsConfig(workspaceId, user.id, dto);
  }

  @Delete('embeddings')
  @MinRole('admin')
  deleteEmbeddings(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    return this.secrets.deleteEmbeddingsConfig(workspaceId, user.id);
  }
}
