import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TasksModule } from '../tasks/tasks.module';
import { AutomationRunsModule } from './automation-runs.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { AutomationWorker } from './automation.worker';

@Module({
  imports: [AuthModule, TasksModule, AutomationRunsModule],
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationWorker, WorkspaceRoleGuard],
})
export class AutomationsModule {}
