import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma, TaskStatus, type RiskLevel } from '@agentos/db';
import { MockProvider } from '@agentos/llm';
import { InMemoryToolExecutor, RunController, type InMemoryTool } from '@agentos/agent-engine';
import { TaskRunner } from './task-runner';

// Mirror the db package convention: load DATABASE_URL from packages/db/.env when not already set so a
// local `vitest run` connects. In CI without a database the suite skips instead of failing.
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

const hasDb = Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;

/** A trivial low-risk tool — exercises the tool_call/tool_result persistence path without approval. */
const echoTool: InMemoryTool = {
  descriptor: {
    name: 'echo',
    description: 'Returns its input unchanged.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    riskLevel: 'low',
    approvalRequired: false,
  },
  handler: (input) => ({ ok: true, output: input }),
};

suite('TaskRunner (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) {
      await prisma.usageRecord.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.costRecord.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.notification.deleteMany({ where: { workspaceId } }).catch(() => undefined);
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('runs the agent, persisting events, tool calls, usage and cost; task ends completed', async () => {
    const user = await prisma.user.create({
      data: { email: `runner-${suffix}@test.local`, displayName: 'Runner User' },
    });
    userId = user.id;
    const ws = await prisma.workspace.create({
      data: {
        name: 'Runner WS',
        slug: `runner-${suffix}`,
        ownerUserId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    workspaceId = ws.id;
    const task = await prisma.task.create({
      data: {
        workspaceId: ws.id,
        createdByUserId: user.id,
        title: 'Echo a value',
        prompt: 'Use the echo tool on "ping" and report the result.',
        riskCeiling: 'high' as RiskLevel,
        stepBudget: 6,
      },
    });

    const provider = new MockProvider([
      { text: '1. call echo\n2. report', stopReason: 'end_turn' },
      {
        text: '',
        toolCalls: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { value: 'ping' } }],
        stopReason: 'tool_use',
      },
      { text: 'The echo tool returned "ping".', stopReason: 'end_turn' },
    ]);

    await new TaskRunner(prisma).run({
      task: {
        id: task.id,
        workspaceId: ws.id,
        createdByUserId: task.createdByUserId,
        prompt: task.prompt,
        riskCeiling: task.riskCeiling,
        stepBudget: task.stepBudget,
        costBudgetUsd: null,
      },
      provider,
      tools: new InMemoryToolExecutor([echoTool]),
      controller: new RunController(),
    });

    // Task reached a terminal completed state with cost + timestamps recorded.
    const finished = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(finished.status).toBe(TaskStatus.completed);
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.startedAt).not.toBeNull();
    expect(Number(finished.estCostUsd)).toBeGreaterThan(0);

    // Every engine event was persisted, gap-free and seq-ordered.
    const logs = await prisma.taskLog.findMany({
      where: { taskId: task.id },
      orderBy: { seq: 'asc' },
    });
    expect(logs.length).toBeGreaterThan(0);
    logs.forEach((log, i) => expect(log.seq).toBe(i));
    expect(logs.some((l) => l.type === 'plan')).toBe(true);
    expect(logs.some((l) => l.type === 'final_output')).toBe(true);

    // The tool call round-trip landed as one row, resolved ok.
    const toolCalls = await prisma.toolCall.findMany({ where: { taskId: task.id } });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe('echo');
    expect(toolCalls[0]?.ok).toBe(true);

    // Usage + cost metering rows exist.
    const usage = await prisma.usageRecord.findFirst({ where: { taskId: task.id } });
    expect(usage).not.toBeNull();
    expect(usage?.model).toBe(provider.model);
    expect(usage ? usage.inputTokens > 0n : false).toBe(true);

    const cost = await prisma.costRecord.findFirst({ where: { taskId: task.id } });
    expect(cost).not.toBeNull();
    expect(cost ? Number(cost.amountUsd) > 0 : false).toBe(true);
  });

  it('applies post-run deliberation: the revised answer + critique replace the draft', async () => {
    const task = await prisma.task.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        title: 'Deliberate',
        prompt: 'Give the answer.',
        status: TaskStatus.pending,
        riskCeiling: 'low' as RiskLevel,
        stepBudget: 4,
      },
    });

    // plan call, then a final answer (no tools).
    const provider = new MockProvider([
      { text: '1. answer the question', stopReason: 'end_turn' },
      { text: 'Draft answer: 42.', stopReason: 'end_turn' },
    ]);

    let sawDraft = '';
    await new TaskRunner(prisma).run({
      task: {
        id: task.id,
        workspaceId,
        createdByUserId: userId,
        prompt: task.prompt,
        riskCeiling: task.riskCeiling,
        stepBudget: task.stepBudget,
        costBudgetUsd: null,
      },
      provider,
      tools: new InMemoryToolExecutor([]),
      controller: new RunController(),
      deliberate: async (finalText) => {
        sawDraft = finalText;
        return {
          costUsd: 5,
          revision: {
            finalText: 'Revised answer: 42 (verified).',
            critique: 'Add a verification note.',
            peerModel: 'mimo-vl',
          },
        };
      },
    });

    const finished = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(finished.status).toBe(TaskStatus.completed);
    const result = finished.result as {
      summary: string;
      deliberation?: { peerModel: string; critique: string; original: string };
    };
    expect(sawDraft).toContain('Draft answer');
    expect(result.summary).toBe('Revised answer: 42 (verified).');
    expect(result.deliberation?.peerModel).toBe('mimo-vl');
    expect(result.deliberation?.critique).toBe('Add a verification note.');
    expect(result.deliberation?.original).toContain('Draft answer');
    // The deliberation cost (5) is folded into estCostUsd (on top of the engine's own cost).
    expect(Number(finished.estCostUsd)).toBeGreaterThan(5);

    // The revised answer is surfaced as a follow-up final_output event (gap-free seq) so the live UI,
    // which derives the final output from the last final_output event, shows the deliberated answer.
    const finalLogs = await prisma.taskLog.findMany({
      where: { taskId: task.id, type: 'final_output' },
      orderBy: { seq: 'asc' },
    });
    expect(finalLogs.length).toBe(2);
    expect((finalLogs[1]!.payload as { summary: string }).summary).toBe('Revised answer: 42 (verified).');
    const allLogs = await prisma.taskLog.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
    allLogs.forEach((l, i) => expect(l.seq).toBe(i)); // still gap-free after the appended event

    // The appended final_output must NOT fire a second "Task completed" notification (the engine's
    // own final_output already did). Exactly one task_done notification for the task.
    const doneNotifs = await prisma.notification.findMany({
      where: { taskId: task.id, kind: 'task_done' },
    });
    expect(doneNotifs).toHaveLength(1);
  });

  it('leaves the original answer when deliberation returns null or throws', async () => {
    const task = await prisma.task.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        title: 'No deliberation',
        prompt: 'Give the answer.',
        status: TaskStatus.pending,
        riskCeiling: 'low' as RiskLevel,
        stepBudget: 4,
      },
    });
    const provider = new MockProvider([
      { text: '1. answer', stopReason: 'end_turn' },
      { text: 'Only answer: 7.', stopReason: 'end_turn' },
    ]);
    await new TaskRunner(prisma).run({
      task: {
        id: task.id,
        workspaceId,
        createdByUserId: userId,
        prompt: task.prompt,
        riskCeiling: task.riskCeiling,
        stepBudget: task.stepBudget,
        costBudgetUsd: null,
      },
      provider,
      tools: new InMemoryToolExecutor([]),
      controller: new RunController(),
      deliberate: async () => {
        throw new Error('peer unreachable');
      },
    });
    const finished = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(finished.status).toBe(TaskStatus.completed);
    const result = finished.result as { summary: string; deliberation?: unknown };
    expect(result.summary).toBe('Only answer: 7.');
    expect(result.deliberation).toBeUndefined();
  });

  it('an empty judge revision keeps the original answer (no phantom revision) but still bills the cost', async () => {
    const task = await prisma.task.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        title: 'Empty revision',
        prompt: 'Give the answer.',
        status: TaskStatus.pending,
        riskCeiling: 'low' as RiskLevel,
        stepBudget: 4,
      },
    });
    const provider = new MockProvider([
      { text: '1. answer', stopReason: 'end_turn' },
      { text: 'Original: 9.', stopReason: 'end_turn' },
    ]);
    await new TaskRunner(prisma).run({
      task: {
        id: task.id,
        workspaceId,
        createdByUserId: userId,
        prompt: task.prompt,
        riskCeiling: task.riskCeiling,
        stepBudget: task.stepBudget,
        costBudgetUsd: null,
      },
      provider,
      tools: new InMemoryToolExecutor([]),
      controller: new RunController(),
      // The judge produced nothing usable => revision null, but the critique cost was still spent.
      deliberate: async () => ({ costUsd: 3, revision: null }),
    });
    const finished = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const result = finished.result as { summary: string; deliberation?: unknown };
    expect(result.summary).toBe('Original: 9.'); // unchanged
    expect(result.deliberation).toBeUndefined(); // no phantom revision recorded
    expect(Number(finished.estCostUsd)).toBeGreaterThan(3); // cost still folded in
    // No duplicate final_output event was appended.
    const finalLogs = await prisma.taskLog.findMany({ where: { taskId: task.id, type: 'final_output' } });
    expect(finalLogs).toHaveLength(1);
  });
});
