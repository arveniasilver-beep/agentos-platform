#!/usr/bin/env node
// E2E for the automations API: CRUD + run-now (which creates and runs a task). Against a running
// api + live Postgres; LLM_MODE=mock so the triggered task completes without a key.
const BASE = process.env.API_BASE || 'http://localhost:4099';
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    console.error('  ✗ ' + msg);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const tag = Date.now().toString(36);
const email = `autoE-${tag}@test.local`;
const slug = `autoe-${tag}`;

const cookie = await register(email);
let res = await api(cookie, '/workspaces', 'POST', { name: 'Auto E2E WS', slug });
const ws = await res.json();
const wsId = ws.id;

// invalid cron rejected
res = await api(cookie, `/workspaces/${wsId}/automations`, 'POST', {
  name: 'bad',
  prompt: 'x',
  cronExpression: 'not a cron',
});
ok(res.status === 400, `invalid cron -> ${res.status} (expect 400)`);

// create a valid automation
res = await api(cookie, `/workspaces/${wsId}/automations`, 'POST', {
  name: 'Daily digest',
  prompt: 'Summarize the day.',
  cronExpression: '0 9 * * *',
  timezone: 'UTC',
});
ok(res.status === 201 || res.status === 200, `create automation -> ${res.status}`);
const auto = await res.json();
ok(Boolean(auto.id) && auto.enabled === true, 'automation created + enabled');

// list contains it
res = await api(cookie, `/workspaces/${wsId}/automations`);
const list = await res.json();
ok(Array.isArray(list) && list.some((a) => a.id === auto.id), 'automation appears in the list');

// run now -> creates a task
res = await api(cookie, `/workspaces/${wsId}/automations/${auto.id}/run`, 'POST');
ok(res.status === 200 || res.status === 201, `run-now -> ${res.status}`);
const run = await res.json();
ok(Boolean(run.taskId), 'run-now returned a taskId');

// the triggered task reaches a terminal state
let final = null;
for (let i = 0; i < 60; i++) {
  res = await api(cookie, `/workspaces/${wsId}/tasks/${run.taskId}`);
  final = await res.json();
  if (['completed', 'failed', 'stopped'].includes(final.status)) break;
  await sleep(250);
}
ok(final && final.status === 'completed', `triggered task completed (got ${final && final.status})`);
ok(final && final.title === 'Daily digest', 'triggered task carries the automation name');

// disable via PATCH
res = await api(cookie, `/workspaces/${wsId}/automations/${auto.id}`, 'PATCH', { enabled: false });
ok(res.status === 200, `disable -> ${res.status}`);
const disabled = await res.json();
ok(disabled.enabled === false, 'automation disabled');

// audit trail
res = await api(cookie, `/workspaces/${wsId}/audit`);
const audit = await res.json();
const actions = (audit.entries || []).map((e) => e.action);
ok(audit.chainValid === true, 'audit chain valid');
ok(actions.includes('automation.create'), 'audit has automation.create');
ok(actions.includes('automation.run_now'), 'audit has automation.run_now');

// delete
res = await api(cookie, `/workspaces/${wsId}/automations/${auto.id}`, 'DELETE');
ok(res.status === 200, `delete -> ${res.status}`);
res = await api(cookie, `/workspaces/${wsId}/automations/${auto.id}`);
ok(res.status === 404, `deleted automation gone -> ${res.status} (expect 404)`);

// cleanup
try {
  const db = await import('@agentos/db');
  const prisma = db.getPrisma();
  await prisma.usageRecord.deleteMany({ where: { workspaceId: wsId } });
  await prisma.costRecord.deleteMany({ where: { workspaceId: wsId } });
  await prisma.workspace.deleteMany({ where: { slug } });
  await prisma.user.deleteMany({ where: { email } });
  await db.disconnectPrisma();
  console.log('  ✓ cleaned up');
} catch (e) {
  console.error('  (cleanup skipped: ' + e.message + ')');
}

if (failures > 0) {
  console.error(`\nAUTOMATIONS E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAUTOMATIONS E2E PASSED');
