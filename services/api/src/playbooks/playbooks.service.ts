import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface CreatePlaybookInput {
  name: string;
  prompt: string;
  capability?: string;
  effort?: string;
}

/**
 * Reusable task templates (Manus "Playbook"): CRUD only. Running a playbook is the frontend creating
 * a task from the saved {prompt, capability, effort} — so this service stays decoupled from the task
 * engine. Workspace-scoped; the route's tenant context + RLS enforce isolation.
 */
@Injectable()
export class PlaybooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(workspaceId: string) {
    return this.prisma.playbook.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  async create(workspaceId: string, userId: string, input: CreatePlaybookInput) {
    const playbook = await this.prisma.playbook.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        name: input.name,
        prompt: input.prompt,
        capability: input.capability ?? null,
        effort: input.effort ?? null,
      },
    });
    // TICKET-4: close the audit gap (playbook CRUD was previously unaudited).
    await this.audit
      .record({ workspaceId, actorUserId: userId, action: 'playbook.create', targetType: 'playbook', targetId: playbook.id, metadata: { name: playbook.name, capability: playbook.capability } })
      .catch(() => undefined);
    return playbook;
  }

  async remove(workspaceId: string, id: string, userId?: string): Promise<{ id: string }> {
    // deleteMany scoped by workspaceId so a cross-tenant id can't delete another workspace's row
    // (belt-and-suspenders over RLS); 0 rows => not found in this workspace.
    const res = await this.prisma.playbook.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new ForbiddenException('Playbook not found in this workspace.');
    await this.audit
      .record({ workspaceId, ...(userId ? { actorUserId: userId } : {}), action: 'playbook.delete', targetType: 'playbook', targetId: id })
      .catch(() => undefined);
    return { id };
  }
}
