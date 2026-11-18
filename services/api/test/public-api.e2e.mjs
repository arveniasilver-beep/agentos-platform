#!/usr/bin/env node
// E2E for the public API: an admin mints an API key (cookie-authed), then drives /v1 with the
// Bearer token; revocation + bad tokens are rejected. Against a running api + live Postgres (mock LLM).
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
const bearer = (token, path, method = 'GET', body) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const tag = Date.now().toString(36);
const email = `apiE-${tag}@test.local`;
const slug = `apie-${tag}`;

const cookie = await register(email);
let res = await api(cookie, '/workspaces', 'POST', { name: 'API E2E', slug });
const ws = await res.json();
const wsId = ws.id;

// mint a key
res = await api(cookie, `/workspaces/${wsId}/api-keys`, 'POST', { label: 'ci' });
ok(res.status === 201 || res.status === 200, `create api key -> ${res.status}`);
const created = await res.json();
const token = created.token;
ok(typeof token === 'string' && token.startsWith('aos_'), 'returns a plaintext token once (aos_...)');

// no token / bad token are rejected
res = await bearer('', '/v1/tasks', 'GET');
ok(res.status === 401, `no token -> ${res.status} (expect 401)`);
res = await bearer('aos_bogus.bogus', '/v1/tasks', 'GET');
ok(res.status === 401, `bad token -> ${res.status} (expect 401)`);

// create a task via the public API
res = await bearer(token, '/v1/tasks', 'POST', { title: 'via api', prompt: 'do it' });
ok(res.status === 201 || res.status === 200, `POST /v1/tasks -> ${res.status}`);
const task = await res.json();
ok(Boolean(task.id), 'public API created a task');

// poll it via the public API
let final = null;
for (let i = 0; i < 60; i++) {
  res = await bearer(token, `/v1/tasks/${task.id}`, 'GET');
  final = await res.json();
  if (['completed', 'failed', 'stopped'].includes(final.status)) break;
  await sleep(250);
}
ok(final && final.status === 'completed', `task completed via public API (got ${final && final.status})`);

// list via the public API
res = await bearer(token, '/v1/tasks', 'GET');
const list = await res.json();
ok(Array.isArray(list) && list.some((t) => t.id === task.id), 'GET /v1/tasks lists the task');

// management: list keys (no secret leaked) + revoke
res = await api(cookie, `/workspaces/${wsId}/api-keys`);
const keys = await res.json();
ok(Array.isArray(keys) && keys.length === 1 && !JSON.stringify(keys).includes(token.split('.')[1]), 'key list does not leak the secret');
res = await api(cookie, `/workspaces/${wsId}/api-keys/${created.id}`, 'DELETE');
ok(res.status === 200, `revoke key -> ${res.status}`);

// revoked token no longer works
res = await bearer(token, '/v1/tasks', 'GET');
ok(res.status === 401, `revoked token -> ${res.status} (expect 401)`);

// audit
res = await api(cookie, `/workspaces/${wsId}/audit`);
const audit = await res.json();
const actions = (audit.entries || []).map((e) => e.action);
ok(audit.chainValid === true, 'audit chain valid');
ok(actions.includes('apikey.create') && actions.includes('apikey.revoke'), 'audit has apikey.create + apikey.revoke');

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
  console.error(`\nPUBLIC API E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nPUBLIC API E2E PASSED');
