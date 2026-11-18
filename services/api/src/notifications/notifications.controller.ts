import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { NotificationsService } from './notifications.service';

const readSchema = z.object({ id: z.string().uuid().optional() });
type ReadDto = z.infer<typeof readSchema>;

@Controller('workspaces/:workspaceId/notifications')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    return this.notifications.list(workspaceId, user.id);
  }

  @Post('read')
  @MinRole('viewer')
  markRead(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(readSchema)) dto: ReadDto,
  ) {
    return this.notifications.markRead(workspaceId, user.id, dto.id);
  }
}
