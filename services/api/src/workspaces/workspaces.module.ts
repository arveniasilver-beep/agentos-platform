import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { ProjectsController } from '../projects/projects.controller';
import { ProjectsService } from '../projects/projects.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';

@Module({
  imports: [AuthModule],
  controllers: [WorkspacesController, ProjectsController],
  providers: [WorkspacesService, ProjectsService, WorkspaceRoleGuard],
})
export class WorkspacesModule {}
