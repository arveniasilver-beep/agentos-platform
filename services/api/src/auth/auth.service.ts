import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hashPassword, verifyPassword, generateToken, hashToken } from '@agentos/auth';
import { PrismaService } from '../prisma/prisma.service';
import type { RegisterDto, LoginDto } from './dto';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(dto: RegisterDto): Promise<SessionUser> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await hashPassword(dto.password);
    const user = await this.prisma.user.create({
      data: { email: dto.email, displayName: dto.displayName, passwordHash },
    });
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  async login(dto: LoginDto): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await verifyPassword(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Suspended/deleted accounts can't sign in (same generic error to avoid enumeration).
    if (user.status !== 'active' || user.deletedAt) {
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  /** Create a session; returns the opaque token (only its hash is persisted). */
  async createSession(userId: string, meta: { userAgent?: string; ip?: string }): Promise<string> {
    const token = generateToken();
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
      },
    });
    return token;
  }

  /** Resolve a session token to its user, or null if missing/expired. */
  async resolveSession(token: string): Promise<SessionUser | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return null;
    }
    // A suspended/deleted user's existing sessions stop resolving immediately (fail closed).
    if (session.user.status !== 'active' || session.user.deletedAt) {
      return null;
    }
    await this.prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
    };
  }

  async destroySession(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  // ---- Device Sync (TICKET-5) -------------------------------------------------------------------

  /** Register a device; returns the opaque Bearer token ONCE (only its hash is persisted). The `aosd_`
   * prefix lets the auth guard route it to device resolution (vs the cookie session). */
  async registerDevice(userId: string, name: string, platform: string, userAgent?: string): Promise<{ id: string; token: string }> {
    const token = `aosd_${generateToken()}`;
    const device = await this.prisma.device.create({
      data: { userId, name, platform, tokenHash: hashToken(token), userAgent: userAgent ?? null },
    });
    return { id: device.id, token };
  }

  /** Resolve a device Bearer token to its user, or null if missing/revoked/inactive (fail-closed). */
  async resolveDevice(token: string): Promise<(SessionUser & { deviceId: string }) | null> {
    const device = await this.prisma.device.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!device || device.revokedAt) return null;
    if (device.user.status !== 'active' || device.user.deletedAt) return null;
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    return { id: device.user.id, email: device.user.email, displayName: device.user.displayName, deviceId: device.id };
  }

  /** Revoke (logout) a device — it stops resolving immediately. Scoped to the owner. */
  async revokeDevice(userId: string, deviceId: string): Promise<{ revoked: boolean }> {
    const res = await this.prisma.device.updateMany({ where: { id: deviceId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { revoked: res.count > 0 };
  }

  /** List a user's devices (no token material). */
  listDevices(userId: string): Promise<Array<{ id: string; name: string; platform: string; lastSeenAt: Date; revokedAt: Date | null; createdAt: Date }>> {
    return this.prisma.device.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, platform: true, lastSeenAt: true, revokedAt: true, createdAt: true },
    });
  }
}
