import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
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
import { MemoryService } from './memory.service';

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
type Args = ConstructorParameters<typeof TasksService>;
const SECRET = 'sk-ant-TASKMEMSECRET-NOLEAK-9911';
const DETAIL = 'verbose memory body that must never reach the audit log';

/** Drives the REAL TasksService.executeTask path to prove the flag gates the memory preamble + the
 * memory.retrieved audit, and that the audit carries no secret/content (TICKET-MEMORY). */
suite('Project memory task injection (live Postgres, mock LLM)', () => {
  const prisma = getPrisma();
  const sfx = Date.now().toString(36);
  let service: TasksService;
  let userId = '';
  let wsId = '';

  beforeAll(async () => {
    process.env.LLM_MODE = 'mock';
    process.env.ENABLE_BROWSER_TOOLS = 'false';
    process.env.ENABLE_SANDBOX = 'false';
    process.env.AGENT_SANDBOX_ROOT = join(tmpdir(), `agentos-mem-${sfx}`);
    const audit = new AuditService(prisma as never);
    service = new TasksService(
      prisma as Args[0],
      audit,
      new LlmProviderFactory(null as never),
      new ToolsFactory(),
      { publish: () => undefined } as unknown as TaskEventBus,
      new TaskControlBus(null),
      null,
      null as never,
      { buildPreamble: async () => undefined } as never, // personalization: no preamble
      { hasImageProvider: async () => false, hasSpeechProvider: async () => false } as never, // media
      { githubApiFor: async () => null, notionApiFor: async () => null, googleApiFor: async () => null, outlookApiFor: async () => null } as never, // connectors
      { hasPeer: async () => false, peerName: async () => null } as never, // peer
      { approvedFor: async () => [] } as never, // local folders
      { deployerFor: async () => null } as never, // hosting
      new ArtifactsService(prisma as never, new StorageService()),
      new PolicyService(),
      new CodingWorkspaceService(),
      null as never, // automation runs
      new MemoryService(prisma as never, audit), // project memory: REAL
    );
    tenantContext.enterSystem();
    const u = await prisma.user.create({ data: { email: `memtask-${sfx}@t.local`, displayName: 'MT' } });
    userId = u.id;
    wsId = (await prisma.workspace.create({ data: { name: 'MT', slug: `memtask-${sfx}`, ownerUserId: u.id } })).id;
    // One secret-bearing memory relevant to the task prompt (stored already-redacted).
    await new MemoryService(prisma as never, audit).create(wsId, userId, {
      kind: 'project_rule', content: `Use pnpm. Key ${SECRET}. ${DETAIL}`, source: 'userProvided', tags: ['pnpm', 'install'], priority: 10,
    });
  });

  afterAll(async () => {
    delete process.env.PROJECT_MEMORY_ENABLED;
    if (wsId) await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  async function runTaskRow(): Promise<string> {
    const t = await prisma.task.create({
      data: { workspaceId: wsId, createdByUserId: userId, title: 'mem task', prompt: 'how do I install dependencies with pnpm?', status: TaskStatus.pending },
    });
    await service.runTask(t.id).catch(() => undefined); // memory.retrieved fires before the engine runs
    return t.id;
  }

  it('flag ON: writes a content-free memory.retrieved audit for the task', async () => {
    process.env.PROJECT_MEMORY_ENABLED = 'true';
    const taskId = await runTaskRow();
    const row = await prisma.auditLog.findFirst({ where: { workspaceId: wsId, targetId: taskId, action: 'memory.retrieved' } });
    expect(row).not.toBeNull();
    const meta = JSON.stringify(row?.metadata ?? {});
    expect(meta.includes(SECRET)).toBe(false); // no secret
    expect(meta.includes(DETAIL)).toBe(false); // no full content
    expect(meta).toMatch(/"count"/);
    expect(meta).toMatch(/"kinds"/);
    expect((row?.metadata as { count?: number })?.count).toBeGreaterThanOrEqual(1);
  });

  it('flag OFF: no memory.retrieved audit is written (runtime inert)', async () => {
    delete process.env.PROJECT_MEMORY_ENABLED;
    const taskId = await runTaskRow();
    const row = await prisma.auditLog.findFirst({ where: { workspaceId: wsId, targetId: taskId, action: 'memory.retrieved' } });
    expect(row).toBeNull();
  });
});
