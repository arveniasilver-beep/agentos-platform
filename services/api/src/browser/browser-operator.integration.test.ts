import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, makeRlsClient, tenantContext, TaskStatus, type PrismaClient } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { BrowserOperatorService } from './browser-operator.service';
import { TaskRunner } from '../tasks/task-runner';

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
const SECRET = 'sk-ant-BROWSERSECRET-NOLEAK-5522';

// applySideEffect is private; drive it directly with synthetic engine events (no Playwright needed).
type SideEffect = { applySideEffect(task: { id: string; workspaceId: string }, event: unknown): Promise<void> };

suite('BrowserOperatorService + task-runner browser sink (live Postgres)', () => {
  const prisma = getPrisma();
  const audit = new AuditService(prisma as never);
  const op = new BrowserOperatorService(prisma as never, audit);
  const runner = new TaskRunner(prisma as never) as unknown as SideEffect & object;
  const sfx = Date.now().toString(36);
  let userId = '';
  let wsA = '';
  let wsB = '';
  let taskA = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `bro-${sfx}@t.local`, displayName: 'B' } });
    userId = u.id;
    wsA = (await prisma.workspace.create({ data: { name: 'A', slug: `bro-a-${sfx}`, ownerUserId: u.id } })).id;
    wsB = (await prisma.workspace.create({ data: { name: 'B', slug: `bro-b-${sfx}`, ownerUserId: u.id } })).id;
    taskA = (await prisma.task.create({ data: { workspaceId: wsA, createdByUserId: userId, title: 't', prompt: 'x', status: TaskStatus.running } })).id;
  });
  afterAll(async () => {
    delete process.env.BROWSER_OPERATOR_ENABLED;
    delete process.env.BROWSER_URL_DENYLIST;
    delete process.env.BROWSER_URL_ALLOWLIST;
    for (const w of [wsA, wsB]) if (w) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('onAction records a sanitized session+action+audit with no secret/cookie/token', async () => {
    await op.onAction({ workspaceId: wsA, taskId: taskA, callId: 'a1', tool: 'browser_navigate', url: `https://shop.example.com/checkout?token=${SECRET}` });
    const s = (await op.listSessions(wsA))[0]!;
    expect(s.lastUrl).toContain('shop.example.com');
    expect(s.lastUrl).not.toContain(SECRET); // query (token) redacted
    expect(s.actionCount).toBeGreaterThanOrEqual(1);
    const actions = await op.listActions(wsA, s.id);
    expect(actions[0]!.url).not.toContain(SECRET);
    const aud = await prisma.auditLog.findFirst({ where: { workspaceId: wsA, action: 'browser.navigate' } });
    expect(aud).not.toBeNull();
    expect(JSON.stringify(aud?.metadata ?? {})).not.toContain(SECRET); // audit never carries the token
  });

  it('payment/account mutation is recorded as critical+elevated; onResult marks denied', async () => {
    await op.onAction({ workspaceId: wsA, taskId: taskA, callId: 'd1', tool: 'browser_type', url: 'https://bank.example.com/login', target: 'password', submit: true });
    const s = (await op.listSessions(wsA))[0]!;
    const act = (await op.listActions(wsA, s.id)).find((a) => a.callId === 'd1');
    expect(act?.risk).toBe('critical');
    expect(act?.outcome).toBe('awaiting_approval');
    await op.onResult({ workspaceId: wsA, callId: 'd1', ok: false, error: 'denied by user' });
    const act2 = (await op.listActions(wsA, s.id)).find((a) => a.callId === 'd1');
    expect(act2?.outcome).toBe('denied');
    const s2 = await op.getSession(wsA, s.id);
    expect(s2?.deniedCount).toBeGreaterThanOrEqual(1);
  });

  it('task-runner browser sink: flag ON records a browser_action, flag OFF is inert', async () => {
    const tc = (callId: string, url: string) => ({ type: 'tool_call', callId, tool: 'browser_navigate', riskLevel: 'low', input: { url } });
    process.env.BROWSER_OPERATOR_ENABLED = 'true';
    await runner.applySideEffect({ id: taskA, workspaceId: wsA }, tc('on1', 'https://example.com/a'));
    expect((await prisma.browserAction.findMany({ where: { workspaceId: wsA, callId: 'on1' } })).length).toBe(1);
    delete process.env.BROWSER_OPERATOR_ENABLED;
    await runner.applySideEffect({ id: taskA, workspaceId: wsA }, tc('off1', 'https://example.com/b'));
    expect((await prisma.browserAction.findMany({ where: { workspaceId: wsA, callId: 'off1' } })).length).toBe(0);
  });

  it('evaluateUrl honors BROWSER_URL_DENYLIST / ALLOWLIST', () => {
    process.env.BROWSER_URL_DENYLIST = 'evil.com';
    expect(op.evaluateUrl('https://evil.com/x').effect).toBe('deny');
    expect(op.evaluateUrl('https://sub.evil.com/x').effect).toBe('deny');
    expect(op.evaluateUrl('https://good.com/x').effect).toBe('allow');
    delete process.env.BROWSER_URL_DENYLIST;
    process.env.BROWSER_URL_ALLOWLIST = 'only.com';
    expect(op.evaluateUrl('https://only.com/x').effect).toBe('allow');
    expect(op.evaluateUrl('https://other.com/x').effect).toBe('deny');
    delete process.env.BROWSER_URL_ALLOWLIST;
  });

  it('runtime-role DB-level RLS: agentos_app cannot read another workspace browser sessions', async () => {
    const s = (await op.listSessions(wsA))[0]!;
    let app: PrismaClient | undefined;
    try {
      const u = new URL(process.env.DATABASE_URL as string);
      u.username = 'agentos_app';
      u.password = 'agentos_app';
      app = makeRlsClient(u.toString());
      await app.$connect();
    } catch {
      console.warn('browser rls: agentos_app role unavailable, skipping the DB-level assertion');
      return;
    }
    const client = app;
    try {
      await tenantContext.run({ workspaceId: wsB }, async () => {
        expect(await client.browserSession.findUnique({ where: { id: s.id } })).toBeNull();
      });
      await tenantContext.run({ workspaceId: wsA }, async () => {
        expect((await client.browserSession.findUnique({ where: { id: s.id } }))?.id).toBe(s.id);
      });
    } finally {
      await app.$disconnect().catch(() => undefined);
    }
  });
});
