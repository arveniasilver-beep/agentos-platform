import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TasksModule } from '../tasks/tasks.module';
import { TasksService } from '../tasks/tasks.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from './workflow.service';
import { WorkflowController } from './workflow.controller';
import { WorkflowWebhookController } from './workflow-webhook.controller';

/**
 * Workflow Builder (TICKET-8). WorkflowService is built via a factory that injects TasksService as the
 * TaskLauncher (the service uses the minimal interface, so workflow.service.ts never imports TasksService
 * — no circular import; the task-terminal sink in tasks.service lazily constructs its own instance).
 */
@Module({
  imports: [AuthModule, TasksModule],
  controllers: [WorkflowController, WorkflowWebhookController],
  providers: [
    {
      provide: WorkflowService,
      useFactory: (prisma: PrismaService, audit: AuditService, tasks: TasksService) => new WorkflowService(prisma, audit, tasks),
      inject: [PrismaService, AuditService, TasksService],
    },
    WorkspaceRoleGuard,
  ],
  exports: [WorkflowService],
})
export class WorkflowModule {}
