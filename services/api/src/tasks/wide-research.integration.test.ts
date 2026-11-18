import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, TaskStatus, type Task } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { LlmProviderFactory } from './llm-provider.factory';
import { ToolsFactory } from './tools.factory';
import { TaskControlBus } from './task-control-bus';
import type { TaskEventBus } from '../events/task-event-bus';
import { TasksService } from './tasks.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { StorageService } from '../storage/storage.service';
import { PolicyService } from '../policy/policy.service';
import { CodingWorkspaceService } from '../coding/coding.service';

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

suite('Wide Research — parallel sub-agents (live Postgres, mock LLM)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';
  let service: TasksService;

  beforeAll(() => {
    process.env.LLM_MODE = 'mock';
    process.env.ENABLE_BROWSER_TOOLS = 'false';
    process.env.ENABLE_SANDBOX = 'false';
    process.env.AGENT_SANDBOX_ROOT = join(tmpdir(), `agentos-wr-${suffix}`);
    service = new TasksService(
      prisma as Args[0],
      new AuditService(prisma as never),
      new LlmProviderFactory(null as never),
      new ToolsFactory(),
      { publish: () => undefined } as unknown as TaskEventBus,
      new TaskControlBus(null),
      null,
      null as never,
      // personalization: a stub that yields no preamble (the run path tolerates a missing one).
      { buildPreamble: async () => undefined } as never,
      // media: a stub that reports no configured providers (so no media tools are advertised).
      { hasImageProvider: async () => false, hasSpeechProvider: async () => false } as never,
      // connectors: a stub with no GitHub/Notion/Google/Outlook connection.
      {
        githubApiFor: async () => null,
        notionApiFor: async () => null,
        googleApiFor: async () => null,
        outlookApiFor: async () => null,
      } as never,
      // peer: a stub reporting no peer model (so the consult_peer tool is withheld).
      { hasPeer: async () => false, peerName: async () => null } as never,
      // local folders: a stub reporting none approved.
      { approvedFor: async () => [] } as never,
      // hosting: a stub reporting no deploy token (publish_site withheld).
      { deployerFor: async () => null } as never,
      // artifacts: real service (no-op while ARTIFACT_PERSISTENCE_ENABLED is off in tests).
      new ArtifactsService(prisma as never, new StorageService()),
      // policy: real service (no-op while POLICY_ENGINE_ENABLED is off in tests).
      new PolicyService(),
      // coding: real service (no-op while CODING_WORKSPACE_ENABLED is off in tests).
      new CodingWorkspaceService(),
      // automation runs: not exercised here (AUTOMATION_RUNS_ENABLED off in tests).
      null as never,
      // project memory: not exercised here (PROJECT_MEMORY_ENABLED off in tests).
      null as never,
    );
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('spawns linked sub-tasks, runs them in parallel, and returns each result', async () => {
    const user = await prisma.user.create({
      data: { email: `wr-${suffix}@test.local`, displayName: 'WR User' },
    });
    userId = user.id;
    const ws = await prisma.workspace.create({
      data: { name: 'WR WS', slug: `wr-${suffix}`, ownerUserId: user.id },
    });
    workspaceId = ws.id;
    const parent = (await prisma.task.create({
      data: {
        workspaceId: ws.id,
        createdByUserId: user.id,
        title: 'Research parent',
        prompt: 'compare three options',
        status: TaskStatus.running,
      },
    })) as Task;

    const prompts = ['analyze option A', 'analyze option B', 'analyze option C'];
    const results = await (
      service as unknown as { runWideResearch(p: Task, prompts: string[]): Promise<unknown[]> }
    ).runWideResearch(parent, prompts);

    expect(results).toHaveLength(3);

    // Each sub-task is a real, completed child row linked to the parent.
    const children = await prisma.task.findMany({ where: { parentTaskId: parent.id } });
    expect(children).toHaveLength(3);
    expect(children.every((c) => c.status === TaskStatus.completed)).toBe(true);
    expect(children.map((c) => c.prompt).sort()).toEqual([...prompts].sort());
    // Children carry their own cost rows (each ran its own engine).
    const costs = await prisma.costRecord.count({ where: { taskId: { in: children.map((c) => c.id) } } });
    expect(costs).toBe(3);
  }, 60_000);
});
