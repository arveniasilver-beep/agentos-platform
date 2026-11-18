import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

@Module({
  imports: [AuthModule],
  controllers: [UsageController],
  providers: [UsageService, WorkspaceRoleGuard],
})
export class UsageModule {}
