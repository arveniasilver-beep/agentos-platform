import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  taskId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * In-app notifications (the header bell). Read-side here; rows are written by the task lifecycle
 * (TaskRunner) on approval-needed / task-done. Tenancy-scoped by workspace (RLS) + the current user.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, userId: string): Promise<{ items: NotificationView[]; unread: number }> {
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { workspaceId, userId },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { id: true, kind: true, title: true, body: true, taskId: true, readAt: true, createdAt: true },
      }),
      this.prisma.notification.count({ where: { workspaceId, userId, readAt: null } }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        taskId: r.taskId,
        readAt: r.readAt ? r.readAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      unread,
    };
  }

  /** Mark one (id) or all of the user's notifications read. */
  async markRead(workspaceId: string, userId: string, id?: string): Promise<{ unread: number }> {
    await this.prisma.notification.updateMany({
      where: { workspaceId, userId, readAt: null, ...(id ? { id } : {}) },
      data: { readAt: new Date() },
    });
    const unread = await this.prisma.notification.count({ where: { workspaceId, userId, readAt: null } });
    return { unread };
  }
}
