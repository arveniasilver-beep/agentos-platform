import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, join, dirname } from 'node:path';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { getPrisma, disconnectPrisma, makeRlsClient, tenantContext, TaskStatus, type PrismaClient } from '@agentos/db';
import { MockProvider } from '@agentos/llm';
import { InMemoryToolExecutor, RunController, type InMemoryTool } from '@agentos/agent-engine';

// Temp roots set BEFORE importing services that read env in their constructor.
const SANDBOX = mkdtempSync(join(tmpdir(), 'aos-art-sb-'));
const STORE = mkdtempSync(join(tmpdir(), 'aos-art-store-'));
process.env.AGENT_SANDBOX_ROOT = SANDBOX;
process.env.ARTIFACT_STORE_ROOT = STORE;
delete process.env.S3_ENDPOINT; // force the local durable backend

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

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

suite('Durable Artifact Persistence (live Postgres + blob store)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let ArtifactsService: typeof import('./artifacts.service').ArtifactsService;
  let StorageService: typeof import('../storage/storage.service').StorageService;
  let svc: import('./artifacts.service').ArtifactsService;
  let userId = '';
  let wsId = '';
  const extraWs: string[] = [];
  const prevFlag = process.env.ARTIFACT_PERSISTENCE_ENABLED;

  beforeAll(async () => {
    process.env.ARTIFACT_PERSISTENCE_ENABLED = 'true';
    ({ ArtifactsService } = await import('./artifacts.service'));
    ({ StorageService } = await import('../storage/storage.service'));
    svc = new ArtifactsService(prisma as never, new StorageService());
    const user = await prisma.user.create({ data: { email: `art-${suffix}@t.local`, displayName: 'Art' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'Art WS', slug: `art-${suffix}`, ownerUserId: user.id } });
    wsId = ws.id;
  });

  afterAll(async () => {
    for (const id of [wsId, ...extraWs]) if (id) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    if (prevFlag === undefined) delete process.env.ARTIFACT_PERSISTENCE_ENABLED; else process.env.ARTIFACT_PERSISTENCE_ENABLED = prevFlag;
    rmSync(SANDBOX, { recursive: true, force: true });
    rmSync(STORE, { recursive: true, force: true });
    await disconnectPrisma();
  });

  async function mkTask(status: TaskStatus = TaskStatus.completed): Promise<string> {
    const t = await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: userId, title: 't', prompt: 'p', status } });
    return t.id;
  }
  function writeDeliverable(taskId: string, rel: string, content: string): void {
    const p = join(SANDBOX, taskId, 'deliverables', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }

  it('#1 flag OFF → no Artifact rows / no blobs written (existing behavior preserved)', async () => {
    process.env.ARTIFACT_PERSISTENCE_ENABLED = 'false';
    try {
      const taskId = await mkTask();
      writeDeliverable(taskId, 'report.html', '<h1>x</h1>');
      const ids = await svc.registerFromSandbox(wsId, taskId);
      expect(ids).toEqual([]);
      expect(await prisma.artifact.count({ where: { taskId } })).toBe(0);
    } finally {
      process.env.ARTIFACT_PERSISTENCE_ENABLED = 'true';
    }
  });

  it('#2 registration creates Artifact + ArtifactVersion + blob with sha256/size/mime', async () => {
    const taskId = await mkTask();
    const content = '<h1>Quarterly report</h1>';
    writeDeliverable(taskId, 'report.html', content);
    const ids = await svc.registerFromSandbox(wsId, taskId);
    expect(ids).toHaveLength(1);

    const artifact = await prisma.artifact.findFirstOrThrow({ where: { taskId, name: 'deliverables/report.html' }, include: { versions: true } });
    expect(artifact.kind).toBe('deliverables');
    expect(artifact.versions).toHaveLength(1);
    const v = artifact.versions[0]!;
    expect(v.sha256).toBe(sha(Buffer.from(content)));
    expect(Number(v.sizeBytes)).toBe(Buffer.byteLength(content));
    expect(v.mimeType).toBe('text/html; charset=utf-8');
    expect(artifact.currentVersionId).toBe(v.id);
    // blob exists in the durable store (under the server-derived key) and matches.
    const blob = readFileSync(join(STORE, v.blobKey));
    expect(blob.toString('utf8')).toBe(content);
  });

  it('#4 downloaded bytes match the stored sha256', async () => {
    const taskId = await mkTask();
    const content = 'durable bytes 12345';
    writeDeliverable(taskId, 'data.txt', content);
    const [id] = await svc.registerFromSandbox(wsId, taskId);
    const dl = await svc.downloadById(wsId, id!);
    expect(sha(dl.data)).toBe(sha(Buffer.from(content)));
    const meta = await svc.getMetaById(wsId, id!);
    expect(meta.sha256).toBe(sha(dl.data));
  });

  it('#5 artifact stays downloadable AFTER the sandbox dir is removed (durable beyond sandbox)', async () => {
    const taskId = await mkTask();
    const content = 'survives teardown';
    writeDeliverable(taskId, 'survivor.txt', content);
    const [id] = await svc.registerFromSandbox(wsId, taskId);
    // Simulate sandbox cleanup/teardown.
    rmSync(join(SANDBOX, taskId), { recursive: true, force: true });
    const dl = await svc.downloadById(wsId, id!);
    expect(dl.data.toString('utf8')).toBe(content);
  });

  it('#6 re-registering identical content does NOT create a duplicate version', async () => {
    const taskId = await mkTask();
    writeDeliverable(taskId, 'same.txt', 'unchanged');
    const a = await svc.registerFromSandbox(wsId, taskId);
    const b = await svc.registerFromSandbox(wsId, taskId);
    expect(a).toEqual(b);
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { taskId, name: 'deliverables/same.txt' }, include: { versions: true } });
    expect(artifact.versions).toHaveLength(1);
  });

  it('#7 changed content creates version+1 and advances currentVersionId', async () => {
    const taskId = await mkTask();
    writeDeliverable(taskId, 'evolve.txt', 'v1 content');
    await svc.registerFromSandbox(wsId, taskId);
    writeDeliverable(taskId, 'evolve.txt', 'v2 content CHANGED');
    await svc.registerFromSandbox(wsId, taskId);
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { taskId, name: 'deliverables/evolve.txt' }, include: { versions: { orderBy: { version: 'asc' } } } });
    expect(artifact.versions.map((v) => v.version)).toEqual([1, 2]);
    const current = artifact.versions.find((v) => v.id === artifact.currentVersionId)!;
    expect(current.version).toBe(2);
    expect(current.sha256).toBe(sha(Buffer.from('v2 content CHANGED')));
  });

  it('#11 metadata sizeBytes is a JSON-safe number (no BigInt serialization error)', async () => {
    const taskId = await mkTask();
    writeDeliverable(taskId, 'sized.txt', 'abcde'); // 5 bytes
    const [id] = await svc.registerFromSandbox(wsId, taskId);
    const meta = await svc.getMetaById(wsId, id!);
    expect(typeof meta.sizeBytes).toBe('number');
    expect(meta.sizeBytes).toBe(5);
    expect(() => JSON.stringify(meta)).not.toThrow(); // would throw if a BigInt leaked through
    expect(JSON.parse(JSON.stringify(meta)).sizeBytes).toBe(5);
  });

  it('#9 blob upload failure → NO partial DB row (artifact or version)', async () => {
    const failStorage = {
      backendName: 'fail',
      keyFor: (w: string, t: string, a: string, v: number) => `${w}/${t}/${a}/v${v}`,
      put: async () => { throw new Error('blob upload boom'); },
      get: async () => Buffer.from(''),
      delete: async () => undefined,
    };
    const failSvc = new ArtifactsService(prisma as never, failStorage as never);
    const taskId = await mkTask();
    writeDeliverable(taskId, 'nope.txt', 'should not persist');
    const ids = await failSvc.registerFromSandbox(wsId, taskId);
    expect(ids).toEqual([]);
    expect(await prisma.artifact.count({ where: { taskId } })).toBe(0);
    expect(await prisma.artifactVersion.count({ where: { workspaceId: wsId, artifact: { taskId } } })).toBe(0);
  });

  it('#10 DB write failure after upload → blob is best-effort cleaned up', async () => {
    let puts = 0;
    let deletes = 0;
    const spyStorage = {
      backendName: 'spy',
      keyFor: (w: string, t: string, a: string, v: number) => `${w}/${t}/${a}/v${v}`,
      put: async () => { puts += 1; },
      get: async () => Buffer.from(''),
      delete: async () => { deletes += 1; },
    };
    // Fake prisma: no existing artifact, but artifact.create throws (simulates a DB transaction fail).
    const fakePrisma = {
      artifact: {
        findUnique: async () => null,
        create: async () => { throw new Error('db write boom'); },
        update: async () => undefined,
      },
      artifactVersion: { create: async () => { throw new Error('db write boom'); } },
    };
    const svc10 = new ArtifactsService(fakePrisma as never, spyStorage as never);
    const taskId = `fake-${suffix}`;
    writeDeliverable(taskId, 'orphan.txt', 'content');
    const ids = await svc10.registerFromSandbox(wsId, taskId);
    expect(ids).toEqual([]);
    expect(puts).toBe(1); // blob was uploaded
    expect(deletes).toBe(1); // ...then cleaned up after the DB write failed (no orphan)
  });

  it('#8 cross-workspace artifact read/download is blocked (RLS + service scope)', async () => {
    // Register an artifact in workspace A (the suite ws).
    const taskId = await mkTask();
    writeDeliverable(taskId, 'secret.txt', 'workspace A only');
    const [artId] = await svc.registerFromSandbox(wsId, taskId);
    expect(artId).toBeDefined();

    // Service-level scope: asking as a DIFFERENT workspace id => NotFound (never the bytes).
    const other = await prisma.workspace.create({ data: { name: 'B', slug: `art-b-${suffix}`, ownerUserId: userId } });
    extraWs.push(other.id);
    await expect(svc.getMetaById(other.id, artId!)).rejects.toThrow();
    await expect(svc.downloadById(other.id, artId!)).rejects.toThrow();

    // DB-level RLS: the least-privilege role in workspace B's context cannot see A's artifact row.
    let app: PrismaClient | undefined;
    try {
      const url = new URL(process.env.DATABASE_URL as string);
      url.username = 'agentos_app';
      url.password = 'agentos_app';
      app = makeRlsClient(url.toString());
      await app.$connect();
    } catch {
      console.warn('artifact rls: agentos_app role unavailable, skipping the DB-level assertion');
      return;
    }
    const appClient = app;
    await tenantContext.run({ workspaceId: other.id }, async () => {
      expect(await appClient.artifact.findFirst({ where: { id: artId! } })).toBeNull();
    });
    await app.$disconnect().catch(() => undefined);
  });

  it('#3 a run that produces a deliverable fills final_output.artifactIds (end to end via TaskRunner)', async () => {
    const { TaskRunner } = await import('../tasks/task-runner');
    const taskId = await mkTask(TaskStatus.pending);
    const tool = (name: string, handler: InMemoryTool['handler']): InMemoryTool => ({
      descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, riskLevel: 'low', approvalRequired: false },
      handler,
    });
    const provider = new MockProvider([
      { text: '1. make a file', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'make_file', input: {} }], stopReason: 'tool_use' },
      { text: 'Here is your report.', stopReason: 'end_turn' },
    ]);
    const tools = new InMemoryToolExecutor([
      tool('make_file', () => {
        writeDeliverable(taskId, 'final-report.md', '# Report\n\nGenerated by the agent.');
        return { ok: true, output: { path: 'deliverables/final-report.md' } };
      }),
    ]);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    await new TaskRunner(prisma as never).run({
      task: {
        id: task.id, workspaceId: wsId, createdByUserId: userId, prompt: task.prompt,
        riskCeiling: task.riskCeiling, stepBudget: task.stepBudget, costBudgetUsd: null,
      },
      provider,
      tools,
      controller: new RunController(),
      registerArtifacts: () => svc.registerFromSandbox(wsId, taskId, task.projectId),
    });

    const finished = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(finished.status).toBe(TaskStatus.completed);
    // The LAST final_output event carries the resolved artifactIds (non-empty).
    const finals = await prisma.taskLog.findMany({ where: { taskId, type: 'final_output' }, orderBy: { seq: 'desc' }, take: 1 });
    const last = finals[0]!.payload as { artifactIds?: string[] };
    expect(last.artifactIds && last.artifactIds.length).toBeGreaterThan(0);
    // ...and Task.result mirrors them.
    expect((finished.result as { artifactIds?: string[] }).artifactIds?.length).toBeGreaterThan(0);
  });
});
