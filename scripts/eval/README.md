# AgentOS Eval / Regression Harness (TICKET-EVAL)

A permanent, **deterministic** quality-assurance harness that exercises real agent behavior —
tool-use, policy decisions, artifact production, durable resume, and cost/usage regression —
against the **real** compiled runtime (`TaskRunner` / `AgentEngine` / `PolicyService` /
`ArtifactsService`) and a **real Postgres**, driven by a deterministic `MockProvider`.

It is **test infrastructure only**. It never runs inside the product runtime (API / web / worker),
changes no product behavior, and needs no DB migration. It only *imports* compiled `dist` + the
`@agentos/*` packages (same bootstrap as `scripts/verify-*.cjs`).

## Run it

```bash
# one command — runs every case, writes a JSON report + prints a summary, exits 0 (all pass) / 1 (any fail)
pnpm eval

# subsets / modes
node scripts/eval/run-eval.cjs --case=ssrf-private-ip-deny    # a single case by id
node scripts/eval/run-eval.cjs --filter=policy               # one category
node scripts/eval/run-eval.cjs --determinism                 # run each case twice, assert identical results
node scripts/eval/run-eval.cjs --self-test                   # prove the harness reports a known-bad case as FAIL
node scripts/eval/run-eval.cjs --update-baseline             # MANUAL, deliberate cost-baseline refresh
node scripts/eval/run-eval.cjs gen-case <taskId>             # draft a regression case from a failed task's log
```

Requires a reachable Postgres (`DATABASE_URL` in `.env`, same as the integration tests) and a built
`dist` (`pnpm --filter @agentos/api build`). Each case creates an isolated throwaway workspace/user/task
and **always cleans up in a `finally`** (DB rows, temp sandbox/blob dirs, env overrides) even on failure.

## Case format

Cases are version-controlled JSON fixtures in `cases/*.json`, validated by `lib/eval-case.schema.cjs`
(Zod). No DB model, no migration — a case is a test artifact. Shape:

```jsonc
{
  "id": "ssrf-private-ip-deny",
  "category": "policy",                 // tool-use | policy | artifact | resume | cost | security | meta
  "description": "...",
  "kind": "run",                        // run (default) | resume | gencase
  "env": { "POLICY_ENGINE_ENABLED": "true", "POLICY_GRANTED_SCOPES": "net.request" }, // case-local env, restored after
  "toolset": "stub",                    // stub (declared below) | deliverable (real generate_* tools)
  "tools": [{ "name": "http_fetch", "riskLevel": "low", "permissions": ["net.request"] }],
  "approvals": { "autoDecision": "deny" }, // auto approve/deny on approval_request (null = leave pending)
  "task": { "prompt": "...", "stepBudget": 12 },
  "script": [                           // deterministic MockProvider script (tool_use ids auto-assigned)
    { "text": "plan", "stopReason": "end_turn" },
    { "toolCalls": [{ "name": "http_fetch", "input": { "url": "http://169.254.169.254/" } }], "stopReason": "tool_use" }
  ],
  "expect": {
    "status": "completed",
    "toolCallCount": 0,
    "toolsCalled": ["http_fetch"], "toolsNotCalled": ["shell_exec"],
    "toolRan": { "http_fetch": false },                 // did the handler actually execute?
    "policy": [{ "tool": "http_fetch", "effect": "deny" }],
    "auditActionsInclude": ["policy.decision", "tool.execution.denied"],
    "approvalDetail": { "hasFields": ["browserAction", "url", "riskReason"] },
    "artifacts": { "minCount": 1, "artifactIdsFilled": true, "sha256Valid": true },
    "cost": { "baselineKey": "cost-probe", "tolerancePct": 10 },
    "noSecretLeak": ["sk-ant-..."]                      // these strings must NOT appear in any payload/audit
  }
}
```

`policy` cases run with `POLICY_ENGINE_ENABLED=true`; `artifact` cases with
`ARTIFACT_PERSISTENCE_ENABLED=true` (real DB rows + blob + `final_output.artifactIds`); the `resume`
case exercises the real durable-resume checkpoint/`resumeFrom` reducer via a **safe in-process**
crash simulation (no process kill — a faithful kill test lives in `scripts/verify-resume.cjs`).

## Baseline (cost regression)

`baselines/cost-baseline.json` holds the expected `{ inputTokens, outputTokens, toolCalls, costUsd }`
per `baselineKey`. Because `MockProvider` is deterministic these are stable; a `cost` case fails if a
metric drifts beyond `tolerancePct`. Baselines update **only** via the explicit
`--update-baseline` command — never automatically.

## Report

`pnpm eval` writes a machine-readable JSON report to `eval-reports/` (git-ignored) and prints a
human-readable summary (`✓ / ✗` per case, with the first failing assertion + reason for failures).
Exit code: `0` if all cases pass, `1` otherwise.

## gen-case (regression from a failed task)

`gen-case <taskId>` reads a failed task's `TaskLog` and drafts a regression case JSON
(`cases/generated/<id>.json`, git-ignored) with the prompt, a reconstructed MockProvider script, the
captured final status, and **estimated** tool expectations. Output is marked `needsReview: true` and
all text/inputs are **secret-redacted** (the same redaction used by the policy engine) so no token /
key / header from the log leaks into the fixture. Estimated expectations are drafts — review before
trusting them.

## CI

This harness is **local-only** in this ticket (no remote / CI wired). When a CI runner is available it
can be added as a **non-blocking** step after the E2E job (e.g. `pnpm eval`), flipped to blocking once
the baselines have stabilized. `.github/workflows/ci.yml` is intentionally left unchanged here.

## Scope / guarantees

- No product runtime code is modified; no DB migration; no feature flag.
- Deterministic: the same case twice yields the same result (`--determinism` proves it).
- Only `cases/`, `lib/`, `baselines/cost-baseline.json` and this README are committed; reports and
  generated drafts are git-ignored.
