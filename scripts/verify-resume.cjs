/* Live durable-resume verification harness (RESUME_ENABLED=true).
 * Uses the REAL compiled TaskRunner + AgentEngine against the REAL local Postgres. A child OS
 * process runs a 3-step task and is SIGKILLed mid-step-3 (genuine crash); a fresh process resumes it.
 * Run: node scripts/verify-resume.cjs            (orchestrator)
 *      node scripts/verify-resume.cjs worker <taskId> <block|finish>   (internal)
 */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { setTimeout: sleep } = require('node:timers/promises');
// Resolve workspace packages (and the compiled TaskRunner) from services/api's module graph, so the
// harness shares the SAME @agentos/db (prisma client + tenantContext) instance the TaskRunner uses.
const apiRequire = createRequire(path.join(__dirname, '..', 'services', 'api', 'package.json'));
const { getPrisma, disconnectPrisma, tenantContext, TaskStatus } = apiRequire('@agentos/db');
const { MockProvider } = apiRequire('@agentos/llm');
const { InMemoryToolExecutor, RunController } = apiRequire('@agentos/agent-engine');
const { TaskRunner } = apiRequire('./dist/tasks/task-runner.js');

const tool = (name, handler) => ({
  descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, riskLevel: 'low', approvalRequired: false },
  handler,
});

async function runWorker(taskId, mode) {
  tenantContext.enterSystem();
  const prisma = getPrisma();
  const t = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  const runnable = {
    id: t.id, workspaceId: t.workspaceId, createdByUserId: t.createdByUserId, prompt: t.prompt,
    riskCeiling: t.riskCeiling, stepBudget: t.stepBudget, costBudgetUsd: t.costBudgetUsd != null ? Number(t.costBudgetUsd) : null,
  };
  let provider, tools;
  if (mode === 'block') {
    provider = new MockProvider([
      { text: '1. a\n2. b\n3. c', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u0', name: 'quick', input: {} }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'quick', input: {} }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u2', name: 'block', input: {} }], stopReason: 'tool_use' },
    ]);
    tools = new InMemoryToolExecutor([
      tool('quick', () => ({ ok: true, output: { done: true } })),
      tool('block', () => { console.log('WORKER block tool entered — will hang until killed'); return new Promise(() => {}); }),
    ]);
  } else {
    provider = new MockProvider([{ text: 'FINAL ANSWER (resumed)', stopReason: 'end_turn' }]);
    tools = new InMemoryToolExecutor([tool('quick', () => ({ ok: true, output: {} }))]);
  }
  await new TaskRunner(prisma).run({ task: runnable, provider, tools, controller: new RunController() });
  console.log(`WORKER ${mode} finished`);
  await disconnectPrisma();
}

const snap = async (prisma, taskId) => {
  const [t, s, agg, usage, cost, logCount] = await Promise.all([
    prisma.task.findUnique({ where: { id: taskId }, select: { status: true, leaseOwner: true, leaseExpiresAt: true, fencingToken: true, resumeCount: true, result: true } }),
    prisma.taskSnapshot.findUnique({ where: { taskId }, select: { seq: true, state: true } }),
    prisma.taskLog.aggregate({ where: { taskId }, _max: { seq: true }, _count: true }),
    prisma.usageRecord.count({ where: { taskId } }),
    prisma.costRecord.count({ where: { taskId } }),
    prisma.toolCall.count({ where: { taskId } }),
  ]);
  return {
    status: t?.status, leaseOwner: t?.leaseOwner, leaseExpiresAt: t?.leaseExpiresAt, fencingToken: t?.fencingToken,
    resumeCount: t?.resumeCount, result: t?.result,
    snapshot: s ? { seq: s.seq, step: s.state?.step, planned: s.state?.planned, messages: Array.isArray(s.state?.messages) ? s.state.messages.length : null } : null,
    maxSeq: agg._max.seq, logCount: agg._count, toolCalls: logCount, usageRecords: usage, costRecords: cost,
  };
};

async function orchestrate() {
  tenantContext.enterSystem();
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const report = { env: { RESUME_ENABLED: 'true', RESUME_LEASE_TTL_SEC: process.env.RESUME_LEASE_TTL_SEC, RESUME_HEARTBEAT_SEC: process.env.RESUME_HEARTBEAT_SEC } };

  const user = await prisma.user.create({ data: { email: `verify-${suffix}@t.local`, displayName: 'V' } });
  const ws = await prisma.workspace.create({ data: { name: 'Verify', slug: `verify-${suffix}`, ownerUserId: user.id } });
  const task = await prisma.task.create({ data: { workspaceId: ws.id, createdByUserId: user.id, title: 'verify', prompt: 'run three steps then answer', status: TaskStatus.pending } });
  report.taskId = task.id;
  report.before = await snap(prisma, task.id);

  // --- Phase 1: spawn a worker that runs to step 3 then blocks in a tool ---
  const childEnv = { ...process.env, RESUME_ENABLED: 'true' };
  const child = spawn(process.execPath, [__filename, 'worker', task.id, 'block'], { env: childEnv, stdio: 'inherit' });
  report.workerPid = child.pid;

  // Wait until the block tool is executing: 3 tool_call events persisted AND snapshot at step >= 2.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await snap(prisma, task.id);
    if (s.toolCalls >= 3 && s.snapshot && s.snapshot.step >= 2) { ready = true; break; }
  }
  if (!ready) { console.log('TIMED OUT waiting for step 3'); child.kill('SIGKILL'); }
  report.atCrash = await snap(prisma, task.id);

  // --- Crash: hard-kill the worker mid-run (genuine SIGKILL) ---
  child.kill('SIGKILL');
  await sleep(800);
  report.afterKill = await snap(prisma, task.id);

  // --- Restart (single-replica boot path): clear the dead worker's lease, then resume ---
  // This is exactly TasksService.resumeOrphansOnBoot's action.
  await prisma.task.updateMany({ where: { id: task.id, status: { in: [TaskStatus.running, TaskStatus.planning, TaskStatus.awaiting_approval, TaskStatus.paused, TaskStatus.verifying] } }, data: { leaseOwner: null, leaseExpiresAt: null } });
  report.afterBootClear = await snap(prisma, task.id);

  // --- Resume: two concurrent fresh workers (duplicate-delivery test) ---
  const mk = () => new Promise((res) => {
    const c = spawn(process.execPath, [__filename, 'worker', task.id, 'finish'], { env: childEnv, stdio: 'inherit' });
    c.on('exit', (code) => res(code));
  });
  await Promise.all([mk(), mk()]);
  await sleep(500);
  report.afterResume = await snap(prisma, task.id);

  // Cleanup (cascade removes task/logs/snapshot).
  await prisma.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);

  console.log('\n===REPORT===');
  console.log(JSON.stringify(report, null, 2));
  console.log('===END===');
  await disconnectPrisma();
}

// Seed a crashed-style running task (optionally with a snapshot) for the REAL API boot test.
async function seed(withSnapshot) {
  tenantContext.enterSystem();
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({ data: { email: `seed-${suffix}@t.local`, displayName: 'S' } });
  const ws = await prisma.workspace.create({ data: { name: 'Seed', slug: `seed-${suffix}`, ownerUserId: user.id } });
  const t = await prisma.task.create({ data: { workspaceId: ws.id, createdByUserId: user.id, title: 'seed', prompt: 'x', status: TaskStatus.running, leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000), fencingToken: 1 } });
  if (withSnapshot === 'snap') {
    const state = { v: 1, seq: 3, step: 1, planned: true, messages: [{ role: 'user', content: 'x' }], runningSummary: '', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 }, callCounter: 1, approvalCounter: 0, toolCallCount: 1, toolErrors: 0 };
    await prisma.taskSnapshot.create({ data: { taskId: t.id, workspaceId: ws.id, seq: 3, state } });
  }
  console.log(JSON.stringify({ taskId: t.id, wsId: ws.id, userId: user.id }));
  await disconnectPrisma();
}
async function status(taskId) {
  tenantContext.enterSystem();
  const prisma = getPrisma();
  console.log(JSON.stringify(await snap(prisma, taskId)));
  await disconnectPrisma();
}
async function cleanup(wsId, userId) {
  tenantContext.enterSystem();
  const prisma = getPrisma();
  await prisma.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  console.log('cleaned');
  await disconnectPrisma();
}

const mode = process.argv[2];
if (mode === 'worker') {
  runWorker(process.argv[3], process.argv[4]).catch((e) => { console.error('WORKER ERROR', e); process.exit(1); });
} else if (mode === 'seed') {
  seed(process.argv[3]).catch((e) => { console.error('SEED ERROR', e); process.exit(1); });
} else if (mode === 'status') {
  status(process.argv[3]).catch((e) => { console.error('STATUS ERROR', e); process.exit(1); });
} else if (mode === 'cleanup') {
  cleanup(process.argv[3], process.argv[4]).catch((e) => { console.error('CLEANUP ERROR', e); process.exit(1); });
} else {
  orchestrate().catch((e) => { console.error('ORCH ERROR', e); process.exit(1); });
}
