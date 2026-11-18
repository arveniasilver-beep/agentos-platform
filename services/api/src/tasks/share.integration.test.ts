import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, TaskStatus, type Task } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { TaskControlBus } from './task-control-bus';
import { TasksService } from './tasks.service';

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
type Args = ConstructorParameters<typeof TasksService>;

suite('Task public share/replay (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';

  const service = new TasksService(
    prisma as Args[0],
    new AuditService(prisma as never),
    null as never,
    null as never,
    null as never,
    new TaskControlBus(null),
    null,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('shares a run, replays its events by token, then revokes', async () => {
    const user = await prisma.user.create({ data: { email: `sh-${suffix}@t.local`, displayName: 'S' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'S', slug: `sh-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;
    const task = (await prisma.task.create({
      data: { workspaceId: ws.id, createdByUserId: user.id, title: 'Shared', prompt: 'p', status: TaskStatus.completed },
    })) as Task;
    await prisma.taskLog.create({
      data: { taskId: task.id, workspaceId: ws.id, seq: 0, type: 'plan', payload: { type: 'plan', summary: 'do it' } },
    });
    await prisma.taskLog.create({
      data: {
        taskId: task.id,
        workspaceId: ws.id,
        seq: 1,
        type: 'tool_result',
        payload: { type: 'tool_result', callId: 'c0', ok: true, output: { secret: 'SENSITIVE-FILE-CONTENTS' } },
      },
    });
    await prisma.taskLog.create({
      data: {
        taskId: task.id,
        workspaceId: ws.id,
        seq: 2,
        type: 'final_output',
        payload: { type: 'final_output', summary: 'done' },
      },
    });

    const { shareId } = await service.share(ws.id, task.id, user.id);
    expect(typeof shareId).toBe('string');
    // sharing twice is idempotent (same token)
    expect((await service.share(ws.id, task.id, user.id)).shareId).toBe(shareId);

    const replay = await service.getSharedReplay(shareId);
    expect(replay.title).toBe('Shared');
    expect(replay.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    // The tool_result's raw output must be redacted on the public path (no sensitive payload leak).
    const toolResult = replay.events.find((e) => e.type === 'tool_result');
    expect(JSON.stringify(toolResult?.payload)).not.toContain('SENSITIVE-FILE-CONTENTS');
    expect((toolResult?.payload as { output?: unknown }).output).toBeUndefined();

    await service.unshare(ws.id, task.id, user.id);
    await expect(service.getSharedReplay(shareId)).rejects.toThrow();
  });
});
