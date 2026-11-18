import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, tenantContext, TaskStatus } from '@agentos/db';
import { TaskRunner } from './task-runner';

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
type SideEffect = { applySideEffect(task: { id: string; workspaceId: string }, event: unknown): Promise<void> };

suite('Tool version trace persistence (TICKET-2, live Postgres)', () => {
  const prisma = getPrisma();
  const runner = new TaskRunner(prisma as never) as unknown as SideEffect;
  const sfx = Date.now().toString(36);
  let userId = '';
  let wsId = '';
  let taskId = '';

  beforeAll(async () => {
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `tv-${sfx}@t.local`, displayName: 'T' } });
    userId = u.id;
    wsId = (await prisma.workspace.create({ data: { name: 'TV', slug: `tv-${sfx}`, ownerUserId: u.id } })).id;
    taskId = (await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: userId, title: 't', prompt: 'x', status: TaskStatus.running } })).id;
  });
  afterAll(async () => {
    if (wsId) await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('persists toolVersion from the tool_call event into the trace', async () => {
    await runner.applySideEffect({ id: taskId, workspaceId: wsId }, { type: 'tool_call', callId: 'v1', tool: 'probe', riskLevel: 'low', input: { x: 1 }, toolVersion: '2' });
    const row = await prisma.toolCall.findFirst({ where: { taskId, callId: 'v1' } });
    expect(row?.toolVersion).toBe('2');
  });

  it('leaves toolVersion null when the event carries none (additive, backward-compatible)', async () => {
    await runner.applySideEffect({ id: taskId, workspaceId: wsId }, { type: 'tool_call', callId: 'v2', tool: 'probe', riskLevel: 'low', input: { x: 1 } });
    const row = await prisma.toolCall.findFirst({ where: { taskId, callId: 'v2' } });
    expect(row?.toolVersion ?? null).toBeNull();
  });
});
