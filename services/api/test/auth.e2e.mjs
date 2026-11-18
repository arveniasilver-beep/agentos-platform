#!/usr/bin/env node
// End-to-end auth test against a RUNNING api server (real Nest+Fastify + live Postgres).
// Usage: API_BASE=http://localhost:4099 DATABASE_URL=... node test/auth.e2e.mjs
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

const email = `e2e-${Date.now().toString(36)}@test.local`;
const password = 'sup3rsecret!';

// register
let res = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, displayName: 'E2E User' }),
});
ok(res.status === 201 || res.status === 200, `register -> ${res.status}`);
let body = await json(res);
ok(body?.user?.email === email, 'register returns the user');
const cookie = cookieOf(res);
ok(Boolean(cookie), 'register sets a session cookie');

// authed /me
res = await fetch(`${BASE}/auth/me`, { headers: { cookie } });
ok(res.status === 200, `me (authed) -> ${res.status}`);
body = await json(res);
ok(body?.user?.email === email, 'me returns the authenticated user');

// unauthenticated /me
res = await fetch(`${BASE}/auth/me`);
ok(res.status === 401, `me (no cookie) -> ${res.status} (expect 401)`);

// logout
res = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie } });
ok(res.status === 200 || res.status === 201, `logout -> ${res.status}`);

// /me after logout (session destroyed)
res = await fetch(`${BASE}/auth/me`, { headers: { cookie } });
ok(res.status === 401, `me after logout -> ${res.status} (expect 401)`);

// login
res = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
ok(res.status === 201 || res.status === 200, `login -> ${res.status}`);
const cookie2 = cookieOf(res);
ok(Boolean(cookie2), 'login sets a new cookie');
res = await fetch(`${BASE}/auth/me`, { headers: { cookie: cookie2 } });
ok(res.status === 200, 'me works after login');

// wrong password
res = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password: 'wrong-password' }),
});
ok(res.status === 401, `login wrong password -> ${res.status} (expect 401)`);

// validation failure
res = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'not-an-email', password: 'x', displayName: '' }),
});
ok(res.status === 400, `register invalid -> ${res.status} (expect 400)`);

// cleanup test user
try {
  const { getPrisma, disconnectPrisma } = await import('@agentos/db');
  const prisma = getPrisma();
  await prisma.user.deleteMany({ where: { email } });
  await disconnectPrisma();
  console.log('  ✓ cleaned up test user');
} catch (e) {
  console.error('  (cleanup skipped: ' + e.message + ')');
}

if (failures > 0) {
  console.error(`\nAUTH E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAUTH E2E PASSED');
