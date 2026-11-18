import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TasksModule } from '../tasks/tasks.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { InboundService } from './inbound.service';
import { InboundConfigController, InboundWebhookController } from './inbound.controller';
import { InboundThrottlerGuard } from './inbound-throttler.guard';

@Module({
  imports: [AuthModule, TasksModule],
  controllers: [InboundConfigController, InboundWebhookController],
  providers: [InboundService, WorkspaceRoleGuard, InboundThrottlerGuard],
})
export class InboundModule {}
