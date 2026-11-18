import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LocalFoldersService } from './local-folders.service';

const addSchema = z.object({
  label: z.string().min(1).max(120),
  path: z.string().min(1).max(500),
  writable: z.boolean().optional(),
});
type AddDto = z.infer<typeof addSchema>;

/** "My Computer" management. Approving a host folder grants the agent access to real files, so writes
 * here are admin-only; reads of the list are member+. */
@Controller('workspaces/:workspaceId/local-folders')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class LocalFoldersController {
  constructor(private readonly folders: LocalFoldersService) {}

  @Get()
  @MinRole('member')
  async list(@Param('workspaceId') workspaceId: string) {
    return { enabled: this.folders.enabled(), folders: await this.folders.list(workspaceId) };
  }

  @Post()
  @MinRole('admin')
  add(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(addSchema)) dto: AddDto,
  ) {
    return this.folders.add(workspaceId, user.id, dto);
  }

  @Delete(':id')
  @MinRole('admin')
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.folders.remove(workspaceId, user.id, id);
  }
}
