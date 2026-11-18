import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Point the sandbox root at a throwaway dir BEFORE importing anything that reads env.
const SANDBOX_ROOT = mkdtempSync(join(tmpdir(), 'aos-artifacts-'));
process.env.AGENT_SANDBOX_ROOT = SANDBOX_ROOT;

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const envPath = resolve(process.cwd(), rel);
    if (existsSync(envPath)) {
      const match = readFileSync(envPath, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (match?.[1]) {
        process.env.DATABASE_URL = match[1];
        break;
      }
    }
  }
}

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite('ArtifactsService (live Postgres + sandbox dir)', () => {
  let getPrisma: typeof import('@agentos/db').getPrisma;
  let disconnectPrisma: typeof import('@agentos/db').disconnectPrisma;
  let ArtifactsService: typeof import('./artifacts.service').ArtifactsService;
  let StorageService: typeof import('../storage/storage.service').StorageService;
  let prisma: import('@agentos/db').PrismaClient;
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';
  let otherWorkspaceId = '';
  let taskId = '';

  beforeAll(async () => {
    ({ getPrisma, disconnectPrisma } = await import('@agentos/db'));
    ({ ArtifactsService } = await import('./artifacts.service'));
    ({ StorageService } = await import('../storage/storage.service'));
    prisma = getPrisma();
  });

  afterAll(async () => {
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  });

  it('lists, reads, blocks traversal, and enforces tenancy', async () => {
    const user = await prisma.user.create({
      data: { email: `artif-${suffix}@test.local`, displayName: 'Artifact User' },
    });
    userId = user.id;
    const ws = await prisma.workspace.create({
      data: { name: 'Artifact WS', slug: `artif-${suffix}`, ownerUserId: user.id },
    });
    workspaceId = ws.id;
    const other = await prisma.workspace.create({
      data: { name: 'Other WS', slug: `artif-other-${suffix}`, ownerUserId: user.id },
    });
    otherWorkspaceId = other.id;
    const task = await prisma.task.create({
      data: { workspaceId: ws.id, createdByUserId: user.id, title: 'T', prompt: 'p' },
    });
    taskId = task.id;

    // The agent's sandbox dir for this task, with a file + a nested file.
    const dir = join(SANDBOX_ROOT, taskId);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'report.txt'), 'the answer is 42', 'utf8');
    writeFileSync(join(dir, 'sub', 'data.json'), '{"ok":true}', 'utf8');

    // getPrisma() returns a PrismaClient; the service is typed against the Nest PrismaService
    // subclass (identical at runtime). Cast to the constructor's expected type.
    const service = new ArtifactsService(
      prisma as unknown as ConstructorParameters<typeof ArtifactsService>[0],
      new StorageService(),
    );

    const list = await service.list(workspaceId, taskId);
    const paths = list.map((a) => a.path).sort();
    expect(paths).toEqual(['report.txt', 'sub/data.json']);
    expect(list.find((a) => a.path === 'report.txt')?.size).toBe('the answer is 42'.length);

    const file = await service.read(workspaceId, taskId, 'report.txt');
    expect(file.data.toString('utf8')).toBe('the answer is 42');
    expect(file.contentType).toContain('text/plain');

    // Path traversal is refused.
    await expect(service.read(workspaceId, taskId, '../../../etc/passwd')).rejects.toThrow();

    // Tenancy: the task does not belong to the other workspace.
    await expect(service.list(otherWorkspaceId, taskId)).rejects.toThrow();
  });
});
