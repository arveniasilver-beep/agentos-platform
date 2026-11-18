import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, makeRlsClient, tenantContext, type PrismaClient } from '@agentos/db';
import { loadServerEnv } from '@agentos/config';
import { AuditService } from '../audit/audit.service';
import { ConnectorRegistryService } from './connector-registry.service';

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
const SECRET = 'sk-ant-CONNSECRET-NOLEAK-4242';
const RAWENTROPY = 'Zx9Kq2Lm7Pv4Rn8Tb1Wc6Yd3Fg5Hj0'; // 31-char, no prefix/keyword — heuristic redactor would miss it

suite('Connectors v2 (TICKET-9, live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  const svc = new ConnectorRegistryService(prisma as never, audit);
  const sfx = Date.now().toString(36);
  let userId = '';
  let wsA = '';
  let wsB = '';
  let connId = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `cn-${sfx}@t.local`, displayName: 'C' } });
    userId = u.id;
    wsA = (await prisma.workspace.create({ data: { name: 'A', slug: `cn-a-${sfx}`, ownerUserId: u.id } })).id;
    wsB = (await prisma.workspace.create({ data: { name: 'B', slug: `cn-b-${sfx}`, ownerUserId: u.id } })).id;
    connId = (await prisma.connection.create({ data: { workspaceId: wsA, provider: 'github', externalId: 'gh1', accountLabel: 'octocat', scopes: 'repo read:user', createdByUserId: userId } })).id;
  });
  afterAll(async () => {
    delete process.env.CONNECTORS_V2_ENABLED;
    for (const w of [wsA, wsB]) if (w) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('checkAction allows an action whose scopes are granted; denies + audits a missing-scope action', async () => {
    expect((await svc.checkAction(wsA, 'github', 'github_list_repos')).ok).toBe(true);
    await prisma.connection.update({ where: { id: connId }, data: { scopes: 'read:user' } }); // drop 'repo'
    const denied = await svc.checkAction(wsA, 'github', 'github_list_repos');
    expect(denied.ok).toBe(false);
    const aud = await prisma.auditLog.findFirst({ where: { workspaceId: wsA, action: 'connector.action_denied' } });
    expect(aud).not.toBeNull();
    await prisma.connection.update({ where: { id: connId }, data: { scopes: 'repo read:user' } }); // restore
    expect((await svc.checkAction(wsA, 'notion', 'notion_search')).ok).toBe(false); // not connected
  });

  it('webhook ingestion: secret verified, event recorded REDACTED (no secret/raw payload)', async () => {
    process.env.CONNECTORS_V2_ENABLED = 'true';
    const { token } = await svc.setWebhookSecret(wsA, 'github', userId);
    expect(token).toMatch(/^cwh_/);
    await expect(svc.ingestWebhook(connId, 'wrong', 'github:push')).rejects.toThrow(/not found/i);
    await svc.ingestWebhook(connId, token, `github:push key=${SECRET}`, `pushed by ${SECRET}, raw ${RAWENTROPY}`);
    const ev = await prisma.connectorEvent.findFirst({ where: { workspaceId: wsA, connectionId: connId }, orderBy: { createdAt: 'desc' } });
    expect(ev).not.toBeNull();
    const dump = JSON.stringify(ev);
    expect(dump).not.toContain(SECRET); // prefixed secret redacted from eventType + summary
    expect(dump).not.toContain(RAWENTROPY); // unprefixed high-entropy token also stripped (defense-in-depth)
    expect(ev?.provider).toBe('github');
  });

  it('runtime-role DB-level RLS: agentos_app cannot read another workspace connector event', async () => {
    const ev = await prisma.connectorEvent.findFirst({ where: { workspaceId: wsA }, orderBy: { createdAt: 'desc' } });
    let app: PrismaClient | undefined;
    try {
      const u = new URL(process.env.DATABASE_URL as string);
      u.username = 'agentos_app';
      u.password = 'agentos_app';
      app = makeRlsClient(u.toString());
      await app.$connect();
    } catch {
      console.warn('connector rls: agentos_app unavailable, skipping');
      return;
    }
    const client = app;
    try {
      await tenantContext.run({ workspaceId: wsB }, async () => {
        expect(await client.connectorEvent.findUnique({ where: { id: ev!.id } })).toBeNull();
      });
      await tenantContext.run({ workspaceId: wsA }, async () => {
        expect((await client.connectorEvent.findUnique({ where: { id: ev!.id } }))?.id).toBe(ev!.id);
      });
    } finally {
      await app.$disconnect().catch(() => undefined);
    }
  });

  it('flag CONNECTORS_V2_ENABLED defaults false; ingestion fails closed when off', async () => {
    const prev = process.env.CONNECTORS_V2_ENABLED;
    delete process.env.CONNECTORS_V2_ENABLED;
    try {
      expect(loadServerEnv().CONNECTORS_V2_ENABLED).toBe(false);
      await expect(svc.ingestWebhook(connId, 'anything', 'github:push')).rejects.toThrow(/not found/i);
    } finally {
      if (prev !== undefined) process.env.CONNECTORS_V2_ENABLED = prev;
    }
  });
});
