import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { UsageService, type UsageSummary } from './usage.service';

@Controller('workspaces/:workspaceId/usage')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @MinRole('member')
  summary(@Param('workspaceId') workspaceId: string): Promise<UsageSummary> {
    return this.usage.summary(workspaceId);
  }
}
