import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ApiKeysService } from './api-keys.service';
import { createApiKeySchema, type CreateApiKeyDto } from './dto';

/** Manage public-API keys for a workspace (admin only). The plaintext token is returned once. */
@Controller('workspaces/:workspaceId/api-keys')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @MinRole('admin')
  list(@Param('workspaceId') workspaceId: string) {
    return this.apiKeys.list(workspaceId);
  }

  @Post()
  @MinRole('admin')
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(createApiKeySchema)) dto: CreateApiKeyDto,
  ) {
    return this.apiKeys.create(workspaceId, user.id, dto);
  }

  @Delete(':keyId')
  @MinRole('admin')
  revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('keyId') keyId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.apiKeys.revoke(workspaceId, keyId, user.id);
  }
}
