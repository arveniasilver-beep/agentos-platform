import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { getPrisma, disconnectPrisma, tenantContext, TaskStatus } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { LlmProviderFactory } from '../tasks/llm-provider.factory';
import { ToolsFactory } from '../tasks/tools.factory';
import { TaskControlBus } from '../tasks/task-control-bus';
import type { TaskEventBus } from '../events/task-event-bus';
import { TasksService } from '../tasks/tasks.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { StorageService } from '../storage/storage.service';
import { PolicyService } from '../policy/policy.service';
import { CodingWorkspaceService } from '../coding/coding.service';
import { TaskWorker } from './task.worker';
import { AGENT_TASK_QUEUE, type RunJobData } from './queue.constants';

// TASKWORKER-TEST: the production TaskWorker had ZERO coverage — the queue round-trip test reconstructs
// its OWN inline Worker on a `-test` queue. This drives the REAL TaskWorker class draining the REAL
// AGENT_TASK_QUEUE. The worker name is hardcoded, so to avoid stealing/being-stolen by a live API worker
// on the same Redis, we pin a DEDICATED Redis logical DB (…/9). Env mutations are restored in afterAll.

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) { process.env.DATABASE_URL = m[1]; break; }
    }
  }
}
const REDIS_BASE = process.env.REDIS_URL ?? 'redis://localhost:6380';
const TEST_REDIS_URL = REDIS_BASE.replace(/\/\d+$/, '') + '/9'; // dedicated DB → isolated from a live worker
const suite = process.env.DATABASE_URL ? describe : describe.skip;
type Args = ConstructorParameters<typeof TasksService>;

suite('Real TaskWorker drains the queue (TASKWORKER-TEST, live Redis + Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';
  let service: TasksService;
  let worker: TaskWorker | undefined;
  let producer: IORedis | undefined;
  let queue: Queue<RunJobData> | undefined;
  const prev: Record<string, string | undefined> = {};

  const build = () =>
    new TasksService(
      prisma as Args[0],
      new AuditService(prisma as never),
      new LlmProviderFactory(null as never),
      new ToolsFactory(),
      { publish: () => undefined } as unknown as TaskEventBus,
      new TaskControlBus(null),
      null,
      null as never,
      { buildPreamble: async () => undefined } as never,
      { hasImageProvider: async () => false, hasSpeechProvider: async () => false } as never,
      { githubApiFor: async () => null, notionApiFor: async () => null, googleApiFor: async () => null, outlookApiFor: async () => null } as never,
      { hasPeer: async () => false, peerName: async () => null } as never,
      { approvedFor: async () => [] } as never,
      { deployerFor: async () => null } as never,
      new ArtifactsService(prisma as never, new StorageService()),
      new PolicyService(),
      new CodingWorkspaceService(),
      null as never,
      null as never,
    );

  const waitTerminal = async (taskId: string, ms = 20000): Promise<TaskStatus> => {
    const t0 = Date.now();
    for (;;) {
      const t = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
      if (t && (['completed', 'failed', 'stopped'] as TaskStatus[]).includes(t.status)) return t.status;
      if (Date.now() - t0 > ms) throw new Error(`task ${taskId} did not finish in ${ms}ms (status=${t?.status})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  beforeAll(async () => {
    for (const k of ['EXECUTION_MODE', 'REDIS_URL', 'LLM_MODE', 'ENABLE_BROWSER_TOOLS', 'ENABLE_SANDBOX', 'AGENT_SANDBOX_ROOT']) {
      prev[k] = process.env[k];
    }
    process.env.EXECUTION_MODE = 'queue';
    process.env.REDIS_URL = TEST_REDIS_URL;
    process.env.LLM_MODE = 'mock';
    process.env.ENABLE_BROWSER_TOOLS = 'false';
    process.env.ENABLE_SANDBOX = 'false';
    process.env.AGENT_SANDBOX_ROOT = join(tmpdir(), `agentos-tw-${suffix}`);
    service = build();
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `tw-${suffix}@test.local`, displayName: 'TW' } });
    userId = u.id;
    workspaceId = (await prisma.workspace.create({ data: { name: 'TW WS', slug: `tw-${suffix}`, ownerUserId: u.id, members: { create: { userId: u.id, role: 'owner' } } } })).id;
  });

  afterAll(async () => {
    await worker?.onModuleDestroy().catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await producer?.quit().catch(() => undefined);
    if (workspaceId) {
      await prisma.usageRecord.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.costRecord.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await disconnectPrisma();
  });

  it('the production TaskWorker (not a stand-in) drains an enqueued job and runs the task to completion', async () => {
    producer = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    try {
      await producer.connect();
    } catch {
      console.warn('TaskWorker integration: Redis unreachable, skipping');
      return;
    }
    // Start the REAL worker: reads EXECUTION_MODE=queue + REDIS_URL and drains AGENT_TASK_QUEUE in-process.
    worker = new TaskWorker(service);
    worker.onModuleInit();

    const task = await prisma.task.create({
      data: { workspaceId, createdByUserId: userId, title: 'queued', prompt: 'respond and finish', status: TaskStatus.pending, riskCeiling: 'low' },
    });

    // Enqueue exactly as TasksService.dispatch would, then let the REAL worker pick it up.
    queue = new Queue<RunJobData>(AGENT_TASK_QUEUE, { connection: producer });
    await queue.add('run', { taskId: task.id });

    const status = await waitTerminal(task.id);
    expect(status).toBe(TaskStatus.completed); // worker drained it + ran runTask to a terminal state
    expect(await prisma.usageRecord.count({ where: { taskId: task.id } })).toBe(1); // exactly one logical run
  });
});
