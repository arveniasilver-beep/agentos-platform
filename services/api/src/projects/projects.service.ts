import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateProjectDto } from '../workspaces/dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  create(workspaceId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: { workspaceId, name: dto.name, description: dto.description ?? null },
    });
  }

  list(workspaceId: string) {
    return this.prisma.project.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }
}
