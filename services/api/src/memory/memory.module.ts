import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

/**
 * Project Memory / Context System (TICKET-MEMORY). MemoryService is exported so TasksModule can inject
 * it for task-start retrieval + injection. Prisma/Audit are global.
 */
@Module({
  imports: [AuthModule],
  controllers: [MemoryController],
  providers: [MemoryService, WorkspaceRoleGuard],
  exports: [MemoryService],
})
export class MemoryModule {}
