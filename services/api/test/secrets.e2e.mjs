#!/usr/bin/env node
// E2E for the secrets vault + audit log, against a running api + live Postgres.
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

const tag = Date.now().toString(36);
const emailA = `secA-${tag}@test.local`;
const emailB = `secB-${tag}@test.local`;
const slug = `sec-${tag}`;
const apiKey = `sk-ant-${tag}-SUPERSECRET-ABCD1234`;

const cookieA = await register(emailA);
const cookieB = await register(emailB);

let res = await api(cookieA, '/workspaces', 'POST', { name: 'Sec WS', slug });
const ws = await res.json();
const wsId = ws.id;
await api(cookieA, `/workspaces/${wsId}/members`, 'POST', { email: emailB, role: 'member' });

// member cannot set the key
res = await api(cookieB, `/workspaces/${wsId}/settings/llm-key`, 'PUT', { apiKey });
ok(res.status === 403, `member sets key -> ${res.status} (expect 403)`);

// admin sets the key; response must NOT leak the key
res = await api(cookieA, `/workspaces/${wsId}/settings/llm-key`, 'PUT', { apiKey });
ok(res.status === 200, `admin sets key -> ${res.status}`);
let raw = await res.text();
ok(!raw.includes(apiKey), 'set response does NOT contain the plaintext key');
ok(raw.includes('1234'), 'set response exposes only lastFour (1234)');

// member can read masked info (no key)
res = await api(cookieB, `/workspaces/${wsId}/settings/llm-key`);
raw = await res.text();
ok(res.status === 200 && !raw.includes(apiKey) && raw.includes('1234'), 'GET key info is masked (lastFour only)');

// at-rest: stored as ciphertext, never plaintext
let prisma;
try {
  const db = await import('@agentos/db');
  prisma = db.getPrisma();
  const secret = await prisma.secret.findFirst({ where: { workspaceId: wsId, type: 'llm_api_key' } });
  ok(Boolean(secret), 'secret row exists');
  ok(secret && Buffer.from(secret.ciphertext).toString('utf8') !== apiKey, 'ciphertext != plaintext (encrypted at rest)');
  ok(secret && !Buffer.from(secret.ciphertext).toString('latin1').includes('SUPERSECRET'), 'plaintext substring absent from ciphertext');
  ok(secret && secret.lastFour === '1234', 'stored lastFour = 1234');
} catch (e) {
  ok(false, 'at-rest DB check: ' + e.message);
}

// audit chain valid + contains the sensitive actions
res = await api(cookieA, `/workspaces/${wsId}/audit`);
const audit = await res.json();
ok(res.status === 200 && audit.chainValid === true, 'audit chain is valid');
const actions = (audit.entries || []).map((e) => e.action);
ok(actions.includes('workspace.create'), 'audit has workspace.create');
ok(actions.includes('member.add'), 'audit has member.add');
ok(actions.includes('secret.set'), 'audit has secret.set');

// delete the key (admin), then it reads as not configured
res = await api(cookieA, `/workspaces/${wsId}/settings/llm-key`, 'DELETE');
ok(res.status === 200, `admin deletes key -> ${res.status}`);
res = await api(cookieA, `/workspaces/${wsId}/settings/llm-key`);
const info = await res.json();
ok(info.configured === false, 'key reads as not configured after delete');
res = await api(cookieA, `/workspaces/${wsId}/audit`);
const audit2 = await res.json();
ok(audit2.chainValid === true && audit2.entries.some((e) => e.action === 'secret.delete'), 'audit still valid + has secret.delete');

// cleanup
try {
  if (!prisma) {
    const db = await import('@agentos/db');
    prisma = db.getPrisma();
  }
  await prisma.workspace.deleteMany({ where: { slug } });
  await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
  await import('@agentos/db').then((m) => m.disconnectPrisma());
  console.log('  ✓ cleaned up');
} catch (e) {
  console.error('  (cleanup skipped: ' + e.message + ')');
}

if (failures > 0) {
  console.error(`\nSECRETS E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nSECRETS E2E PASSED');
