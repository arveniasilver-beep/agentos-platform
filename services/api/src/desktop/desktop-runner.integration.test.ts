import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, makeRlsClient, tenantContext, type PrismaClient } from '@agentos/db';
import { loadServerEnv } from '@agentos/config';
import { AuditService } from '../audit/audit.service';
import { DesktopRunnerService } from './desktop-runner.service';

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
const SECRET_ROOT = 'C:/SECRET-ROOT-DONOTLEAK/projects';
const SECRET_CONTENT = 'TOKEN=sk-ant-LOCALSECRET-NOLEAK';

suite('Desktop Runner Foundation (TICKET-7, live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  const svc = new DesktopRunnerService(prisma as never, audit);
  const sfx = Date.now().toString(36);
  let userId = '';
  let deviceId = '';
  let wsA = '';
  let wsB = '';
  let folderId = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `dr-${sfx}@t.local`, displayName: 'D' } });
    userId = u.id;
    deviceId = (await prisma.device.create({ data: { userId, name: 'My PC', platform: 'desktop', tokenHash: `h-${sfx}` } })).id;
    wsA = (await prisma.workspace.create({ data: { name: 'A', slug: `dr-a-${sfx}`, ownerUserId: userId } })).id;
    wsB = (await prisma.workspace.create({ data: { name: 'B', slug: `dr-b-${sfx}`, ownerUserId: userId } })).id;
    folderId = (await prisma.localFolder.create({ data: { workspaceId: wsA, label: 'projects', path: SECRET_ROOT, writable: true, createdByUserId: userId } })).id;
  });
  afterAll(async () => {
    for (const w of [wsA, wsB]) if (w) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('register + heartbeat work for a live device; register requires a device session', async () => {
    await expect(svc.register(wsA, undefined, {})).rejects.toThrow(/device session/i);
    const r = await svc.register(wsA, deviceId, { version: '1.0.0', capabilities: { localFs: true, shellExec: true } });
    expect(r.deviceId).toBe(deviceId);
    expect(r.status).toBe('active');
    // No-host-exec defense: a client-claimed shellExec:true is forced to false server-side.
    expect((r.capabilities as { shellExec?: boolean }).shellExec).toBe(false);
    const before = r.lastHeartbeatAt.getTime();
    await new Promise((res) => setTimeout(res, 5));
    const hb = await svc.heartbeat(wsA, deviceId);
    expect(hb.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(before);
    const aud = await prisma.auditLog.findFirst({ where: { workspaceId: wsA, action: 'desktop_runner.registered', targetId: r.id } });
    expect(aud).not.toBeNull();
  });

  it('local-action audit is content-free, full-path-free, and attributes the device/runner', async () => {
    const runner = await svc.register(wsA, deviceId, {});
    await svc.recordLocalAction(wsA, { folderLabel: 'projects', relativePath: 'sub/config.env', action: 'read', risk: 'medium' });
    const row = await prisma.auditLog.findFirst({ where: { workspaceId: wsA, action: 'local.read' }, orderBy: { createdAt: 'desc' } });
    expect(row).not.toBeNull();
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.deviceId).toBe(deviceId);
    expect(meta.desktopRunnerId).toBe(runner.id);
    expect(meta.localFolderId).toBe(folderId);
    expect(meta.relativePath).toBe('sub/config.env');
    expect(typeof meta.pathHash).toBe('string');
    const blob = JSON.stringify(row?.metadata ?? {});
    expect(blob).not.toContain(SECRET_ROOT); // full absolute host path never stored
    expect(blob).not.toContain('SECRET-ROOT'); // not even a fragment of it
    expect(blob).not.toContain(SECRET_CONTENT); // file content/secret never stored
  });

  it('audited relativePath is always clean: drops drive letters AND ../ traversal segments', async () => {
    await svc.recordLocalAction(wsA, { folderLabel: 'projects', relativePath: 'C:/Windows/System32/x', action: 'read' });
    let row = await prisma.auditLog.findFirst({ where: { workspaceId: wsA, action: 'local.read' }, orderBy: { createdAt: 'desc' } });
    expect(String((row?.metadata as Record<string, unknown>).relativePath)).toBe('Windows/System32/x');

    await svc.recordLocalAction(wsA, { folderLabel: 'projects', relativePath: '../../etc/passwd', action: 'read' });
    row = await prisma.auditLog.findFirst({ where: { workspaceId: wsA, action: 'local.read' }, orderBy: { createdAt: 'desc' } });
    const rel = String((row?.metadata as Record<string, unknown>).relativePath);
    expect(rel).toBe('etc/passwd'); // .. segments dropped
    expect(rel).not.toContain('..');
    expect(rel).not.toMatch(/^[A-Za-z]:/);
  });

  it('fails closed once the device is revoked (register + heartbeat)', async () => {
    await prisma.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
    await expect(svc.register(wsA, deviceId, {})).rejects.toThrow(/revoked/i);
    await expect(svc.heartbeat(wsA, deviceId)).rejects.toThrow(/revoked/i);
    // a revoked device is no longer the active runner => local-action audit no longer attributes to it
    await svc.recordLocalAction(wsA, { folderLabel: 'projects', relativePath: 'after-revoke.txt', action: 'read' });
    const row = await prisma.auditLog.findFirst({ where: { workspaceId: wsA, action: 'local.read' }, orderBy: { createdAt: 'desc' } });
    expect((row?.metadata as Record<string, unknown>).desktopRunnerId).toBeNull();
    await prisma.device.update({ where: { id: deviceId }, data: { revokedAt: null } }); // restore for other tests
  });

  it('runtime-role DB-level RLS: agentos_app cannot read another workspace runner', async () => {
    const runner = await svc.register(wsA, deviceId, {});
    let app: PrismaClient | undefined;
    try {
      const u = new URL(process.env.DATABASE_URL as string);
      u.username = 'agentos_app';
      u.password = 'agentos_app';
      app = makeRlsClient(u.toString());
      await app.$connect();
    } catch {
      console.warn('desktop rls: agentos_app role unavailable, skipping the DB-level assertion');
      return;
    }
    const client = app;
    try {
      await tenantContext.run({ workspaceId: wsB }, async () => {
        expect(await client.desktopRunner.findUnique({ where: { id: runner.id } })).toBeNull();
      });
      await tenantContext.run({ workspaceId: wsA }, async () => {
        expect((await client.desktopRunner.findUnique({ where: { id: runner.id } }))?.id).toBe(runner.id);
      });
    } finally {
      await app.$disconnect().catch(() => undefined);
    }
  });

  it('flag DESKTOP_RUNNER_ENABLED defaults false', () => {
    const prev = process.env.DESKTOP_RUNNER_ENABLED;
    delete process.env.DESKTOP_RUNNER_ENABLED;
    try {
      expect(loadServerEnv().DESKTOP_RUNNER_ENABLED).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DESKTOP_RUNNER_ENABLED = prev;
    }
  });
});
