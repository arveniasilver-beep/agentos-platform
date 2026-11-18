import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TasksModule } from '../tasks/tasks.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

@Module({
  imports: [AuthModule, TasksModule],
  controllers: [SkillsController],
  providers: [SkillsService, WorkspaceRoleGuard],
})
export class SkillsModule {}
