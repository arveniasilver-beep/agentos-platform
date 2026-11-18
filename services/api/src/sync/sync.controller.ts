import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { SyncService } from './sync.service';

/** Device Sync (TICKET-5): one consolidated snapshot for a device (web/desktop/Android) to stay
 * consistent. Reachable by a cookie session OR — when DEVICE_SYNC_ENABLED — a Bearer device token,
 * since AuthGuard accepts both. Read-only, viewer+. */
@Controller('workspaces/:workspaceId/sync')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('snapshot')
  @MinRole('viewer')
  snapshot(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    return this.sync.snapshot(workspaceId, user.id);
  }
}
