// Proof that the OPERATOR works end-to-end: launch a REAL Chromium, navigate, capture the live screencast
// frames + a screenshot. Not a mock — this is the actual browser the agent drives.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const { BrowserSession } = require(path.join(__dirname, '..', 'packages', 'tools', 'dist', 'index.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-proof-'));
  let frames = 0;
  const session = new BrowserSession({ headless: true, artifactDir: dir, onFrame: () => { frames += 1; } });

  console.log('[1] launching REAL Chromium + navigating to https://example.com ...');
  const t0 = Date.now();
  const nav = await session.navigate('https://example.com');
  console.log('[2] navigate RESULT:', JSON.stringify(nav));

  // let the live CDP screencast emit a few frames (the thing you would watch live)
  await new Promise((r) => setTimeout(r, 1500));

  const shots = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  console.log('[3] live screencast frames captured:', frames);
  console.log('[4] screenshot artifacts on disk:', shots);
  console.log('[5] elapsed ms:', Date.now() - t0);

  await session.dispose();
  const ok = nav && nav.status === 200 && typeof nav.title === 'string' && nav.title.length > 0;
  console.log(ok ? 'OPERATOR_WORKS=YES (real browser drove + returned status/title)' : 'OPERATOR_WORKS=NO');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('OPERATOR_FAILED:', e && e.message ? e.message : e);
  process.exit(2);
});
