import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantContext, TaskStatus } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { TaskControlBus } from '../tasks/task-control-bus';
import { TasksService } from '../tasks/tasks.service';
import { PolicyService } from '../policy/policy.service';
import { CodingWorkspaceService } from '../coding/coding.service';

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

function makeTasksService(prisma: unknown): TasksService {
  type Args = ConstructorParameters<typeof TasksService>;
  return new TasksService(
    prisma as Args[0], new AuditService(prisma as never), null as never, null as never, null as never,
    new TaskControlBus(null), null, null as never, null as never, null as never, null as never,
    null as never, null as never, null as never, null as never, new PolicyService(), new CodingWorkspaceService(), null as never, null as never,
  );
}

/** TICKET-6: a device-originated approval decision records the deviceId (structural only) in the audit
 * — never the prompt/args/secret/token. */
suite('Mobile control — per-device approval audit (TICKET-6, live Postgres)', () => {
  const prisma = getPrisma();
  const svc = makeTasksService(prisma);
  const sfx = Date.now().toString(36);
  let userId = '';
  let wsId = '';
  let taskId = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `mc-${sfx}@t.local`, displayName: 'M' } });
    userId = u.id;
    wsId = (await prisma.workspace.create({ data: { name: 'MC', slug: `mc-${sfx}`, ownerUserId: u.id } })).id;
    taskId = (await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: userId, title: 'T', prompt: 'sensitive prompt body', status: TaskStatus.running } })).id;
  });
  afterAll(async () => {
    if (wsId) await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  async function pendingApproval(approvalId: string) {
    await prisma.approval.create({ data: { taskId, workspaceId: wsId, approvalId, action: 'shell_exec', risk: 'high', status: 'pending' } });
  }

  it('records deviceId in the approval audit (no prompt/secret/full payload)', async () => {
    await pendingApproval('a-dev');
    await svc.decideApproval(wsId, taskId, 'a-dev', 'approve', userId, undefined, 'device-abc123');
    const row = await prisma.auditLog.findFirst({ where: { workspaceId: wsId, action: 'task.approve', targetId: 'a-dev' } });
    expect(row).not.toBeNull();
    expect((row?.metadata as { deviceId?: string })?.deviceId).toBe('device-abc123');
    const meta = JSON.stringify(row?.metadata ?? {});
    expect(meta).not.toContain('sensitive prompt body'); // no prompt/full payload
    expect(Object.keys((row?.metadata as object) ?? {})).toEqual(['deviceId']); // structural only
  });

  it('omits deviceId for a cookie-session decision (additive, backward-compatible)', async () => {
    await pendingApproval('a-web');
    await svc.decideApproval(wsId, taskId, 'a-web', 'deny', userId);
    const row = await prisma.auditLog.findFirst({ where: { workspaceId: wsId, action: 'task.deny', targetId: 'a-web' } });
    expect(row).not.toBeNull();
    expect(row?.metadata ?? null).toBeNull();
  });
});
