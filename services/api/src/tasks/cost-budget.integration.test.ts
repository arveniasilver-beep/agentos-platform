import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { ForbiddenException } from '@nestjs/common';
import { getPrisma, disconnectPrisma, tenantContext, TaskStatus } from '@agentos/db';
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

// COST-BUDGET: a workspace/project budget cap is a MONTHLY ceiling. It must (a) HARD-BLOCK a new run once
// month-to-date spend meets the cap (a cap that never stops a run is not a cap), and (b) clamp the per-task
// budget to the remaining headroom. With no cap + no env default, behaviour is byte-identical to before.

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

suite('COST-BUDGET cap enforcement + headroom clamp (live Postgres, mock LLM)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  const wsIds: string[] = [];
  let service: TasksService;

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

  const waitTerminal = async (taskId: string, ms = 15000): Promise<TaskStatus> => {
    const t0 = Date.now();
    for (;;) {
      const t = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
      if (t && (['completed', 'failed', 'stopped'] as TaskStatus[]).includes(t.status)) return t.status;
      if (Date.now() - t0 > ms) throw new Error(`task ${taskId} did not finish (status=${t?.status})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const makeWs = async (data: { budgetCapUsd?: number; costThresholdUsd?: number } = {}) => {
    const ws = await prisma.workspace.create({
      data: {
        name: 'CB', slug: `cb-${suffix}-${wsIds.length}`, ownerUserId: userId,
        members: { create: { userId, role: 'owner' } },
        ...(data.budgetCapUsd !== undefined ? { budgetCapUsd: data.budgetCapUsd } : {}),
        ...(data.costThresholdUsd !== undefined ? { costThresholdUsd: data.costThresholdUsd } : {}),
      },
    });
    wsIds.push(ws.id);
    return ws.id;
  };
  const seedSpend = (wsId: string, amountUsd: number) =>
    prisma.costRecord.create({ data: { workspaceId: wsId, amountUsd, computedAt: new Date() } });
  const dto = (extra: Record<string, unknown> = {}) => ({ title: 't', prompt: 'hi', riskCeiling: 'low', ...extra });

  beforeAll(async () => {
    process.env.LLM_MODE = 'mock';
    process.env.ENABLE_BROWSER_TOOLS = 'false';
    process.env.ENABLE_SANDBOX = 'false';
    process.env.AGENT_SANDBOX_ROOT = join(tmpdir(), `agentos-cb-${suffix}`);
    service = build();
    tenantContext.enterSystem();
    userId = (await prisma.user.create({ data: { email: `cb-${suffix}@test.local`, displayName: 'CB' } })).id;
  });

  afterAll(async () => {
    for (const w of wsIds) await prisma.workspace.delete({ where: { id: w } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('HARD-BLOCKS a new run once month-to-date spend meets the workspace cap (and creates no task)', async () => {
    const wsId = await makeWs({ budgetCapUsd: 1 });
    await seedSpend(wsId, 1.5); // already over the $1 cap
    await expect(service.createAndStart(wsId, userId, dto() as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await prisma.task.count({ where: { workspaceId: wsId } })).toBe(0);
  });

  it('clamps the per-task budget to remaining monthly headroom (min of DTO and cap-minus-spend)', async () => {
    const wsId = await makeWs({ budgetCapUsd: 10 });
    await seedSpend(wsId, 7); // headroom = 3
    const task = await service.createAndStart(wsId, userId, dto({ costBudgetUsd: 5 }) as never);
    expect(Number(task.costBudgetUsd)).toBeCloseTo(3, 6); // min(5, 10-7)
    await waitTerminal(task.id);
  });

  it('no cap + no env default = unbounded (legacy): a DTO budget passes through, none stays null', async () => {
    const wsId = await makeWs();
    const withBudget = await service.createAndStart(wsId, userId, dto({ costBudgetUsd: 2 }) as never);
    expect(Number(withBudget.costBudgetUsd)).toBeCloseTo(2, 6);
    await waitTerminal(withBudget.id);
    const noBudget = await service.createAndStart(wsId, userId, dto() as never);
    expect(noBudget.costBudgetUsd).toBeNull(); // byte-identical to before COST-BUDGET
    await waitTerminal(noBudget.id);
  });
});
