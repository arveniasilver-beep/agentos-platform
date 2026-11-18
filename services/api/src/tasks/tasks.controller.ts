import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TasksService } from './tasks.service';
import {
  createTaskSchema,
  decideApprovalSchema,
  followupMessageSchema,
  updateTaskMetaSchema,
  type CreateTaskDto,
  type DecideApprovalDto,
  type FollowupMessageDto,
  type UpdateTaskMetaDto,
} from './dto';

@Controller('workspaces/:workspaceId/tasks')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  @MinRole('member')
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(createTaskSchema)) dto: CreateTaskDto,
  ) {
    return this.tasks.createAndStart(workspaceId, user.id, dto);
  }

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string, @Query('archived') archived?: string) {
    return this.tasks.list(workspaceId, { archived: archived === 'true' });
  }

  // Declared before :taskId so the static `search` segment is unambiguous.
  @Get('search')
  @MinRole('viewer')
  search(@Param('workspaceId') workspaceId: string, @Query('q') q?: string) {
    return this.tasks.search(workspaceId, q ?? '');
  }

  @Get(':taskId')
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('taskId') taskId: string) {
    return this.tasks.get(workspaceId, taskId);
  }

  @Get(':taskId/events')
  @MinRole('viewer')
  events(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('afterSeq') afterSeq?: string,
  ) {
    const after = afterSeq !== undefined ? Number.parseInt(afterSeq, 10) : undefined;
    return this.tasks.events(
      workspaceId,
      taskId,
      after !== undefined && Number.isFinite(after) ? after : undefined,
    );
  }

  @Patch(':taskId')
  @MinRole('member')
  updateMeta(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(updateTaskMetaSchema)) dto: UpdateTaskMetaDto,
  ) {
    return this.tasks.updateMeta(workspaceId, taskId, user.id, dto);
  }

  @Delete(':taskId')
  @MinRole('member')
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.tasks.deleteTask(workspaceId, taskId, user.id);
  }

  @Post(':taskId/stop')
  @MinRole('member')
  stop(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.tasks.stop(workspaceId, taskId, user.id);
  }

  // Multi-turn follow-up (KEYSTONE): continue a finished task with a new user message. Flag-gated in the
  // service (404 when off). GET lists the durable chat thread.
  @Post(':taskId/messages')
  @MinRole('member')
  sendFollowup(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(followupMessageSchema)) dto: FollowupMessageDto,
  ) {
    return this.tasks.sendFollowup(workspaceId, taskId, user.id, dto.text);
  }

  @Get(':taskId/messages')
  @MinRole('viewer')
  listMessages(@Param('workspaceId') workspaceId: string, @Param('taskId') taskId: string) {
    return this.tasks.listMessages(workspaceId, taskId);
  }

  @Post(':taskId/share')
  @MinRole('member')
  share(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.tasks.share(workspaceId, taskId, user.id);
  }

  @Delete(':taskId/share')
  @MinRole('member')
  unshare(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.tasks.unshare(workspaceId, taskId, user.id);
  }

  @Post(':taskId/approvals/:approvalId')
  @MinRole('member')
  decide(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Param('approvalId') approvalId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(decideApprovalSchema)) dto: DecideApprovalDto,
    @Req() req: { deviceId?: string },
  ) {
    // TICKET-6: req.deviceId is set by AuthGuard when a Bearer device session made this call.
    return this.tasks.decideApproval(workspaceId, taskId, approvalId, dto.decision, user.id, dto.confirmation, req.deviceId);
  }
}
