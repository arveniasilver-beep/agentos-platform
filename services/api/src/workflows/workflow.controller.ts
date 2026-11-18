import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { loadServerEnv } from '@agentos/config';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { WorkflowService } from './workflow.service';
import { createWorkflowSchema, updateWorkflowSchema, decideWorkflowApprovalSchema, type CreateWorkflowDto, type UpdateWorkflowDto, type DecideWorkflowApprovalDto } from './dto';

/** Workflow Builder (TICKET-8). create/run are flag-gated (WORKFLOW_BUILDER_ENABLED); list/get are reads. */
@Controller('workspaces/:workspaceId/workflows')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService) {}

  private ensureEnabled() {
    if (!loadServerEnv().WORKFLOW_BUILDER_ENABLED) throw new NotFoundException('Workflow builder is not enabled.');
  }

  @Post()
  @MinRole('member')
  create(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(createWorkflowSchema)) dto: CreateWorkflowDto) {
    this.ensureEnabled();
    return this.workflows.create(workspaceId, user.id, dto);
  }

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.workflows.list(workspaceId);
  }

  @Get(':id')
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.workflows.get(workspaceId, id);
  }

  @Patch(':id')
  @MinRole('member')
  update(@Param('workspaceId') workspaceId: string, @Param('id') id: string, @Body(new ZodValidationPipe(updateWorkflowSchema)) dto: UpdateWorkflowDto) {
    return this.workflows.setEnabled(workspaceId, id, dto.enabled);
  }

  @Delete(':id')
  @MinRole('member')
  remove(@Param('workspaceId') workspaceId: string, @Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.workflows.remove(workspaceId, id, user.id);
  }

  @Post(':id/run')
  @MinRole('member')
  run(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    this.ensureEnabled();
    return this.workflows.startRun(workspaceId, id, 'manual');
  }

  @Get(':id/runs')
  @MinRole('viewer')
  listRuns(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.workflows.listRuns(workspaceId, id);
  }

  @Get('runs/:runId')
  @MinRole('viewer')
  getRun(@Param('workspaceId') workspaceId: string, @Param('runId') runId: string) {
    return this.workflows.getRun(workspaceId, runId);
  }

  @Post('runs/:runId/approval')
  @MinRole('member')
  decide(@Param('workspaceId') workspaceId: string, @Param('runId') runId: string, @CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(decideWorkflowApprovalSchema)) dto: DecideWorkflowApprovalDto) {
    return this.workflows.decideApproval(workspaceId, runId, dto.decision, user.id);
  }
}
