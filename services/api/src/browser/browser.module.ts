import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { BrowserController } from './browser.controller';
import { BrowserOperatorService } from './browser-operator.service';

/**
 * Browser Operator Hardening (TICKET-1). Exports BrowserOperatorService so the task-runner browser sink
 * can durably track + audit agent browser actions. Prisma/Audit are global.
 */
@Module({
  imports: [AuthModule],
  controllers: [BrowserController],
  providers: [BrowserOperatorService, WorkspaceRoleGuard],
  exports: [BrowserOperatorService],
})
export class BrowserModule {}
