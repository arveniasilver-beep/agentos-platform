import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantContext, TaskStatus } from '@agentos/db';
import { AuthService } from '../auth/auth.service';
import { AuthGuard } from '../auth/auth.guard';
import { SyncService } from './sync.service';

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) { process.env.DATABASE_URL = m[1]; break; }
    }
  }
}
const suite = process.env.DATABASE_URL ? describe : describe.skip;

function ctxWithBearer(token?: string): ExecutionContext {
  const req: Record<string, unknown> = { cookies: {}, headers: token ? { authorization: `Bearer ${token}` } : {} };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

suite('Device Sync (TICKET-5, live Postgres)', () => {
  const prisma = getPrisma();
  const auth = new AuthService(prisma as never);
  const sync = new SyncService(prisma as never);
  const guard = new AuthGuard(auth);
  const sfx = Date.now().toString(36);
  let userA = '';
  let userB = '';
  let wsId = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    userA = (await prisma.user.create({ data: { email: `dvA-${sfx}@t.local`, displayName: 'A' } })).id;
    userB = (await prisma.user.create({ data: { email: `dvB-${sfx}@t.local`, displayName: 'B' } })).id;
    wsId = (await prisma.workspace.create({ data: { name: 'W', slug: `dv-${sfx}`, ownerUserId: userA } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: wsId, userId: userA, role: 'owner' } }).catch(() => undefined);
    await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: userA, title: 'My task', prompt: 'secret prompt body', status: TaskStatus.running } });
  });
  afterAll(async () => {
    delete process.env.DEVICE_SYNC_ENABLED;
    if (wsId) await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    for (const u of [userA, userB]) if (u) await prisma.user.delete({ where: { id: u } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('register returns a Bearer token; resolve maps it to the user; bad token is null', async () => {
    const dev = await auth.registerDevice(userA, 'Pixel', 'android', 'ua/1');
    expect(dev.token.startsWith('aosd_')).toBe(true);
    const resolved = await auth.resolveDevice(dev.token);
    expect(resolved?.id).toBe(userA);
    expect(resolved?.deviceId).toBe(dev.id);
    expect(await auth.resolveDevice('aosd_wrong')).toBeNull();
  });

  it('revoke is owner-scoped and stops resolution immediately', async () => {
    const dev = await auth.registerDevice(userA, 'Laptop', 'desktop');
    expect((await auth.revokeDevice(userB, dev.id)).revoked).toBe(false); // not the owner
    expect((await auth.resolveDevice(dev.token))?.id).toBe(userA); // still valid
    expect((await auth.revokeDevice(userA, dev.id)).revoked).toBe(true);
    expect(await auth.resolveDevice(dev.token)).toBeNull(); // revoked => fail-closed
  });

  it('listDevices returns metadata only (no token material)', async () => {
    const list = await auth.listDevices(userA);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(list[0]!)).not.toContain('tokenHash');
    expect(Object.keys(list[0]!)).toEqual(expect.arrayContaining(['id', 'name', 'platform', 'lastSeenAt']));
  });

  it('AuthGuard: Bearer device accepted only when DEVICE_SYNC_ENABLED (flag-off byte-identical)', async () => {
    const dev = await auth.registerDevice(userA, 'Tab', 'android');
    delete process.env.DEVICE_SYNC_ENABLED;
    await expect(guard.canActivate(ctxWithBearer(dev.token))).rejects.toThrow(/Not authenticated/);
    process.env.DEVICE_SYNC_ENABLED = 'true';
    const req = { cookies: {}, headers: { authorization: `Bearer ${dev.token}` } } as Record<string, unknown>;
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    expect(await guard.canActivate(ctx)).toBe(true);
    expect((req.user as { id: string }).id).toBe(userA);
    expect(req.deviceId).toBe(dev.id);
    // revoked device is rejected even with the flag on
    await auth.revokeDevice(userA, dev.id);
    await expect(guard.canActivate(ctxWithBearer(dev.token))).rejects.toThrow(/revoked/i);
  });

  it('sync snapshot is consistent + minimal (no prompts/secrets)', async () => {
    const snap = await tenantContext.run({ workspaceId: wsId }, () => sync.snapshot(wsId, userA));
    expect(snap.tasks.length).toBeGreaterThanOrEqual(1);
    expect(snap.tasks[0]).toHaveProperty('status');
    expect(JSON.stringify(snap)).not.toContain('secret prompt body'); // prompt never in the snapshot
    expect(Array.isArray(snap.approvals)).toBe(true);
    expect(Array.isArray(snap.artifacts)).toBe(true);
    expect(typeof snap.unreadNotifications).toBe('number');
  });
});
