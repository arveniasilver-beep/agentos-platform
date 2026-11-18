import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecretsService } from './secrets.service';
import { SettingsController, BrainProviderController, PeerProviderController, RouteProviderController } from './settings.controller';
import { AuditController } from '../audit/audit.controller';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';

@Module({
  imports: [AuthModule],
  controllers: [SettingsController, BrainProviderController, PeerProviderController, RouteProviderController, AuditController],
  providers: [SecretsService, WorkspaceRoleGuard],
  exports: [SecretsService],
})
export class SecretsModule {}
