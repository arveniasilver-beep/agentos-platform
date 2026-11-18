import { Injectable, NotFoundException } from '@nestjs/common';
import { generateToken, hashToken, safeEqual } from '@agentos/auth';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { CreateApiKeyDto } from './dto';

/** The resolved identity behind a valid API key (used to scope public-API requests). */
export interface ApiKeyContext {
  workspaceId: string;
  keyId: string;
  createdByUserId: string;
}

const TOKEN_PREFIX = 'aos_';

/**
 * Programmatic access tokens for the public API. The plaintext token is shown ONCE at creation;
 * only a SHA-256 hash of the secret is stored. Format: `aos_<publicId>.<secret>` — the publicId
 * (a non-secret lookup id) avoids a table scan, the secret is verified in constant time.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(workspaceId: string, userId: string, dto: CreateApiKeyDto) {
    const publicId = generateToken(9); // ~12 base64url chars, no '.'
    const secret = generateToken(32);
    const expiresAt = dto.expiresInDays
      ? new Date(Date.now() + dto.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    const record = await this.prisma.apiKey.create({
      data: {
        workspaceId,
        purpose: 'public_api',
        publicId,
        hashedKey: hashToken(secret),
        scopes: dto.label ? { label: dto.label } : undefined,
        expiresAt,
        createdByUserId: userId,
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'apikey.create',
      targetType: 'api_key',
      targetId: record.id,
      risk: 'high',
    });
    // The plaintext token is returned ONCE and never stored.
    return { id: record.id, token: `${TOKEN_PREFIX}${publicId}.${secret}`, createdAt: record.createdAt };
  }

  async list(workspaceId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { workspaceId, purpose: 'public_api' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, publicId: true, scopes: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true },
    });
    return keys.map((k) => ({
      id: k.id,
      publicId: k.publicId,
      label: (k.scopes as { label?: string } | null)?.label ?? null,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    }));
  }

  async revoke(workspaceId: string, keyId: string, userId: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id: keyId, workspaceId, purpose: 'public_api' } });
    if (!key) throw new NotFoundException('API key not found in this workspace.');
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'apikey.revoke',
      targetType: 'api_key',
      targetId: keyId,
      risk: 'high',
    });
    return { revoked: true };
  }

  /** Resolve a presented token to its workspace/actor, or null if invalid/revoked/expired. */
  async resolve(token: string): Promise<ApiKeyContext | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    // Require a canonical `<publicId>.<secret>` (exactly two non-empty segments) — base64url never
    // contains '.', so reject any malleable variant with extra/missing separators.
    const parts = token.slice(TOKEN_PREFIX.length).split('.');
    if (parts.length !== 2) return null;
    const [publicId, secret] = parts;
    if (!publicId || !secret) return null;
    const key = await this.prisma.apiKey.findUnique({ where: { publicId } });
    if (!key || key.purpose !== 'public_api' || key.revokedAt || !key.hashedKey) return null;
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;
    if (!safeEqual(hashToken(secret), key.hashedKey)) return null;
    await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { workspaceId: key.workspaceId, keyId: key.id, createdByUserId: key.createdByUserId };
  }
}
