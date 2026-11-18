#!/usr/bin/env node
// E2E for the artifact API: a file placed in a task's sandbox dir is listed + downloadable over
// HTTP, traversal is refused. Against a running api + live Postgres (same host, so the sandbox
// path is shared). LLM_MODE=mock.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.API_BASE || 'http://localhost:4099';
// Must match the server's ToolsFactory/ArtifactsService default when AGENT_SANDBOX_ROOT is unset.
const SANDBOX_ROOT = process.env.AGENT_SANDBOX_ROOT || join(tmpdir(), 'agentos-sandbox');
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
const email = `artE-${tag}@test.local`;
const slug = `arte-${tag}`;

const cookie = await register(email);
let res = await api(cookie, '/workspaces', 'POST', { name: 'Artifact E2E', slug });
const ws = await res.json();
const wsId = ws.id;
res = await api(cookie, `/workspaces/${wsId}/tasks`, 'POST', { title: 'Make a report', prompt: 'x' });
const task = await res.json();

// Simulate the agent writing a file into its sandbox dir.
const dir = join(SANDBOX_ROOT, task.id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'report.txt'), 'AGENTOS REPORT 42', 'utf8');

// list
res = await api(cookie, `/workspaces/${wsId}/tasks/${task.id}/artifacts`);
const list = await res.json();
ok(res.status === 200 && Array.isArray(list), `list artifacts -> ${res.status}`);
ok(list.some((a) => a.path === 'report.txt'), 'report.txt is listed');

// download
res = await api(cookie, `/workspaces/${wsId}/tasks/${task.id}/artifacts/download?path=report.txt`);
const body = await res.text();
ok(res.status === 200 && body === 'AGENTOS REPORT 42', 'download returns the file contents');
ok((res.headers.get('content-disposition') || '').includes('report.txt'), 'download sets a filename');

// traversal refused
res = await api(cookie, `/workspaces/${wsId}/tasks/${task.id}/artifacts/download?path=${encodeURIComponent('../../../etc/passwd')}`);
ok(res.status === 404, `path traversal refused -> ${res.status} (expect 404)`);

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
  console.error(`\nARTIFACTS E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nARTIFACTS E2E PASSED');
