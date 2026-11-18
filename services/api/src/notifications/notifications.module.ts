import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, WorkspaceRoleGuard],
  exports: [NotificationsService],
})
export class NotificationsModule {}
