#!/usr/bin/env node
// E2E for the agent task API (create -> run -> events -> metering), against a running api + live
// Postgres. Requires the server booted with LLM_MODE=mock so the engine runs without a real key.
const BASE = process.env.API_BASE || 'http://localhost:4099';
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    console.error('  ✗ ' + msg);
    failures++;
  }
};
const cookieOf = (res) => {
  const sc = res.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : null;
};
async function register(email) {
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'sup3rsecret!', displayName: email }),
  });
  return cookieOf(res);
}
const api = (cookie, path, method = 'GET', body) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = Date.now().toString(36);
const emailA = `taskA-${tag}@test.local`;
const emailB = `taskB-${tag}@test.local`;
const slug = `task-${tag}`;

const cookieA = await register(emailA);
const cookieB = await register(emailB);

let res = await api(cookieA, '/workspaces', 'POST', { name: 'Task WS', slug });
const ws = await res.json();
const wsId = ws.id;

// a task referencing a project that isn't in this workspace is rejected
res = await api(cookieA, `/workspaces/${wsId}/tasks`, 'POST', {
  title: 'bad project',
  prompt: 'x',
  projectId: '00000000-0000-0000-0000-000000000000',
});
ok(res.status === 404, `task with foreign/bogus projectId -> ${res.status} (expect 404)`);

// --- create + run a task ---
res = await api(cookieA, `/workspaces/${wsId}/tasks`, 'POST', {
  title: 'Smoke task',
  prompt: 'Say hello and finish.',
});
ok(res.status === 201 || res.status === 200, `create task -> ${res.status}`);
const task = await res.json();
ok(Boolean(task.id), 'task has an id');

// non-member is denied (B was never added to the workspace)
res = await api(cookieB, `/workspaces/${wsId}/tasks`);
ok(res.status === 403, `non-member lists tasks -> ${res.status} (expect 403)`);

// poll until terminal
let final = null;
for (let i = 0; i < 60; i++) {
  res = await api(cookieA, `/workspaces/${wsId}/tasks/${task.id}`);
  final = await res.json();
  if (['completed', 'failed', 'stopped'].includes(final.status)) break;
  await sleep(250);
}
ok(final && final.status === 'completed', `task reaches completed (got ${final && final.status})`);
ok(final && Number(final.estCostUsd) > 0, 'task records a non-zero estimated cost');
ok(final && final.finishedAt, 'task has a finishedAt timestamp');

// --- events were persisted, seq-ordered, with plan + final_output ---
res = await api(cookieA, `/workspaces/${wsId}/tasks/${task.id}/events`);
const events = await res.json();
ok(Array.isArray(events) && events.length > 0, `events persisted (${events.length})`);
const seqs = events.map((e) => e.seq);
ok(
  seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
  'events are strictly seq-ordered',
);
const types = events.map((e) => e.type);
ok(types.includes('plan'), 'events include a plan');
ok(types.includes('final_output'), 'events include a final_output');

// incremental fetch (afterSeq) returns a strict suffix
res = await api(cookieA, `/workspaces/${wsId}/tasks/${task.id}/events?afterSeq=0`);
const tail = await res.json();
ok(tail.every((e) => e.seq > 0), 'afterSeq=0 returns only seq > 0');

// --- stop is idempotent + audited (flags the row even post-completion) ---
res = await api(cookieA, `/workspaces/${wsId}/tasks/${task.id}/stop`, 'POST');
ok(res.status === 200 || res.status === 201, `stop -> ${res.status}`);
const stopped = await res.json();
ok(stopped.killRequested === true, 'stop sets killRequested');

// --- audit + metering at rest ---
res = await api(cookieA, `/workspaces/${wsId}/audit`);
const audit = await res.json();
ok(audit.chainValid === true, 'audit chain valid');
const actions = (audit.entries || []).map((e) => e.action);
ok(actions.includes('task.create'), 'audit has task.create');
ok(actions.includes('task.stop'), 'audit has task.stop');

let prisma;
try {
  const db = await import('@agentos/db');
  prisma = db.getPrisma();
  const usage = await prisma.usageRecord.findFirst({ where: { taskId: task.id } });
  ok(Boolean(usage), 'usage_record row exists');
  const cost = await prisma.costRecord.findFirst({ where: { taskId: task.id } });
  ok(Boolean(cost), 'cost_record row exists');
} catch (e) {
  ok(false, 'metering DB check: ' + e.message);
}

// cleanup
try {
  if (!prisma) {
    const db = await import('@agentos/db');
    prisma = db.getPrisma();
  }
  await prisma.usageRecord.deleteMany({ where: { workspaceId: wsId } });
  await prisma.costRecord.deleteMany({ where: { workspaceId: wsId } });
  await prisma.workspace.deleteMany({ where: { slug } });
  await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
  await import('@agentos/db').then((m) => m.disconnectPrisma());
  console.log('  ✓ cleaned up');
} catch (e) {
  console.error('  (cleanup skipped: ' + e.message + ')');
}

if (failures > 0) {
  console.error(`\nTASKS E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nTASKS E2E PASSED');
