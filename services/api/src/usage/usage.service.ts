import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UsageSummary {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    taskCount: number;
  };
  recentTasks: Array<{
    id: string;
    title: string;
    status: string;
    costUsd: number;
    createdAt: Date;
  }>;
}

/** Aggregates token + cost metering for a workspace (from usage_records / cost_records). */
@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(workspaceId: string): Promise<UsageSummary> {
    const [usage, cost, taskCount, recent] = await Promise.all([
      this.prisma.usageRecord.aggregate({
        where: { workspaceId },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
        },
      }),
      this.prisma.costRecord.aggregate({ where: { workspaceId }, _sum: { amountUsd: true } }),
      this.prisma.task.count({ where: { workspaceId } }),
      this.prisma.task.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, title: true, status: true, estCostUsd: true, createdAt: true },
      }),
    ]);

    return {
      totals: {
        inputTokens: Number(usage._sum.inputTokens ?? 0n),
        outputTokens: Number(usage._sum.outputTokens ?? 0n),
        cacheReadTokens: Number(usage._sum.cacheReadTokens ?? 0n),
        cacheWriteTokens: Number(usage._sum.cacheWriteTokens ?? 0n),
        costUsd: cost._sum.amountUsd ? Number(cost._sum.amountUsd) : 0,
        taskCount,
      },
      recentTasks: recent.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        costUsd: t.estCostUsd ? Number(t.estCostUsd) : 0,
        createdAt: t.createdAt,
      })),
    };
  }
}
