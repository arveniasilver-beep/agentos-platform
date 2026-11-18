import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { ConnectorsService } from './connectors.service';
import { ConnectorsController, ConnectorCallbackController } from './connectors.controller';

@Module({
  imports: [AuthModule, SecretsModule],
  controllers: [ConnectorsController, ConnectorCallbackController],
  providers: [ConnectorsService, WorkspaceRoleGuard],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
