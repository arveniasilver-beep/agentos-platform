import { Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { loadServerEnv } from '@agentos/config';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ConnectorRegistryService } from './connector-registry.service';

/** Connectors v2 management (TICKET-9): manifests, health, events, webhook-secret issuance. */
@Controller('workspaces/:workspaceId/connectors-v2')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class ConnectorRegistryController {
  constructor(private readonly registry: ConnectorRegistryService) {}

  @Get('manifests')
  @MinRole('viewer')
  manifests() {
    return this.registry.listManifests();
  }

  @Get('health')
  @MinRole('viewer')
  health(@Param('workspaceId') workspaceId: string) {
    return this.registry.health(workspaceId);
  }

  @Get('events')
  @MinRole('viewer')
  events(@Param('workspaceId') workspaceId: string, @Query('connectionId') connectionId?: string) {
    return this.registry.listEvents(workspaceId, connectionId);
  }

  @Post(':provider/webhook-secret')
  @MinRole('admin')
  setWebhookSecret(@Param('workspaceId') workspaceId: string, @Param('provider') provider: string, @CurrentUser() user: SessionUser) {
    if (!loadServerEnv().CONNECTORS_V2_ENABLED) throw new NotFoundException('Connectors v2 is not enabled.');
    return this.registry.setWebhookSecret(workspaceId, provider, user.id);
  }
}
