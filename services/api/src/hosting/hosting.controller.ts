import { Body, Controller, Delete, Get, Post, Param, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { HostingService } from './hosting.service';

const setSchema = z.object({
  token: z.string().min(10).max(500),
  backend: z.enum(['netlify', 'selfhosted']).optional(),
  endpoint: z.string().url().max(300).optional(),
});
type SetDto = z.infer<typeof setSchema>;

/** Hosting (static-site deploy) settings. Setting the deploy token grants the ability to publish to
 * the public internet, so writes are admin-only; reading the status is member+. */
@Controller('workspaces/:workspaceId/hosting')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class HostingController {
  constructor(private readonly hosting: HostingService) {}

  @Get()
  @MinRole('member')
  status(@Param('workspaceId') workspaceId: string) {
    return this.hosting.status(workspaceId);
  }

  @Post()
  @MinRole('admin')
  async set(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(setSchema)) dto: SetDto,
  ) {
    await this.hosting.setConfig(workspaceId, user.id, {
      token: dto.token,
      ...(dto.backend ? { backend: dto.backend } : {}),
      ...(dto.endpoint ? { endpoint: dto.endpoint } : {}),
    });
    return this.hosting.status(workspaceId);
  }

  @Delete()
  @MinRole('admin')
  async clear(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    await this.hosting.clear(workspaceId, user.id);
    return { ok: true };
  }
}
