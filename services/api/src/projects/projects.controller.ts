import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProjectsService } from './projects.service';
import { createProjectSchema, type CreateProjectDto } from '../workspaces/dto';

@Controller('workspaces/:workspaceId/projects')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.projects.list(workspaceId);
  }

  @Post()
  @MinRole('member')
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(createProjectSchema)) dto: CreateProjectDto,
  ) {
    return this.projects.create(workspaceId, dto);
  }
}
