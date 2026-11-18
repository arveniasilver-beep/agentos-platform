import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { basename } from 'node:path';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ArtifactsService, type Artifact, type ArtifactMeta, type LibraryItem } from './artifacts.service';

/** Sanitize a filename for a quoted Content-Disposition token (no quotes/backslashes/control chars). */
function safeDispositionName(name: string): string {
  return (
    [...basename(name)].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '"' && ch !== '\\').join('') ||
    'download'
  );
}

// Upload is a base64-in-JSON payload (capped by the global MAX_BODY_BYTES). Larger files would
// want a streaming/multipart route — a documented follow-up.
const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
});
type UploadDto = z.infer<typeof uploadSchema>;

/** The subset of the Fastify reply we use (avoids a direct fastify dependency). */
interface ReplyLike {
  header(key: string, value: string): ReplyLike;
  send(payload: unknown): unknown;
}

@Controller('workspaces/:workspaceId/tasks/:taskId/artifacts')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get()
  @MinRole('viewer')
  list(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
  ): Promise<Artifact[]> {
    return this.artifacts.list(workspaceId, taskId);
  }

  @Post('upload')
  @MinRole('member')
  upload(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Body(new ZodValidationPipe(uploadSchema)) dto: UploadDto,
  ): Promise<Artifact> {
    return this.artifacts.upload(workspaceId, taskId, dto.filename, Buffer.from(dto.dataBase64, 'base64'));
  }

  @Get('download')
  @MinRole('viewer')
  async download(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
    @Query('path') path: string,
    @Res() reply: ReplyLike,
  ): Promise<void> {
    const file = await this.artifacts.read(workspaceId, taskId, path ?? '');
    // Sanitize the filename for the quoted Content-Disposition token: drop quotes, backslashes and
    // control chars (incl. CR/LF) so a crafted filename can't break out of / inject the header.
    const safeName =
      [...basename(file.path)]
        .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '"' && ch !== '\\')
        .join('') || 'download';
    reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .send(file.data);
  }

  // ---- Durable Artifact Persistence (TICKET-ART) — DB-backed, blob-stored artifacts ----

  /** List durable artifacts (DB-backed) for a task, newest first. */
  @Get('durable')
  @MinRole('viewer')
  listDurable(
    @Param('workspaceId') workspaceId: string,
    @Param('taskId') taskId: string,
  ): Promise<ArtifactMeta[]> {
    return this.artifacts.listDurable(workspaceId, taskId);
  }

  /** Metadata for one durable artifact (workspace-scoped; cross-workspace ids resolve to 404). */
  @Get('id/:artifactId')
  @MinRole('viewer')
  metaById(
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
  ): Promise<ArtifactMeta> {
    return this.artifacts.getMetaById(workspaceId, artifactId);
  }

  /** Download one durable artifact's bytes from blob storage (authed; no public/presigned URL). An
   * optional ?version=N downloads that specific version (default: the current one). */
  @Get('id/:artifactId/download')
  @MinRole('viewer')
  async downloadById(
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
    @Res() reply: ReplyLike,
    @Query('version') version?: string,
  ): Promise<void> {
    const v = version !== undefined && version !== '' ? Number(version) : undefined;
    const file = await this.artifacts.downloadById(workspaceId, artifactId, Number.isFinite(v) ? v : undefined);
    reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${safeDispositionName(file.filename)}"`)
      .send(file.data);
  }

  /** Artifact lifecycle (Ticket-10): the version history of one durable artifact (which is current). */
  @Get('id/:artifactId/versions')
  @MinRole('viewer')
  versions(
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
  ): Promise<{ versions: ArtifactMeta[]; currentVersionId: string | null }> {
    return this.artifacts.listVersions(workspaceId, artifactId);
  }

  /** Roll a durable artifact back to a prior version (non-destructive: re-points the current pointer). */
  @Post('id/:artifactId/rollback')
  @MinRole('member')
  rollback(
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
    @Body(new ZodValidationPipe(z.object({ version: z.number().int().positive() }))) dto: { version: number },
  ): Promise<ArtifactMeta> {
    return this.artifacts.rollback(workspaceId, artifactId, dto.version);
  }
}

/** Cross-task Library (Manus's Kütüphane): every artifact across the workspace's tasks. Downloads
 * still go through the per-task artifacts route above (tenancy + path canonicalization there). */
@Controller('workspaces/:workspaceId/library')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class LibraryController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get()
  @MinRole('viewer')
  list(
    @Param('workspaceId') workspaceId: string,
  ): Promise<{ items: LibraryItem[]; truncated: boolean }> {
    return this.artifacts.listAll(workspaceId);
  }
}
