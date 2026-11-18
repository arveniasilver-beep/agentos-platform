import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getPrisma, disconnectPrisma, TaskStatus, type Task } from '@agentos/db';

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

suite('Library: cross-task artifact aggregation (live Postgres + sandbox files)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let sandboxRoot = '';
  let userId = '';
  let workspaceId = '';

  beforeAll(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), 'lib-'));
    process.env.AGENT_SANDBOX_ROOT = sandboxRoot;
  });
  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
    await disconnectPrisma();
  });

  it('aggregates artifacts across tasks, tagged with their task', async () => {
    // Imported AFTER AGENT_SANDBOX_ROOT is set so the service picks up the temp base.
    const { ArtifactsService } = await import('./artifacts.service');
    const { StorageService } = await import('../storage/storage.service');
    const service = new ArtifactsService(prisma as never, new StorageService());

    const user = await prisma.user.create({ data: { email: `lib-${suffix}@t.local`, displayName: 'L' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'LIB', slug: `lib-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;
    const t1 = (await prisma.task.create({
      data: { workspaceId: ws.id, createdByUserId: user.id, title: 'Deck task', prompt: 'p', status: TaskStatus.completed },
    })) as Task;
    const t2 = (await prisma.task.create({
      data: { workspaceId: ws.id, createdByUserId: user.id, title: 'Sheet task', prompt: 'p', status: TaskStatus.completed },
    })) as Task;

    // Write deliverables into each task's sandbox dir.
    const write = (taskId: string, rel: string, content: string) => {
      const full = join(sandboxRoot, taskId, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    };
    write(t1.id, 'deliverables/slides.html', '<!doctype html><title>Deck</title>');
    write(t2.id, 'deliverables/data.csv', 'a,b\n1,2\n');

    const { items, truncated } = await service.listAll(ws.id);
    expect(truncated).toBe(false);
    const paths = items.map((i) => `${i.taskTitle}:${i.path}`).sort();
    expect(paths).toEqual(['Deck task:deliverables/slides.html', 'Sheet task:deliverables/data.csv']);
    // Each item is tagged with a real taskId from this workspace.
    expect(items.every((i) => i.taskId === t1.id || i.taskId === t2.id)).toBe(true);
  });
});
