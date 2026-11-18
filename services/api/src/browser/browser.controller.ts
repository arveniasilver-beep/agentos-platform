import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { BrowserOperatorService } from './browser-operator.service';

/** Read-only browser trace API (TICKET-1): durable sessions + their redacted action timeline. Write
 * actions still flow through the agent runtime + the existing approval API. */
@Controller('workspaces/:workspaceId/browser-sessions')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class BrowserController {
  constructor(private readonly operator: BrowserOperatorService) {}

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.operator.listSessions(workspaceId);
  }

  @Get(':sessionId')
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('sessionId') sessionId: string) {
    return this.operator.getSession(workspaceId, sessionId);
  }

  @Get(':sessionId/actions')
  @MinRole('viewer')
  actions(@Param('workspaceId') workspaceId: string, @Param('sessionId') sessionId: string) {
    return this.operator.listActions(workspaceId, sessionId);
  }
}
