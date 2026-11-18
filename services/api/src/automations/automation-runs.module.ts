import { Module } from '@nestjs/common';
import { AutomationRunsService } from './automation-runs.service';

/**
 * Durable AutomationRun lifecycle (TICKET-AUTOMATION). Stand-alone (deps are global: Prisma, Audit,
 * Queue) so it can be imported by BOTH TasksModule (terminal sync) and AutomationsModule (fire
 * orchestration) without a circular module graph.
 */
@Module({
  providers: [AutomationRunsService],
  exports: [AutomationRunsService],
})
export class AutomationRunsModule {}
