import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TasksModule } from '../tasks/tasks.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyThrottlerGuard } from './api-key-throttler.guard';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiController } from './public-api.controller';

@Module({
  imports: [AuthModule, TasksModule],
  controllers: [ApiKeysController, PublicApiController],
  providers: [ApiKeysService, ApiKeyGuard, ApiKeyThrottlerGuard, WorkspaceRoleGuard],
})
export class ApiKeysModule {}
