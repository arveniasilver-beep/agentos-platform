import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

/** Device Sync (TICKET-5): the consolidated cross-device snapshot endpoint. */
@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [SyncService, WorkspaceRoleGuard],
})
export class SyncModule {}
