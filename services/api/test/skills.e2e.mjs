#!/usr/bin/env node
// E2E for the skills API: CRUD + run (which renders the template and runs a task). Against a
// running api + live Postgres; LLM_MODE=mock so the spawned task completes.
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
const email = `skillE-${tag}@test.local`;
const slug = `skille-${tag}`;

const cookie = await register(email);
let res = await api(cookie, '/workspaces', 'POST', { name: 'Skill E2E', slug });
const ws = await res.json();
const wsId = ws.id;

// create
res = await api(cookie, `/workspaces/${wsId}/skills`, 'POST', {
  name: 'Summarize',
  instructions: 'Summarize {{input}} concisely.',
});
ok(res.status === 201 || res.status === 200, `create skill -> ${res.status}`);
const skill = await res.json();
ok(Boolean(skill.id), 'skill created');

// list
res = await api(cookie, `/workspaces/${wsId}/skills`);
const list = await res.json();
ok(Array.isArray(list) && list.some((s) => s.id === skill.id), 'skill appears in the list');

// run -> creates a task
res = await api(cookie, `/workspaces/${wsId}/skills/${skill.id}/run`, 'POST', { input: 'the news' });
ok(res.status === 201 || res.status === 200, `run skill -> ${res.status}`);
const task = await res.json();
ok(Boolean(task.id) && task.title === 'Summarize', 'run created a task titled after the skill');

// the spawned task reaches a terminal state
let final = null;
for (let i = 0; i < 60; i++) {
  res = await api(cookie, `/workspaces/${wsId}/tasks/${task.id}`);
  final = await res.json();
  if (['completed', 'failed', 'stopped'].includes(final.status)) break;
  await sleep(250);
}
ok(final && final.status === 'completed', `spawned task completed (got ${final && final.status})`);

// the rendered prompt substituted the input
ok(final && final.prompt === 'Summarize the news concisely.', 'prompt rendered with {{input}}');

// empty-render guard: a {{input}}-only skill run with no input is refused (non-empty-prompt invariant)
res = await api(cookie, `/workspaces/${wsId}/skills`, 'POST', { name: 'echo', instructions: '{{input}}' });
const echo = await res.json();
res = await api(cookie, `/workspaces/${wsId}/skills/${echo.id}/run`, 'POST', {});
ok(res.status === 400, `run {{input}}-only skill with no input -> ${res.status} (expect 400)`);

// audit
res = await api(cookie, `/workspaces/${wsId}/audit`);
const audit = await res.json();
const actions = (audit.entries || []).map((e) => e.action);
ok(audit.chainValid === true, 'audit chain valid');
ok(actions.includes('skill.create'), 'audit has skill.create');
ok(actions.includes('skill.run'), 'audit has skill.run');

// delete
res = await api(cookie, `/workspaces/${wsId}/skills/${skill.id}`, 'DELETE');
ok(res.status === 200, `delete -> ${res.status}`);
res = await api(cookie, `/workspaces/${wsId}/skills/${skill.id}`);
ok(res.status === 404, `deleted skill gone -> ${res.status} (expect 404)`);

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
  console.error(`\nSKILLS E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nSKILLS E2E PASSED');
