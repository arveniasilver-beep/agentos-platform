import { Injectable } from '@nestjs/common';
import { Prisma, tenantContext, type RiskLevel } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { computeAuditHash } from './audit.hash';

export interface AuditRecordInput {
  workspaceId: string;
  actorUserId?: string | null;
  actorType?: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  risk?: RiskLevel | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string | null;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  risk: RiskLevel | null;
  createdAt: Date;
}

/** Append-only, hash-chained audit log. No updates/deletes in app paths. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    // The hash chain is per-workspace, so scope the read+write to this record's workspace. This
    // also makes auditing work on routes that have no ambient workspace context (e.g. creating a
    // workspace, where the :workspaceId param doesn't exist yet) without bypassing RLS.
    await tenantContext.runWorkspace(input.workspaceId, async () => {
      const last = await this.prisma.auditLog.findFirst({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: 'desc' },
        select: { hash: true },
      });
      const createdAt = new Date();
      const prevHash = last?.hash ?? null;
      const hash = computeAuditHash(prevHash, {
        action: input.action,
        actorUserId: input.actorUserId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        createdAtIso: createdAt.toISOString(),
      });

      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId ?? null,
          actorType: input.actorType ?? 'user',
          action: input.action,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          risk: input.risk ?? null,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          prevHash,
          hash,
          createdAt,
        },
      });
    });
  }

  async list(workspaceId: string): Promise<AuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        action: true,
        actorUserId: true,
        actorType: true,
        targetType: true,
        targetId: true,
        risk: true,
        createdAt: true,
      },
    });
    return rows;
  }

  /** Recompute the chain and confirm it has not been tampered with. */
  async verifyChain(workspaceId: string): Promise<boolean> {
    const rows = await this.prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        actorUserId: true,
        targetType: true,
        targetId: true,
        createdAt: true,
        prevHash: true,
        hash: true,
      },
    });
    let prev: string | null = null;
    for (const r of rows) {
      const expected = computeAuditHash(prev, {
        action: r.action,
        actorUserId: r.actorUserId,
        targetType: r.targetType,
        targetId: r.targetId,
        createdAtIso: r.createdAt.toISOString(),
      });
      if (r.prevHash !== prev || r.hash !== expected) {
        return false;
      }
      prev = r.hash;
    }
    return true;
  }
}
