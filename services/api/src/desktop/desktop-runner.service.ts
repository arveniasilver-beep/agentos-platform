import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, type DesktopRunner, type RiskLevel } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface RegisterRunnerInput {
  version?: string;
  capabilities?: Record<string, unknown>;
}

/** Structural-only relative path for a local action (TICKET-7). Strips any drive letter and DROPS every
 * '.', '..', and empty segment, so the audited string is ALWAYS a clean relative path — never absolute,
 * never a traversal. (Real file access is independently jailed by safeResolve at execution time.) */
function sanitizeRel(relativePath: string): string {
  const noDrive = String(relativePath ?? '').replace(/^[A-Za-z]:[\\/]?/, ''); // C: / C:\ / C:/ (slash optional)
  return noDrive
    .split(/[\\/]+/)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/')
    .slice(0, 400);
}
/** Hash of root|sanitizedRel — correlates actions on the same file without storing the host path. Keyed on
 * the SAME sanitized rel that's stored, so equal files hash equally. */
function pathHashOf(root: string, sanitizedRel: string): string {
  return createHash('sha256').update(`${root}|${sanitizedRel}`).digest('hex').slice(0, 32);
}

/**
 * Desktop Runner Foundation (TICKET-7). Registers/heartbeats a desktop machine's local runner (tied to a
 * TICKET-5 Device for identity + the revoke kill-switch) and records per-runner local-action audit that
 * is CONTENT-FREE and FULL-PATH-FREE (only deviceId/desktopRunnerId/localFolderId/relativePath/pathHash/
 * action/risk). Device revoke is the primary security source; a runner whose device is revoked is
 * fail-closed here too (defense-in-depth).
 */
@Injectable()
export class DesktopRunnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A device must exist and not be revoked to act as a runner (fail-closed). */
  private async requireLiveDevice(deviceId: string): Promise<void> {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, revokedAt: null } });
    if (!device) throw new ForbiddenException('Device is missing or revoked.');
  }

  /** Register (or refresh) the desktop runner for (workspace, device). Requires a live device session. */
  async register(workspaceId: string, deviceId: string | undefined, input: RegisterRunnerInput): Promise<DesktopRunner> {
    if (!deviceId) throw new BadRequestException('Desktop runner registration requires a device session.');
    await this.requireLiveDevice(deviceId);
    const data = {
      version: input.version ?? null,
      // Defense-in-depth (no-host-exec): the server NEVER accepts a shellExec capability claim — host
      // command execution is Phase-5 (signed sidecar). A stored capability can never be mistaken for a grant.
      capabilities: { ...(input.capabilities ?? {}), shellExec: false } as Prisma.InputJsonValue,
      status: 'active',
      lastHeartbeatAt: new Date(),
      revokedAt: null,
    };
    const runner = await this.prisma.desktopRunner.upsert({
      where: { workspaceId_deviceId: { workspaceId, deviceId } },
      create: { workspaceId, deviceId, ...data },
      update: data,
    });
    await this.audit
      .record({ workspaceId, actorType: 'agent', action: 'desktop_runner.registered', targetType: 'desktop_runner', targetId: runner.id, metadata: { deviceId, version: runner.version } })
      .catch(() => undefined);
    return runner;
  }

  /** Heartbeat keeps the runner live. Fails closed if the device is revoked. */
  async heartbeat(workspaceId: string, deviceId: string | undefined): Promise<DesktopRunner> {
    if (!deviceId) throw new BadRequestException('Heartbeat requires a device session.');
    await this.requireLiveDevice(deviceId);
    const existing = await this.prisma.desktopRunner.findUnique({ where: { workspaceId_deviceId: { workspaceId, deviceId } } });
    if (!existing || existing.revokedAt) throw new NotFoundException('No active runner for this device in this workspace.');
    return this.prisma.desktopRunner.update({ where: { id: existing.id }, data: { lastHeartbeatAt: new Date(), status: 'active' } });
  }

  list(workspaceId: string): Promise<DesktopRunner[]> {
    return this.prisma.desktopRunner.findMany({ where: { workspaceId }, orderBy: { lastHeartbeatAt: 'desc' }, take: 50 });
  }
  get(workspaceId: string, id: string): Promise<DesktopRunner | null> {
    return this.prisma.desktopRunner.findFirst({ where: { id, workspaceId } });
  }

  /** Disable a runner (operator action). Device revoke remains the primary kill-switch. */
  async setStatus(workspaceId: string, id: string, status: 'active' | 'idle' | 'disabled'): Promise<DesktopRunner> {
    const r = await this.get(workspaceId, id);
    if (!r) throw new NotFoundException('Runner not found in this workspace.');
    return this.prisma.desktopRunner.update({ where: { id }, data: { status, ...(status === 'disabled' ? { revokedAt: new Date() } : {}) } });
  }

  /** The live runner for this workspace whose device is NOT revoked (fail-closed attribution source). */
  private activeRunner(workspaceId: string) {
    return this.prisma.desktopRunner.findFirst({
      where: { workspaceId, revokedAt: null, status: { in: ['active', 'idle'] }, device: { revokedAt: null } },
      orderBy: { lastHeartbeatAt: 'desc' },
    });
  }

  /**
   * Record a local file action against the workspace's active desktop runner. The audit carries ONLY
   * structural metadata — never file content, secrets, or the full absolute host path. No-ops if local-fs
   * is not in approved scope (unknown folder label).
   */
  async recordLocalAction(workspaceId: string, p: { folderLabel: string; relativePath: string; action: string; risk?: string; approvalId?: string }): Promise<void> {
    const folder = await this.prisma.localFolder.findFirst({ where: { workspaceId, label: p.folderLabel } });
    if (!folder) return; // not an approved folder => nothing to attribute
    const runner = await this.activeRunner(workspaceId);
    const rel = sanitizeRel(p.relativePath); // clean relative path used for BOTH the stored path and the hash
    await this.audit
      .record({
        workspaceId,
        actorType: 'agent',
        action: `local.${p.action}`,
        targetType: 'local_folder',
        targetId: folder.id,
        ...(p.risk ? { risk: p.risk as RiskLevel } : {}),
        metadata: {
          deviceId: runner?.deviceId ?? null,
          desktopRunnerId: runner?.id ?? null,
          localFolderId: folder.id,
          relativePath: rel, // relative only — never the absolute host path / traversal
          pathHash: pathHashOf(folder.path, rel), // hash of root|sanitizedRel; the root is not stored
          action: p.action,
          ...(p.approvalId ? { approvalId: p.approvalId } : {}),
        },
      })
      .catch(() => undefined);
  }
}
