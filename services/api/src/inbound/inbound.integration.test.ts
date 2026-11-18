import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, TaskStatus } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { InboundService } from './inbound.service';

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) {
        process.env.DATABASE_URL = m[1];
        break;
      }
    }
  }
}
const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite('Mail-to-task inbound (live Postgres, stub task runner)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';

  // Stub the task runner: just persist a task row (don't run the engine).
  const tasksStub = {
    createAndStart: async (
      ws: string,
      uid: string,
      dto: { title: string; prompt: string; riskCeiling: string; costBudgetUsd?: number },
    ) =>
      prisma.task.create({
        data: {
          workspaceId: ws,
          createdByUserId: uid,
          title: dto.title,
          prompt: dto.prompt,
          riskCeiling: dto.riskCeiling as never,
          ...(dto.costBudgetUsd !== undefined ? { costBudgetUsd: dto.costBudgetUsd } : {}),
          status: TaskStatus.pending,
        },
      }),
  };
  const inbound = new InboundService(prisma as never, new AuditService(prisma as never), tasksStub as never);

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('creates a task from an email, honoring enable + sender allowlist', async () => {
    const user = await prisma.user.create({ data: { email: `in-${suffix}@t.local`, displayName: 'I' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'IN', slug: `in-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    const cfg = await inbound.ensure(ws.id, user.id);
    expect(cfg.token).toBeTruthy();
    expect(cfg.enabled).toBe(true);

    // A normal inbound email creates a pending task with the subject as title.
    const { taskId } = await inbound.handleInbound(cfg.token, {
      from: 'Alice <alice@example.com>',
      subject: 'Summarize Q3',
      text: 'Please summarize the attached numbers.',
    });
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    expect(task?.title).toBe('Summarize Q3');
    expect(task?.prompt).toContain('Please summarize');
    expect(task?.status).toBe(TaskStatus.pending);

    // Email tasks default to a LOW risk ceiling + a cost cap (untrusted content must not auto-run
    // risky tools), and the prompt labels the email as untrusted data.
    expect(cfg.taskRiskCeiling).toBe('low');
    expect(task?.riskCeiling).toBe('low');
    expect(task?.prompt).toContain('UNTRUSTED DATA');
    expect(task?.costBudgetUsd).not.toBeNull();

    // Empty email (no subject + no body) is rejected.
    await expect(inbound.handleInbound(cfg.token, { from: 'a@b.com' })).rejects.toThrow(/Empty email/);
    // Missing sender is rejected.
    await expect(inbound.handleInbound(cfg.token, { from: '', subject: 'x' })).rejects.toThrow(/Missing sender/);

    // Unknown token is rejected.
    await expect(inbound.handleInbound('nope', { from: 'a@b.com', subject: 'x' })).rejects.toThrow(/Unknown or disabled/);

    // Disabled address is rejected.
    await inbound.update(ws.id, user.id, { enabled: false });
    await expect(inbound.handleInbound(cfg.token, { from: 'a@b.com', subject: 'x' })).rejects.toThrow(/Unknown or disabled/);

    // Re-enable with a sender allowlist: disallowed sender rejected, allowed (case-insensitive) accepted.
    await inbound.update(ws.id, user.id, { enabled: true, allowedSenders: ['ok@example.com'] });
    await expect(inbound.handleInbound(cfg.token, { from: 'evil@example.com', subject: 'x' })).rejects.toThrow(/not allowed/);
    const ok = await inbound.handleInbound(cfg.token, { from: 'Boss <OK@example.com>', subject: 'go' });
    expect((await prisma.task.findUnique({ where: { id: ok.taskId } }))?.title).toBe('go');

    // Regenerate rotates the token (the old one stops working).
    const rotated = await inbound.regenerate(ws.id, user.id);
    expect(rotated.token).not.toBe(cfg.token);
    await expect(inbound.handleInbound(cfg.token, { from: 'OK@example.com', subject: 'x' })).rejects.toThrow(/Unknown or disabled/);
  });
});
