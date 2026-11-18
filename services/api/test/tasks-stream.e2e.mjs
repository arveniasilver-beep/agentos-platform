#!/usr/bin/env node
// E2E for the live task event gateway (Socket.IO): auth via session cookie, workspace-membership
// gating, backlog replay, and the stop control message. Against a running api + live Postgres.
import { io } from 'socket.io-client';

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
const connect = (cookie, taskId) =>
  io(BASE, {
    extraHeaders: cookie ? { Cookie: cookie } : {},
    query: { taskId },
    reconnection: false,
    timeout: 5000,
    transports: ['polling', 'websocket'],
  });
async function waitFor(pred, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

const tag = Date.now().toString(36);
const emailA = `strmA-${tag}@test.local`;
const emailB = `strmB-${tag}@test.local`;
const slug = `strm-${tag}`;

const cookieA = await register(emailA);
const cookieB = await register(emailB);

let res = await api(cookieA, '/workspaces', 'POST', { name: 'Stream WS', slug });
const ws = await res.json();
const wsId = ws.id;

res = await api(cookieA, `/workspaces/${wsId}/tasks`, 'POST', {
  title: 'Stream task',
  prompt: 'Stream some events and finish.',
});
const task = await res.json();
ok(Boolean(task.id), 'task created for streaming');

// --- authorized client receives the event stream (backlog + live) ---
const events = [];
const socket = connect(cookieA, task.id);
socket.on('agent_event', (e) => events.push(e));
let connected = false;
socket.on('connect', () => {
  connected = true;
});
await waitFor(() => connected, 5000);
ok(connected, 'authorized socket connected');

const gotFinal = await waitFor(() => events.some((e) => e.type === 'final_output'), 10000);
ok(gotFinal, 'received final_output over the socket');
ok(
  events.some((e) => e.type === 'plan'),
  'received the plan over the socket',
);
ok(
  events.every((e) => typeof e.seq === 'number'),
  'every streamed event carries a seq',
);

// --- stop control message is acked over the socket ---
const ack = await new Promise((resolve) => {
  socket.emit('client_message', { type: 'stop', taskId: task.id }, resolve);
  setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 4000);
});
ok(ack && ack.ok === true, `stop control acked ok (got ${JSON.stringify(ack)})`);

// --- a control message for a different task is refused ---
const badAck = await new Promise((resolve) => {
  socket.emit('client_message', { type: 'stop', taskId: 'some-other-task' }, resolve);
  setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 4000);
});
ok(badAck && badAck.ok === false, 'stop for a non-subscribed task is refused');
socket.close();

// --- unauthenticated socket is rejected ---
const anon = connect(null, task.id);
let anonDisconnected = false;
anon.on('disconnect', () => {
  anonDisconnected = true;
});
await sleep(1500);
ok(anonDisconnected || !anon.connected, 'unauthenticated socket is rejected');
anon.close();

// --- non-member socket is rejected ---
const outsider = connect(cookieB, task.id);
let outsiderDisconnected = false;
outsider.on('disconnect', () => {
  outsiderDisconnected = true;
});
await sleep(1500);
ok(outsiderDisconnected || !outsider.connected, 'non-member socket is rejected');
outsider.close();

// cleanup
try {
  const db = await import('@agentos/db');
  const prisma = db.getPrisma();
  await prisma.usageRecord.deleteMany({ where: { workspaceId: wsId } });
  await prisma.costRecord.deleteMany({ where: { workspaceId: wsId } });
  await prisma.workspace.deleteMany({ where: { slug } });
  await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
  await db.disconnectPrisma();
  console.log('  ✓ cleaned up');
} catch (e) {
  console.error('  (cleanup skipped: ' + e.message + ')');
}

if (failures > 0) {
  console.error(`\nSTREAM E2E FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nSTREAM E2E PASSED');
process.exit(0);
