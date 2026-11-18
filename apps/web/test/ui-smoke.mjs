#!/usr/bin/env node
// Real-browser smoke test of the AgentOS SPA: register -> create workspace -> run a task ->
// watch it stream to a result. Requires a booted API (LLM_MODE=mock) and the static export served.
//   API:  API_PORT=4000 LLM_MODE=mock DATABASE_URL=... node services/api/dist/main.js
//   web:  npx serve apps/web/out -l 3000
//   run:  WEB_URL=http://localhost:3000 SHOT=/tmp/agentos.png node apps/web/test/ui-smoke.mjs
import { chromium } from 'playwright';

const WEB_URL = process.env.WEB_URL || 'http://localhost:3000';
const SHOT = process.env.SHOT || '';
const tag = Date.now().toString(36);
const email = `ui-${tag}@test.local`;

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    console.error('  ✗ ' + msg);
    failures++;
  }
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(15000);

try {
  await page.goto(WEB_URL, { waitUntil: 'domcontentloaded' });

  // Auth panel renders (session check resolves to signed-out).
  await page.getByText('Sign in', { exact: false }).first().waitFor();
  ok(true, 'auth panel rendered');

  // Switch to register and create an account.
  await page.getByRole('button', { name: /Register/i }).click();
  await page.getByPlaceholder('Display name').fill('UI Smoke');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder(/Password/i).fill('sup3rsecret!');
  await page.getByRole('button', { name: /Create account/i }).click();

  // First-run: create a workspace.
  await page.getByPlaceholder('Workspace name').waitFor();
  ok(true, 'registered + reached workspace bootstrap');
  // The header shows the resolved displayName (regression guard for the {user} unwrap).
  ok(await page.getByText('UI Smoke', { exact: false }).first().isVisible(), 'header shows the user displayName');
  await page.getByPlaceholder('Workspace name').fill(`Smoke ${tag}`); // unique slug per run
  await page.getByRole('button', { name: /Create workspace/i }).click();

  // Compose + run a task.
  const composer = page.getByPlaceholder(/Describe a task/i);
  await composer.waitFor();
  ok(true, 'workspace ready, task composer visible');
  await composer.fill('Say hello and finish.');
  await page.getByRole('button', { name: /Run task/i }).click();

  // Task detail streams to a result (mock provider final text; appears as both a reasoning
  // message and the final result, so match the first).
  await page
    .getByText('Task completed in mock mode.', { exact: false })
    .first()
    .waitFor({ timeout: 20000 });
  ok(true, 'task ran and streamed to a final result');

  // Plan + Result sections are present.
  ok(await page.getByText('Result', { exact: false }).first().isVisible(), 'Result section visible');

  if (SHOT) {
    await page.screenshot({ path: SHOT, fullPage: true });
    console.log('  · screenshot ->', SHOT);
  }
} catch (err) {
  ok(false, `flow error: ${err.message}`);
  if (SHOT) await page.screenshot({ path: SHOT, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\nUI SMOKE FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nUI SMOKE PASSED');
