import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { DesktopRunnerController } from './desktop-runner.controller';
import { DesktopRunnerService } from './desktop-runner.service';

/**
 * Desktop Runner Foundation (TICKET-7). Exports DesktopRunnerService so the task-runner local-fs sink can
 * record content-free, full-path-free local-action audit. Prisma/Audit are global.
 */
@Module({
  imports: [AuthModule],
  controllers: [DesktopRunnerController],
  providers: [DesktopRunnerService, WorkspaceRoleGuard],
  exports: [DesktopRunnerService],
})
export class DesktopRunnerModule {}
