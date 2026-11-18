#!/usr/bin/env node
// E2E for workspaces + RBAC + tenancy isolation, against a running api + live Postgres.
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
const json = (res) => res.json().catch(() => ({}));

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
const emailA = `wsA-${tag}@test.local`;
const emailB = `wsB-${tag}@test.local`;
const slug = `ws-${tag}`;

const cookieA = await register(emailA);
const cookieB = await register(emailB);
ok(Boolean(cookieA && cookieB), 'registered two users');

// A creates a workspace
let res = await api(cookieA, '/workspaces', 'POST', { name: 'Team A', slug });
ok(res.status === 201, `A creates workspace -> ${res.status}`);
const ws = await json(res);
const wsId = ws?.id;
ok(Boolean(wsId), 'workspace has an id');

// A sees it; B does not (tenancy in list)
res = await api(cookieA, '/workspaces');
let list = await json(res);
ok(Array.isArray(list) && list.some((w) => w.id === wsId), 'A lists own workspace');
res = await api(cookieB, '/workspaces');
list = await json(res);
ok(Array.isArray(list) && !list.some((w) => w.id === wsId), "B's list excludes A's workspace");

// A can GET it (owner); B cannot (not a member -> 403)
res = await api(cookieA, `/workspaces/${wsId}`);
ok(res.status === 200, `A GET workspace -> ${res.status}`);
res = await api(cookieB, `/workspaces/${wsId}`);
ok(res.status === 403, `B GET workspace -> ${res.status} (expect 403, tenancy)`);

// A adds B as a member
res = await api(cookieA, `/workspaces/${wsId}/members`, 'POST', { email: emailB, role: 'member' });
ok(res.status === 201, `A adds B as member -> ${res.status}`);

// Now B can GET it
res = await api(cookieB, `/workspaces/${wsId}`);
ok(res.status === 200, `B GET workspace after join -> ${res.status}`);

// B (member) cannot add members (needs admin) -> 403
res = await api(cookieB, `/workspaces/${wsId}/members`, 'POST', { email: emailA, role: 'viewer' });
ok(res.status === 403, `B (member) add member -> ${res.status} (expect 403, RBAC)`);

// A creates a project; B (member) can list and create
res = await api(cookieA, `/workspaces/${wsId}/projects`, 'POST', { name: 'Project X' });
ok(res.status === 201, `A creates project -> ${res.status}`);
res = await api(cookieB, `/workspaces/${wsId}/projects`);
const projects = await json(res);
ok(Array.isArray(projects) && projects.length >= 1, 'B lists projects');
res = await api(cookieB, `/workspaces/${wsId}/projects`, 'POST', { name: 'Project Y' });
ok(res.status === 201, `B (member) creates project -> ${res.status}`);

// A non-member (fresh user C) is blocked from the project list -> 403
const emailC = `wsC-${tag}@test.local`;
const cookieC = await register(emailC);
res = await api(cookieC, `/workspaces/${wsId}/projects`);
ok(res.status === 403, `C (non-member) lists projects -> ${res.status} (expect 403)`);

// --- member management (collaboration) ---
res = await api(cookieA, `/workspaces/${wsId}/members`);
const members = await json(res);
const owner = Array.isArray(members) ? members.find((m) => m.role === 'owner') : null;
const bMember = Array.isArray(members) ? members.find((m) => m.user?.email === emailB) : null;
ok(Boolean(owner && bMember), 'members list includes the owner and B');

// A promotes B to admin
res = await api(cookieA, `/workspaces/${wsId}/members/${bMember.userId}`, 'PATCH', { role: 'admin' });
ok(res.status === 200, `A promotes B to admin -> ${res.status}`);

// role superiority: B (admin) cannot grant the admin role (only owner manages admins)...
res = await api(cookieB, `/workspaces/${wsId}/members`, 'POST', { email: emailC, role: 'admin' });
ok(res.status === 403, `B (admin) invites C as admin -> ${res.status} (expect 403)`);
// ...but can invite a strictly-lower role
res = await api(cookieB, `/workspaces/${wsId}/members`, 'POST', { email: emailC, role: 'viewer' });
ok(res.status === 201, `B (admin) invites C as viewer -> ${res.status}`);

// the owner is protected from role change + removal
res = await api(cookieA, `/workspaces/${wsId}/members/${owner.userId}`, 'PATCH', { role: 'admin' });
ok(res.status === 403, `change owner role -> ${res.status} (expect 403)`);
res = await api(cookieA, `/workspaces/${wsId}/members/${owner.userId}`, 'DELETE');
ok(res.status === 403, `remove owner -> ${res.status} (expect 403)`);

// A removes B; B loses access
res = await api(cookieA, `/workspaces/${wsId}/members/${bMember.userId}`, 'DELETE');
ok(res.status === 200, `A removes B -> ${res.status}`);
res = await api(cookieB, `/workspaces/${wsId}`);
ok(res.status === 403, `B GET workspace after removal -> ${res.status} (expect 403)`);

// cleanup
try {
  const { getPrisma, disconnectPrisma } = await import('@agentos/db');
  const prisma = getPrisma();
  await prisma.workspace.deleteMany({ where: { slug } });
  await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB, emailC] } } });
  await disconnectPrisma();
  console.log('  ✓ cleaned up');
} catch (e) {
  console.error('  (cleanup skipped: ' + e.message + ')');
}

if (failures > 0) {
  console.error(`\nWORKSPACES E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nWORKSPACES E2E PASSED');
