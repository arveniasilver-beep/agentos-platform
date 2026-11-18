import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SkillsService } from './skills.service';
import {
  createSkillSchema,
  updateSkillSchema,
  runSkillSchema,
  type CreateSkillDto,
  type UpdateSkillDto,
  type RunSkillDto,
} from './dto';

@Controller('workspaces/:workspaceId/skills')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.skills.list(workspaceId);
  }

  @Get(':skillId')
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('skillId') skillId: string) {
    return this.skills.get(workspaceId, skillId);
  }

  @Post()
  @MinRole('member')
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(createSkillSchema)) dto: CreateSkillDto,
  ) {
    return this.skills.create(workspaceId, user.id, dto);
  }

  @Patch(':skillId')
  @MinRole('member')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(updateSkillSchema)) dto: UpdateSkillDto,
  ) {
    return this.skills.update(workspaceId, skillId, user.id, dto);
  }

  @Post(':skillId/run')
  @MinRole('member')
  run(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(runSkillSchema)) dto: RunSkillDto,
  ) {
    return this.skills.run(workspaceId, skillId, user.id, dto.input, dto.params);
  }

  @Delete(':skillId')
  @MinRole('member')
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('skillId') skillId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.skills.remove(workspaceId, skillId, user.id);
  }
}
