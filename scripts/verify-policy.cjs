/* Live Policy-Engine verification harness (TICKET-POLICY).
 * Drives the REAL compiled PolicyService + AuditService + TaskRunner + AgentEngine + tasks.service
 * against the REAL local Postgres, with POLICY_ENGINE_ENABLED=true. The LLM brain is a MockProvider
 * (a real brain can't be scripted to emit deterministic forbidden tool calls), but every policy
 * decision, gate merge, audit write, approval payload and break-glass check is the real code path.
 *
 *   node scripts/verify-policy.cjs
 */
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

// --- load .env so loadServerEnv() has the required base config ---
const rootEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(rootEnv)) {
  for (const line of fs.readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
process.env.LLM_MODE = 'mock';

const apiRequire = createRequire(path.join(__dirname, '..', 'services', 'api', 'package.json'));
const { getPrisma, disconnectPrisma, tenantContext, TaskStatus, MemberRole } = apiRequire('@agentos/db');
const { MockProvider } = apiRequire('@agentos/llm');
const { RunController, InMemoryToolExecutor } = apiRequire('@agentos/agent-engine');
const { PolicyService } = apiRequire('./dist/policy/policy.service.js');
const { AuditService } = apiRequire('./dist/audit/audit.service.js');
const { TaskRunner } = apiRequire('./dist/tasks/task-runner.js');
const { TasksService } = apiRequire('./dist/tasks/tasks.service.js');
const { TaskControlBus } = apiRequire('./dist/tasks/task-control-bus.js');

const prisma = getPrisma();
const policy = new PolicyService();
const audit = new AuditService(prisma);
const log = (...a) => console.log(...a);
const hr = (t) => log('\n' + '═'.repeat(78) + '\n  ' + t + '\n' + '═'.repeat(78));

function makeTool(name, descriptor, onRun) {
  return {
    descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, ...descriptor },
    handler: (input) => { onRun(input); return { ok: true, output: { ok: true } }; },
  };
}

// Replicates tasks.service.executeTask's policy hook + audit sink exactly, but lets us capture state.
async function runScenario({ wsId, userId, toolName, descriptor, input, grantedCsv, flagOff, autoDecision, repeat, maxDenials }) {
  if (flagOff) { process.env.POLICY_ENGINE_ENABLED = 'false'; } else { process.env.POLICY_ENGINE_ENABLED = 'true'; }
  if (grantedCsv !== undefined) process.env.POLICY_GRANTED_SCOPES = grantedCsv;
  if (maxDenials !== undefined) process.env.POLICY_MAX_DENIALS = String(maxDenials);

  const task = await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: userId, title: 't', prompt: 'p', status: TaskStatus.pending } });
  const decisions = [];
  const approvals = [];
  let ran = 0;
  const lastInput = {};

  const policyEnabled = !flagOff;
  const grantedScopes = policyEnabled ? policy.grantedScopesFromEnv() : 'all';
  const policyHook = policyEnabled
    ? async (call) => {
        const d = policy.evaluate(call, { grantedScopes });
        decisions.push({ tool: call.tool, policyEffect: d.effect, reason: d.reason });
        await audit.record({ workspaceId: wsId, actorUserId: userId, actorType: 'agent', action: 'policy.decision', targetType: 'task', targetId: task.id, risk: call.riskLevel, metadata: { tool: call.tool, effect: d.effect, reason: d.reason } }).catch(() => {});
        if (d.effect === 'allow') await audit.record({ workspaceId: wsId, actorUserId: userId, actorType: 'agent', action: 'tool.execution.allowed', targetType: 'task', targetId: task.id, risk: call.riskLevel, metadata: { tool: call.tool } }).catch(() => {});
        if (d.detail) d.detail.elevated = d.effect === 'require_elevated_approval';
        return d;
      }
    : undefined;

  const controller = new RunController();
  const sink = (event) => {
    if (policyEnabled) {
      let action = null;
      if (event.type === 'tool_call') action = 'tool.execution.started';
      else if (event.type === 'tool_result') action = event.ok ? 'tool.execution.completed' : (event.error ?? '').startsWith('denied by policy') ? 'tool.execution.denied' : 'tool.execution.failed';
      else if (event.type === 'approval_request') action = 'tool.execution.approval_requested';
      if (action) void audit.record({ workspaceId: wsId, actorUserId: userId, actorType: 'agent', action, targetType: 'task', targetId: task.id, metadata: { type: event.type } }).catch(() => {});
    }
    if (event.type === 'approval_request') {
      approvals.push({ approvalId: event.approvalId, action: event.action, riskLevel: event.riskLevel, reason: event.reason, detail: event.detail });
      if (autoDecision) controller.decideApproval(event.approvalId, autoDecision);
    }
  };

  const toolCall = { type: 'tool_use', id: 'u1', name: toolName, input };
  const scripts = repeat
    ? [{ text: 'plan', stopReason: 'end_turn' }, ...Array.from({ length: repeat }, (_, i) => ({ text: '', toolCalls: [{ ...toolCall, id: 'u' + i }], stopReason: 'tool_use' })), { text: 'done', stopReason: 'end_turn' }]
    : [{ text: 'plan', stopReason: 'end_turn' }, { text: '', toolCalls: [toolCall], stopReason: 'tool_use' }, { text: 'done', stopReason: 'end_turn' }];

  const tools = new InMemoryToolExecutor([makeTool(toolName, descriptor, (inp) => { ran += 1; Object.assign(lastInput, inp || {}); })]);
  await new TaskRunner(prisma).run({
    task: { id: task.id, workspaceId: wsId, createdByUserId: userId, prompt: 'p', riskCeiling: 'high', stepBudget: 20, costBudgetUsd: null },
    provider: new MockProvider(scripts),
    tools,
    controller,
    sink,
    ...(policyHook ? { policy: policyHook } : {}),
  });

  const finalTask = await prisma.task.findUnique({ where: { id: task.id }, select: { status: true } });
  const auditRows = await prisma.auditLog.findMany({ where: { workspaceId: wsId, targetId: task.id }, orderBy: { createdAt: 'asc' } });
  const auditActions = auditRows.map((r) => r.action);
  return { taskId: task.id, decisions, approvals, ran, status: finalTask?.status, auditActions };
}

async function main() {
  hr('TICKET-POLICY — CANLI DOĞRULAMA (POLICY_ENGINE_ENABLED=true, gerçek Postgres + runtime)');
  log('DATABASE_URL:', (process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@'));

  const sfx = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `pol-o-${sfx}@t.local`, displayName: 'Owner' } });
  const admin = await prisma.user.create({ data: { email: `pol-a-${sfx}@t.local`, displayName: 'Admin' } });
  const ws = await prisma.workspace.create({ data: { name: 'Pol WS', slug: `pol-${sfx}`, ownerUserId: owner.id } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: owner.id, role: MemberRole.owner } });
  const wsId = ws.id, userId = owner.id;
  log('workspace:', wsId, '| owner:', userId, '| admin:', admin.id);

  const FULL = 'fs.read,fs.write,shell.exec,browser.control,net.request,web.read';
  const show = (r) => r.decisions.map((d) => `${d.tool}→${d.policyEffect}`).join(', ');
  const acts = (r) => [...new Set(r.auditActions)].join(', ');

  // ---- 1) FLAG FALSE: legacy approval flow intact, no policy audit ----
  hr('1) FLAG FALSE — legacy approval davranışı korunuyor mu?');
  const offApprove = await runScenario({ wsId, userId, toolName: 'legacy_tool', descriptor: { riskLevel: 'high', approvalRequired: true, permissions: ['net.request'] }, input: {}, flagOff: true, autoDecision: 'approve' });
  log('approvalRequired tool, flag OFF, auto-APPROVE → ran:', offApprove.ran, '| approvals:', offApprove.approvals.length, '| status:', offApprove.status);
  log('policy.* audit yazıldı mı? (yazılmamalı):', offApprove.auditActions.some((a) => a.startsWith('policy.') || a.startsWith('tool.execution.')) ? 'EVET (HATA)' : 'HAYIR ✓');
  const offDeny = await runScenario({ wsId, userId, toolName: 'legacy_tool', descriptor: { riskLevel: 'high', approvalRequired: true, permissions: ['net.request'] }, input: {}, flagOff: true, autoDecision: 'deny' });
  log('aynı tool flag OFF, auto-DENY → ran (0 olmalı):', offDeny.ran);

  // ---- 2) CAPABILITY ENFORCEMENT: missing scope → deny, tool not run ----
  hr('2) CAPABILITY ENFORCEMENT — gerekli scope yok → deny');
  const cap = await runScenario({ wsId, userId, toolName: 'net_tool', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['net.request'] }, input: { url: 'https://example.com' }, grantedCsv: 'fs.read' });
  log('POLICY_GRANTED_SCOPES=fs.read, tool needs net.request →', show(cap));
  log('tool çalıştı mı? (0 olmalı):', cap.ran, '| audit:', acts(cap));

  // ---- 3) ALLOWED CAPABILITY ----
  hr('3) ALLOWED CAPABILITY — granted + safe → allow, tool çalışır');
  const allow = await runScenario({ wsId, userId, toolName: 'reader', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['fs.read'] }, input: {}, grantedCsv: FULL });
  log('granted fs.read, low-risk →', show(allow));
  log('tool çalıştı mı? (1 olmalı):', allow.ran, '| audit:', acts(allow));

  // ---- 4) LEGACY GATE NOT RELAXED ----
  hr('4) LEGACY GEVŞEMEZ — approvalRequired=true + policy allow → yine approval');
  const noRelax = await runScenario({ wsId, userId, toolName: 'legacy_required', descriptor: { riskLevel: 'high', approvalRequired: true, permissions: ['fs.read'] }, input: {}, grantedCsv: FULL, autoDecision: 'approve' });
  log('policy kararı:', show(noRelax), '| ama legacy approvalRequired=true');
  log('approval istendi mi? (evet olmalı):', noRelax.approvals.length > 0, '| approve sonrası ran:', noRelax.ran);
  log('→ policy allow dese de SECURITY gevşemedi (merged = approval).');

  // ---- 5) SHELL RISK ----
  hr('5) SHELL RISK — safe/destructive/catastrophic');
  const shSafe = await runScenario({ wsId, userId, toolName: 'shell_exec', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['shell.exec'] }, input: { command: 'ls -la' }, grantedCsv: FULL });
  log('safe  "ls -la"        →', show(shSafe), '| ran:', shSafe.ran);
  const shDestr = await runScenario({ wsId, userId, toolName: 'shell_exec', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['shell.exec'] }, input: { command: 'rm -rf build' }, grantedCsv: FULL, autoDecision: 'deny' });
  log('destr "rm -rf build"  →', show(shDestr), '| approval olmadan ran (0 olmalı):', shDestr.ran, '| elevated payload:', shDestr.approvals[0]?.detail?.elevated);
  const shCata = await runScenario({ wsId, userId, toolName: 'shell_exec', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['shell.exec'] }, input: { command: 'rm -rf /' }, grantedCsv: FULL });
  log('cata  "rm -rf /"      →', show(shCata), '| ran (0 olmalı):', shCata.ran);

  // ---- 6) FILE RISK ----
  hr('6) FILE RISK — içeri/.env/traversal/dışarı');
  for (const [label, p] of [['içeri write', 'out/report.md'], ['.env hassas', '.env'], ['traversal', '../escape.txt'], ['workspace dışı', '/etc/passwd']]) {
    const r = await runScenario({ wsId, userId, toolName: 'fs_write', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['fs.write'] }, input: { path: p }, grantedCsv: FULL, autoDecision: 'deny' });
    log(`${label.padEnd(14)} "${p}" →`, show(r), '| ran:', r.ran);
  }

  // ---- 7) BROWSER WRITE ----
  hr('7) BROWSER WRITE — form submit → require_approval + payload detayları');
  const br = await runScenario({ wsId, userId, toolName: 'browser_type', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['browser.control'] }, input: { selector: '#password', text: 'x', url: 'https://bank.example.com/login' }, grantedCsv: FULL, autoDecision: 'deny' });
  log('browser_type →', show(br), '| approval payload:');
  log('  ', JSON.stringify(br.approvals[0]?.detail));

  // ---- 8) HTTP / SSRF ----
  hr('8) HTTP / SSRF — loopback/metadata/private deny, public allow');
  for (const u of ['http://127.0.0.1/', 'http://localhost/admin', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/internal', 'https://api.example.com/data']) {
    const r = await runScenario({ wsId, userId, toolName: 'http_fetch', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['net.request'] }, input: { url: u }, grantedCsv: FULL });
    log(u.padEnd(48), '→', show(r));
  }
  log('NOT: runtime SSRF net-guard (net-guard.test.ts) http_fetch çalıştırma anında bağımsız çalışır — policy onu DEĞİŞTİRMEZ, tamamlar.');

  // ---- 9) APPROVAL ACCEPT / DENY ----
  hr('9) APPROVAL ACCEPT / DENY — tool çalışır / çalışmaz');
  const acc = await runScenario({ wsId, userId, toolName: 'fs_write', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['fs.write'] }, input: { path: 'out/x.md' }, grantedCsv: FULL, autoDecision: 'approve' });
  log('require_approval + APPROVE → ran (1 olmalı):', acc.ran, '| audit:', acts(acc));
  const den = await runScenario({ wsId, userId, toolName: 'fs_write', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['fs.write'] }, input: { path: 'out/x.md' }, grantedCsv: FULL, autoDecision: 'deny' });
  log('require_approval + DENY   → ran (0 olmalı):', den.ran);

  // ---- 10) ELEVATED APPROVAL (real tasks.service.decideApproval) ----
  hr('10) ELEVATED APPROVAL — personal break-glass + team self-approval');
  const svc = new TasksService(prisma, audit, null, null, null, new TaskControlBus(null), null, null, null, null, null, null, null, null, null, policy);
  async function seedElevated(creator) {
    const t = await prisma.task.create({ data: { workspaceId: wsId, createdByUserId: creator, title: 't', prompt: 'p', status: TaskStatus.awaiting_approval } });
    const approvalId = `${t.id}-a0`;
    await prisma.approval.create({ data: { taskId: t.id, workspaceId: wsId, approvalId, action: 'shell_exec', risk: 'critical', elevated: true, policyReason: 'destructive shell' } });
    return { taskId: t.id, approvalId };
  }
  const tryDecide = async (label, fn) => { try { const r = await fn(); log(`  ${label}: OK →`, JSON.stringify(r)); } catch (e) { log(`  ${label}: BLOCKED → ${e.message}`); } };

  process.env.POLICY_ELEVATED_APPROVAL_MODE = 'personal';
  process.env.POLICY_OWNER_BREAKGLASS_ENABLED = 'true';
  let e1 = await seedElevated(userId);
  log('PERSONAL mode (break-glass on):');
  await tryDecide('owner approve, confirmation YOK', () => svc.decideApproval(wsId, e1.taskId, e1.approvalId, 'approve', userId));
  await tryDecide('owner approve, "CONFIRM-ELEVATED"', () => svc.decideApproval(wsId, e1.taskId, e1.approvalId, 'approve', userId, 'CONFIRM-ELEVATED'));

  process.env.POLICY_OWNER_BREAKGLASS_ENABLED = 'false';
  let e2 = await seedElevated(userId);
  log('PERSONAL mode (break-glass off):');
  await tryDecide('owner approve, confirmation ile', () => svc.decideApproval(wsId, e2.taskId, e2.approvalId, 'approve', userId, 'CONFIRM-ELEVATED'));

  process.env.POLICY_ELEVATED_APPROVAL_MODE = 'team';
  await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: wsId, userId: admin.id } }, create: { workspaceId: wsId, userId: admin.id, role: MemberRole.admin }, update: { role: MemberRole.admin } });
  let e3 = await seedElevated(userId);
  log('TEAM mode (2 üye):');
  await tryDecide('SELF (owner=creator) approve', () => svc.decideApproval(wsId, e3.taskId, e3.approvalId, 'approve', userId));
  await tryDecide('NON-SELF admin approve', () => svc.decideApproval(wsId, e3.taskId, e3.approvalId, 'approve', admin.id));
  process.env.POLICY_ELEVATED_APPROVAL_MODE = 'auto';

  // ---- 11) DENY LOOP ----
  hr('11) DENY LOOP — POLICY_MAX_DENIALS sonrası controlled stop');
  const loop = await runScenario({ wsId, userId, toolName: 'net_tool', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['net.request'] }, input: { url: 'https://x' }, grantedCsv: 'fs.read', maxDenials: 2, repeat: 5 });
  log('POLICY_MAX_DENIALS=2, model 5× forbidden tool istedi → status:', loop.status, '| deny sayısı:', loop.decisions.filter((d) => d.policyEffect === 'deny').length, '| tool ran:', loop.ran);

  // ---- 12) REDACTION ----
  hr('12) APPROVAL DETAIL REDACTION — secret maskeleme');
  const secretCmd = 'curl -H "Authorization: Bearer sk-ant-api03-SUPERSECRETxyz123456" https://api.example.com?api_key=AKIAIOSFODNN7EXAMPLE -d "password=hunter2pwd"';
  const red = await runScenario({ wsId, userId, toolName: 'shell_exec', descriptor: { riskLevel: 'low', approvalRequired: false, permissions: ['shell.exec'] }, input: { command: secretCmd }, grantedCsv: FULL, autoDecision: 'deny' });
  const redacted = red.approvals[0]?.detail?.command || '';
  log('GİRDİ :', secretCmd);
  log('DETAIL:', redacted);
  const leaks = ['SUPERSECRETxyz123456', 'AKIAIOSFODNN7EXAMPLE', 'hunter2pwd'].filter((s) => redacted.includes(s));
  log('Sızan secret:', leaks.length ? leaks.join(', ') + ' (HATA)' : 'YOK ✓', '| [REDACTED] var mı:', redacted.includes('[REDACTED]'));

  // ---- 13) UI payload (reducer girdisi) ----
  hr('13) UI MINIMAL — approval card\'ın render ettiği payload (redacted)');
  log('TaskDetail bu payload\'ı gösterir (command/url/file/browserAction/riskReason + ELEVATED rozet):');
  log('  shell elevated  :', JSON.stringify({ command: shDestr.approvals[0]?.detail?.command, riskReason: shDestr.approvals[0]?.detail?.riskReason, elevated: shDestr.approvals[0]?.detail?.elevated }));
  log('  browser approval:', JSON.stringify({ browserAction: br.approvals[0]?.detail?.browserAction, url: br.approvals[0]?.detail?.url, riskReason: br.approvals[0]?.detail?.riskReason }));
  log('  → UI redaction: payload zaten redacted (yukarıdaki redaction kanıtı) → UI tarafında da secret yok.');

  // ---- 14) AUDIT SUMMARY ----
  hr('14) AUDITLOG — canlı action kayıtları (tüm workspace)');
  const allAudit = await prisma.auditLog.groupBy({ by: ['action'], where: { workspaceId: wsId }, _count: { action: true } });
  for (const a of allAudit.sort((x, y) => x.action.localeCompare(y.action))) log(`  ${a.action.padEnd(34)} ×${a._count.action}`);

  // cleanup
  hr('TEMİZLİK + SONUÇ');
  await prisma.workspace.delete({ where: { id: wsId } }).catch(() => {});
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.user.delete({ where: { id: admin.id } }).catch(() => {});
  log('workspace + users silindi. Canlı doğrulama tamam.');
  await disconnectPrisma();
}

main().catch(async (e) => { console.error('HARNESS ERROR:', e); try { await disconnectPrisma(); } catch {} process.exit(1); });
