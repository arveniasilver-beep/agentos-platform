import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { RoutingProvider } from '@agentos/llm';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { SecretsService } from './secrets.service';
import { RouteProviderController } from './settings.controller';
import { LlmProviderFactory } from '../tasks/llm-provider.factory';

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

suite('Model Router factory selection (TICKET-10, live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const secrets = new SecretsService(prisma as never, new CryptoService(), new AuditService(prisma as never));
  const factory = new LlmProviderFactory(secrets);
  const prevMode = process.env.LLM_MODE;
  const prevFlag = process.env.MODEL_ROUTER_ENABLED;
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (prevMode === undefined) delete process.env.LLM_MODE; else process.env.LLM_MODE = prevMode;
    if (prevFlag === undefined) delete process.env.MODEL_ROUTER_ENABLED; else process.env.MODEL_ROUTER_ENABLED = prevFlag;
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('builds a RoutingProvider when MODEL_ROUTER_ENABLED + a valid route config; ignores it when flag off', async () => {
    process.env.LLM_MODE = 'live';
    const user = await prisma.user.create({ data: { email: `mr-${suffix}@t.local`, displayName: 'M' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'MR', slug: `mr-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    // Store a route config: a cheap default + a reasoning profile for high effort, fast as fallback.
    const info = await secrets.setModelRouteConfig(ws.id, user.id, {
      profiles: {
        fast: { provider: 'anthropic', apiKey: 'sk-ant-fast', model: 'claude-haiku-4-5-20251001' },
        smart: { provider: 'anthropic', apiKey: 'sk-ant-smart', model: 'claude-opus-4-8' },
      },
      routes: [{ effortAtLeast: 'high', profile: 'smart' }],
      fallback: ['fast'],
      default: 'fast',
    });
    expect(info.configured).toBe(true);
    expect(info.lastFour).toBeNull(); // no TOP-LEVEL apiKey -> nothing masked/leaked at the route level

    // Flag OFF: the router is ignored. With no chat config / llm key, forWorkspace fails closed.
    delete process.env.MODEL_ROUTER_ENABLED;
    await expect(factory.forWorkspace(ws.id)).rejects.toThrow(/No model provider/);

    // Flag ON: forWorkspace builds a RoutingProvider; default selection is the cheap profile's model.
    process.env.MODEL_ROUTER_ENABLED = 'true';
    await expect(factory.ensureConfigured(ws.id)).resolves.toBeUndefined();
    const provider = await factory.forWorkspace(ws.id);
    expect(provider).toBeInstanceOf(RoutingProvider);
    expect(provider.model).toBe('claude-haiku-4-5-20251001'); // default 'fast'

    // The encrypted config round-trips server-side (profile keys present); info never exposes a key.
    const stored = await secrets.getModelRouteConfig(ws.id);
    expect(stored?.profiles.smart?.apiKey).toBe('sk-ant-smart');
    expect(JSON.stringify(info)).not.toContain('sk-ant');
  });

  it('the RouteProviderController is a real write path: stores via PUT, then the factory routes', async () => {
    process.env.LLM_MODE = 'live';
    process.env.MODEL_ROUTER_ENABLED = 'true';
    const ctrl = new RouteProviderController(secrets);
    const ws = await prisma.workspace.create({ data: { name: 'MR3', slug: `mr3-${suffix}`, ownerUserId: userId } });
    const user = { id: userId } as never;
    try {
      // Write-time validation: a route referencing an unknown profile is rejected at PUT (not run time).
      await expect(
        ctrl.set(ws.id, user, { profiles: { only: { provider: 'anthropic', apiKey: 'k' } }, routes: [{ profile: 'ghost' }], fallback: [] } as never),
      ).rejects.toThrow(/route config is invalid/i);

      // A valid config stores, the GET reports configured, and forWorkspace now builds a real router.
      const info = await ctrl.set(ws.id, user, {
        profiles: { fast: { provider: 'anthropic', apiKey: 'sk-ant-f', model: 'claude-haiku-4-5-20251001' } },
        routes: [],
        fallback: [],
        default: 'fast',
      } as never);
      expect(info.configured).toBe(true);
      expect((await ctrl.get(ws.id)).configured).toBe(true);
      expect((await factory.forWorkspace(ws.id)).model).toBe('claude-haiku-4-5-20251001');

      // DELETE removes it -> factory falls through (no other brain here -> fails closed).
      await ctrl.remove(ws.id, user);
      await expect(factory.forWorkspace(ws.id)).rejects.toThrow(/No model provider/);
    } finally {
      await prisma.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });

  it('a stored-but-invalid route config fails fast at the pre-run gate', async () => {
    process.env.LLM_MODE = 'live';
    process.env.MODEL_ROUTER_ENABLED = 'true';
    const ws = await prisma.workspace.create({ data: { name: 'MR2', slug: `mr2-${suffix}`, ownerUserId: userId } });
    try {
      // route references a profile that doesn't exist -> validateRouteConfig rejects -> 400.
      await secrets.setModelRouteConfig(ws.id, userId, {
        profiles: { only: { provider: 'anthropic', apiKey: 'k' } },
        routes: [{ profile: 'ghost' }],
        fallback: [],
      } as never);
      await expect(factory.ensureConfigured(ws.id)).rejects.toThrow(/route config is invalid/i);
    } finally {
      await prisma.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    }
  });
});
