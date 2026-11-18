import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AutomationsService } from './automations.service';
import {
  createAutomationSchema,
  updateAutomationSchema,
  type CreateAutomationDto,
  type UpdateAutomationDto,
} from './dto';

@Controller('workspaces/:workspaceId/automations')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.automations.list(workspaceId);
  }

  @Get(':automationId')
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('automationId') automationId: string) {
    return this.automations.get(workspaceId, automationId);
  }

  // Durable AutomationRun history (TICKET-AUTOMATION). Empty until AUTOMATION_RUNS_ENABLED runs exist.
  @Get(':automationId/runs')
  @MinRole('viewer')
  runs(@Param('workspaceId') workspaceId: string, @Param('automationId') automationId: string) {
    return this.automations.listRuns(workspaceId, automationId);
  }

  @Post()
  @MinRole('member')
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(createAutomationSchema)) dto: CreateAutomationDto,
  ) {
    return this.automations.create(workspaceId, user.id, dto);
  }

  @Patch(':automationId')
  @MinRole('member')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('automationId') automationId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(updateAutomationSchema)) dto: UpdateAutomationDto,
  ) {
    return this.automations.update(workspaceId, automationId, user.id, dto);
  }

  @Post(':automationId/run')
  @MinRole('member')
  runNow(
    @Param('workspaceId') workspaceId: string,
    @Param('automationId') automationId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.automations.runNow(workspaceId, automationId, user.id);
  }

  @Delete(':automationId')
  @MinRole('member')
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('automationId') automationId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.automations.remove(workspaceId, automationId, user.id);
  }
}
