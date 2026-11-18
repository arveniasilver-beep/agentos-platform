import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Device Sync (TICKET-5): a consolidated, minimal, workspace-scoped snapshot a device polls to render a
 * consistent view (task status, pending approvals, recent artifacts, automation runs, unread count). All
 * fields are minimal + non-sensitive — no prompts, args, outputs, secrets, or tokens.
 */
@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(workspaceId: string, userId: string) {
    const [tasks, approvals, artifacts, automationRuns, unreadNotifications] = await Promise.all([
      this.prisma.task.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: 'desc' },
        take: 25,
        select: { id: true, title: true, status: true, updatedAt: true },
      }),
      this.prisma.approval.findMany({
        where: { workspaceId, status: 'pending' },
        orderBy: { requestedAt: 'desc' },
        take: 25,
        select: { id: true, approvalId: true, taskId: true, action: true, risk: true, elevated: true, requestedAt: true },
      }),
      this.prisma.artifact.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, taskId: true, name: true, kind: true, createdAt: true },
      }),
      this.prisma.automationRun.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, automationId: true, status: true, triggeredBy: true, finishedAt: true },
      }),
      this.prisma.notification.count({ where: { workspaceId, userId, readAt: null } }),
    ]);
    return { tasks, approvals, artifacts, automationRuns, unreadNotifications, serverTime: new Date().toISOString() };
  }
}
