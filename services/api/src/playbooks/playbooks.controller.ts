import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { isTaskCapability } from '@agentos/protocol';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PlaybooksService } from './playbooks.service';

const createPlaybookSchema = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8_000),
  capability: z.string().refine(isTaskCapability, 'unknown capability').optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
});
type CreatePlaybookDto = z.infer<typeof createPlaybookSchema>;

@Controller('workspaces/:workspaceId/playbooks')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class PlaybooksController {
  constructor(private readonly playbooks: PlaybooksService) {}

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.playbooks.list(workspaceId);
  }

  @Post()
  @MinRole('member')
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(createPlaybookSchema)) dto: CreatePlaybookDto,
  ) {
    return this.playbooks.create(workspaceId, user.id, dto);
  }

  @Delete(':id')
  @MinRole('member')
  remove(@Param('workspaceId') workspaceId: string, @Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.playbooks.remove(workspaceId, id, user.id);
  }
}
