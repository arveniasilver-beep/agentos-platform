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
import { WorkspacesService } from './workspaces.service';
import {
  createWorkspaceSchema,
  addMemberSchema,
  updateMemberRoleSchema,
  type CreateWorkspaceDto,
  type AddMemberDto,
  type UpdateMemberRoleDto,
} from './dto';

@Controller('workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(createWorkspaceSchema)) dto: CreateWorkspaceDto,
  ) {
    return this.workspaces.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.workspaces.listForUser(user.id);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceRoleGuard)
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string) {
    return this.workspaces.get(workspaceId);
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceRoleGuard)
  @MinRole('member')
  members(@Param('workspaceId') workspaceId: string) {
    return this.workspaces.listMembers(workspaceId);
  }

  @Post(':workspaceId/members')
  @UseGuards(WorkspaceRoleGuard)
  @MinRole('admin')
  addMember(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(addMemberSchema)) dto: AddMemberDto,
  ) {
    return this.workspaces.addMember(workspaceId, user.id, dto);
  }

  @Patch(':workspaceId/members/:memberUserId')
  @UseGuards(WorkspaceRoleGuard)
  @MinRole('admin')
  updateMemberRole(
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(updateMemberRoleSchema)) dto: UpdateMemberRoleDto,
  ) {
    return this.workspaces.updateMemberRole(workspaceId, user.id, memberUserId, dto.role);
  }

  @Delete(':workspaceId/members/:memberUserId')
  @UseGuards(WorkspaceRoleGuard)
  @MinRole('admin')
  removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberUserId') memberUserId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.workspaces.removeMember(workspaceId, user.id, memberUserId);
  }
}
