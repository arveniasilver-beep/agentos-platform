import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { AuditService, type AuditEntry } from './audit.service';

@Controller('workspaces/:workspaceId/audit')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @MinRole('admin')
  async list(
    @Param('workspaceId') workspaceId: string,
  ): Promise<{ entries: AuditEntry[]; chainValid: boolean }> {
    const [entries, chainValid] = await Promise.all([
      this.audit.list(workspaceId),
      this.audit.verifyChain(workspaceId),
    ]);
    return { entries, chainValid };
  }
}
