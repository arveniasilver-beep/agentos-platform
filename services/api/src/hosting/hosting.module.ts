import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { HostingService } from './hosting.service';
import { HostingController } from './hosting.controller';

@Module({
  imports: [AuthModule, SecretsModule],
  controllers: [HostingController],
  providers: [HostingService, WorkspaceRoleGuard],
  exports: [HostingService],
})
export class HostingModule {}
