#!/usr/bin/env node
/* Eval / regression runner (TICKET-EVAL). Single command, deterministic (MockProvider), local-only.
 *
 *   node scripts/eval/run-eval.cjs                  # run every case → JSON report + summary, exit 0/1
 *   node scripts/eval/run-eval.cjs --case=<id>      # run one case
 *   node scripts/eval/run-eval.cjs --filter=policy  # run one category
 *   node scripts/eval/run-eval.cjs --determinism    # run each case twice, assert identical results
 *   node scripts/eval/run-eval.cjs --self-test      # prove the harness reports a known-bad case as FAIL
 *   node scripts/eval/run-eval.cjs --update-baseline # MANUALLY refresh cost baselines (deliberate)
 *   node scripts/eval/run-eval.cjs gen-case <taskId> # draft a regression case from a failed task log
 */
const path = require('node:path');
const fs = require('node:fs');
const h = require('./lib/harness.cjs');

function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (const a of argv) {
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; }
    else pos.push(a);
  }
  return { flags, pos };
}

function projectForCompare(r) {
  return JSON.stringify({ status: r.status, metrics: r.metrics, asserts: r.assertions.map((a) => [a.kind, a.ok]) });
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const ctx = h.bootstrap();
  try {
    // ---- gen-case <taskId> -----------------------------------------------------------------------
    if (pos[0] === 'gen-case') {
      const taskId = pos[1];
      if (!taskId) { console.error('usage: run-eval.cjs gen-case <taskId>'); process.exitCode = 2; return; }
      const fixture = await h.generateCase(ctx, taskId);
      const outDir = path.join(h.CASES_DIR, 'generated');
      fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, `${fixture.id}.json`);
      fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + '\n');
      console.log(`Generated DRAFT regression case (needsReview=true, secrets redacted):\n  ${outFile}`);
      console.log(JSON.stringify(fixture, null, 2));
      return;
    }

    // ---- self-test (negative): a known-bad expectation must be reported as FAIL ------------------
    if (flags['self-test']) {
      const badCase = { id: '_self-test-should-fail', category: 'meta', description: 'deliberately wrong expectation', script: [{ text: 'hello', stopReason: 'end_turn' }], expect: { status: 'failed' } };
      const r = await h.runCase(ctx, badCase);
      const ok = r.status === 'fail';
      console.log(`Self-test (negative): harness reported "${r.status}" for a known-bad case → ${ok ? 'PASS ✓ (correctly FAILED)' : 'BROKEN ✗'}`);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    let cases = h.loadCases();
    if (flags.case) cases = cases.filter((c) => c.id === flags.case);
    if (flags.filter) cases = cases.filter((c) => c.category === flags.filter);
    if (cases.length === 0) { console.error('No matching eval cases.'); process.exitCode = 2; return; }

    // ---- determinism: run twice, compare ---------------------------------------------------------
    if (flags.determinism) {
      let allStable = true;
      for (const c of cases) {
        const a = await h.runCase(ctx, c);
        const b = await h.runCase(ctx, c);
        const stable = projectForCompare(a) === projectForCompare(b);
        allStable = allStable && stable;
        console.log(`${stable ? '✓' : '✗'} ${c.id} — ${stable ? 'deterministic' : 'NON-DETERMINISTIC'}`);
      }
      console.log(allStable ? '\nAll cases deterministic ✓' : '\nNon-deterministic cases found ✗');
      process.exitCode = allStable ? 0 : 1;
      return;
    }

    // ---- normal run ------------------------------------------------------------------------------
    const results = [];
    for (const c of cases) results.push(await h.runCase(ctx, c));

    // ---- --update-baseline (manual, deliberate) -------------------------------------------------
    if (flags['update-baseline']) {
      const base = h.loadBaseline();
      for (let i = 0; i < cases.length; i++) {
        const key = cases[i].expect && cases[i].expect.cost && cases[i].expect.cost.baselineKey;
        if (key && results[i].metrics && results[i].metrics.inputTokens !== undefined) base[key] = results[i].metrics;
      }
      h.saveBaseline(base);
      console.log('Baseline updated:', h.BASELINE_FILE);
    }

    const passed = results.filter((r) => r.status === 'pass').length;
    const report = { generatedAt: new Date().toISOString(), total: results.length, passed, failed: results.length - passed, cases: results };

    const reportsDir = path.join(h.EVAL_DIR, '..', '..', 'eval-reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    const jsonPath = path.join(reportsDir, `eval-${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');

    console.log(h.formatSummary(report));
    console.log(`\nJSON report: ${jsonPath}`);
    process.exitCode = report.failed === 0 ? 0 : 1;
  } finally {
    await ctx.disconnect().catch(() => {});
  }
}

main().catch((e) => { console.error('EVAL RUNNER ERROR:', e); process.exitCode = 1; });
