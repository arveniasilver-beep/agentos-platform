import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorRegistryController } from './connector-registry.controller';
import { ConnectorWebhookController } from './connector-webhook.controller';

/** Connectors v2 (TICKET-9): manifest registry + scope enforcement + secure webhook ingestion + health. */
@Module({
  imports: [AuthModule],
  controllers: [ConnectorRegistryController, ConnectorWebhookController],
  providers: [ConnectorRegistryService, WorkspaceRoleGuard],
  exports: [ConnectorRegistryService],
})
export class ConnectorRegistryModule {}
