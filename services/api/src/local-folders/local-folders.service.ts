import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { loadServerEnv } from '@agentos/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface AddLocalFolderInput {
  label: string;
  path: string;
  writable?: boolean;
}

/**
 * "My Computer": manage the host folders a workspace approved the agent to operate on. Honored only
 * when the server runs with ENABLE_LOCAL_FS (a local/desktop deployment); otherwise the feature is off.
 */
@Injectable()
export class LocalFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  enabled(): boolean {
    return loadServerEnv().ENABLE_LOCAL_FS;
  }

  list(workspaceId: string) {
    return this.prisma.localFolder.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  }

  /** SERVER-ONLY: the approved folders shaped for the tool factory (empty when the feature is off). */
  async approvedFor(workspaceId: string): Promise<{ label: string; root: string; writable: boolean }[]> {
    if (!this.enabled()) return [];
    const rows = await this.prisma.localFolder.findMany({ where: { workspaceId } });
    return rows.map((r) => ({ label: r.label, root: r.path, writable: r.writable }));
  }

  async add(workspaceId: string, userId: string, input: AddLocalFolderInput) {
    if (!this.enabled()) {
      throw new BadRequestException('Local folder access is disabled on this server (ENABLE_LOCAL_FS).');
    }
    const path = input.path.trim();
    if (!isAbsolute(path)) throw new BadRequestException('Provide an absolute folder path.');
    // The folder must exist and be a directory (fail fast, clear error).
    const s = await stat(path).catch(() => null);
    if (!s || !s.isDirectory()) throw new BadRequestException('That path is not an existing folder on the server host.');
    const folder = await this.prisma.localFolder.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        label: input.label.trim() || path,
        path,
        writable: input.writable ?? false,
      },
    });
    // Approving a host folder grants the agent real filesystem access — record who/what.
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'local_folder.add',
      targetType: 'local_folder',
      targetId: folder.id,
      risk: 'high',
      metadata: { path, writable: folder.writable },
    });
    return folder;
  }

  async remove(workspaceId: string, userId: string, id: string): Promise<{ id: string }> {
    const res = await this.prisma.localFolder.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new ForbiddenException('Folder not found in this workspace.');
    // Revoking the agent's access to a host folder is security-relevant — attribute it.
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'local_folder.remove',
      targetType: 'local_folder',
      targetId: id,
      risk: 'medium',
      metadata: {},
    });
    return { id };
  }
}
