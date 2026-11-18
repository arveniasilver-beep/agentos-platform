import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PersonalizationService } from './personalization.service';

const updateSchema = z.object({
  nickname: z.string().max(100).nullish(),
  profession: z.string().max(100).nullish(),
  about: z.string().max(2_000).nullish(),
  instructions: z.string().max(4_000).nullish(),
  memories: z.array(z.string().min(1).max(500)).max(100).optional(),
});
type UpdateDto = z.infer<typeof updateSchema>;

@Controller('workspaces/:workspaceId/personalization')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class PersonalizationController {
  constructor(private readonly personalization: PersonalizationService) {}

  @Get()
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string) {
    return this.personalization.get(workspaceId);
  }

  // Admin-gated: this single row is prepended to the system prompt of EVERY task in the workspace,
  // so editing it steers the agent for all members/automations — same blast radius (and same gate)
  // as secrets/API-key/embeddings config. Read stays viewer-level.
  @Put()
  @MinRole('admin')
  update(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(updateSchema)) dto: UpdateDto,
  ) {
    return this.personalization.update(workspaceId, dto);
  }
}
