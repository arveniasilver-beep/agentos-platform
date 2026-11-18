import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MemoryService } from './memory.service';
import { createMemorySchema, updateMemorySchema, type CreateMemoryDto, type UpdateMemoryDto } from './dto';

@Controller('workspaces/:workspaceId/memory')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  @MinRole('viewer')
  list(
    @Param('workspaceId') workspaceId: string,
    @Query('kind') kind?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.memory.list(workspaceId, {
      ...(kind ? { kind } : {}),
      ...(projectId ? { projectId } : {}),
      includeArchived: includeArchived === 'true',
    });
  }

  @Get(':id')
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.memory.get(workspaceId, id);
  }

  @Post()
  @MinRole('member')
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(createMemorySchema)) dto: CreateMemoryDto,
  ) {
    return this.memory.create(workspaceId, user.id, dto);
  }

  @Patch(':id')
  @MinRole('member')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(updateMemorySchema)) dto: UpdateMemoryDto,
  ) {
    return this.memory.update(workspaceId, id, user.id, dto);
  }

  @Post(':id/archive')
  @MinRole('member')
  archive(@Param('workspaceId') workspaceId: string, @Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.memory.archive(workspaceId, id, user.id);
  }

  @Delete(':id')
  @MinRole('member')
  remove(@Param('workspaceId') workspaceId: string, @Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.memory.remove(workspaceId, id, user.id);
  }
}
