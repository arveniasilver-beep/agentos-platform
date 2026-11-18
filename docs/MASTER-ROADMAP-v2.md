# AgentOS — MASTER ROADMAP v2

> Product Architect + Principal Engineer plan turning the board audit into an executable sequence.
> Evidence-grounded: every "current state" claim cites real `file:line` re-verified against the tree on this branch (`feat/policy-engine`).
> Governing insight: **the chassis is strong; the failure is that the flagship work is dark by default.** 11 capability flags default false (`packages/config/src/env.ts:61-189`) and the shipped `.env` enables none and runs `EXECUTION_MODE=inline` (`.env:16`). The plan is mostly *activation, wiring, and comfort* — not rewrites.

---

## 0. ORIENTATION — the one-paragraph truth

AgentOS has a genuinely good durable-execution spine (event-sourced `TaskLog`, lease/fencing/snapshot resume with live-Postgres crash tests), a real CDP browser with take-over, an edit==exec coding FS, RLS + hash-chained audit, and a deterministic eval harness with a working negative self-test. But: durable resume is OFF (`RESUME_ENABLED` default false, `env.ts:72-75`); follow-up continuation is OFF (`FOLLOWUP_TURNS_ENABLED`, `env.ts:81-84`); policy/approval gating is OFF and even the legacy gate gates nothing at default ceiling (`high>high=false`); there is **no `web_search` tool** in a web-research product; prompt caching is priced but never requested; secrets persist raw at rest; the theme toggle is dead; automations never fire under `inline`; the Workflow Builder 404s on first click; and the eval harness never gates CI. The roadmap below fixes activation and the comfort layer first (weeks), then the few genuinely deep gaps (secret-safe visuals, cited DOM-grounded research, persistent authenticated browser, unified supervisor, per-call cost ledger).

---

# 1. MASTER ROADMAP

Format per phase: Goal · Why · Current state (evidence) · Work items · Risks · Acceptance · Test · Impact · Priority · "Done" evidence.

---

## PHASE 0 — Real Measurement & Doctor (make the system tell the truth)
**Goal.** Replace asserted health with measured health; one idempotent bring-up; a `doctor` that names exactly what is wrong.
**Why.** Today every failure is a "mysterious disconnect." `/health` returns a static literal and the API hard-crashes if Postgres is late. You cannot improve what you cannot measure, and you cannot trust a green that is decorative.
**Current state (evidence).**
- `/health` is unconditional `{status:'ok'}` — never touches Postgres/Redis/queue (`services/api/src/health/health.controller.ts:13-20`, re-verified).
- Prisma `$connect()` has no retry/backoff → process dies if Postgres boots late (`services/api/src/prisma/prisma.module.ts:19`).
- No `up`/`dev:local` orchestration in `package.json`; bring-up is a 5-step manual ritual (README:70-92). Stray `api-live.log`/`api-mock.log`/`api-artifacts.log`/`web-serve.log` at repo root prove hand-juggling.
- Web `API_BASE` is baked at build time, default `http://localhost:4000` (`apps/web/lib/config.ts:5-6`) — change `API_PORT` and the bundle silently disconnects.
**Work items.**
1. `/health` → real readiness: inject Prisma (+ optional Redis token), run `SELECT 1` / `redis.ping()`, return `503` + per-dependency map `{postgres, redis, queueMode, brainConfigured}`. Keep a separate static `/livez`.
2. `prisma.module.ts`: bounded connect-with-backoff (10×1s) before throwing.
3. `scripts/doctor.ps1`: preflight — Postgres reachable, schema migrated (`prisma migrate status`), brain configured, ports free, flags/exec-mode summary, web↔API base match. Prints fix hints.
4. `scripts/up.ps1`: idempotent — compose up → wait `pg_isready` → `migrate deploy` → build API if `dist/main.js` stale → load `.env` → start API → poll `/health` → serve web. Reuse `run-local.ps1` env parser.
**Risks.** Low. Additive; no behavior change to the agent loop.
**Acceptance.** `up.ps1` from a cold machine yields a healthy `/health` and a reachable web app with one command; `doctor.ps1` correctly diagnoses a stopped Postgres and a stale build.
**Test.** Kill Postgres → `/health` returns 503 naming postgres; restart late → API survives via backoff; `doctor` exits non-zero with the right cause.
**Impact.** Eliminates the #1 source of "service keeps dying / mysterious disconnect."
**Priority.** P0 (foundation for everything; near-zero risk).
**"Done" evidence.** CI/log shows `/health` 503→200 transition; `up.ps1` single-command boot recorded.

---

## PHASE 1 — Immediate UX Comfort (stop feeling like a prototype)
**Goal.** Kill the dead-toggle / where-am-I / one-shot-task feel with flag flips + small front-end deltas. No engine changes.
**Why.** The "prototype feel" is concentrated in a few high-visibility defects; each is a small delta with large perceived-quality payoff.
**Current state (evidence).**
- Theme toggle is dead: `darkMode:'class'` set but **0/26 components use a `dark:` variant**; 117 hardcoded `bg-slate-9x0`. Toggle only swaps the icon (`apps/web/components/WorkspaceView.tsx` toggle map).
- Follow-up composer built but flag-gated off (`apps/web/lib/config.ts:20-21`, server `env.ts:81-84`).
- Mobile `/m` renders a literal config-instruction stub to end users (`apps/web/app/m/page.tsx:14-25`).
- Sidebar: 18 always-on items, no active state, two share the 🌐 icon; every panel is a modal overlay (no where-am-I).
- Workflow Builder nav is unconditional but the backend 404s on create/run (`workflow.controller.ts:18-19`); panel copy advertises "schedule (cron)" triggers the DSL rejects.
**Work items.**
1. Flip well-tested flags in the run profile: server `FOLLOWUP_TURNS_ENABLED=true`, web `NEXT_PUBLIC_FOLLOWUP_TURNS_ENABLED=true` (verify both sides). Un-deadens the reply composer.
2. Sidebar active-state highlight; dedupe icons; gate the Workflows nav on a server-exposed flag so it never 404s; fix the false "schedule (cron)" copy.
3. Make the theme toggle honest now (hide/relabel until a real light theme lands in Phase 8), OR ship a minimal semantic-token pass for the top 3 surfaces. Recommend: hide for now; full theme is Phase 8.
4. Seed the empty composer with 3–4 starter prompt chips; add a one-line agent-status banner ("Browsing / Thinking / Waiting for approval") to `TaskDetail`.
**Risks.** Low. Flag flips touch deploy env; verify server+web flags agree.
**Acceptance.** Reply composer renders and continues a finished task; no nav item 404s; no visibly-dead control; first-run composer has guidance.
**Test.** Manual: finish a task → reply → second run starts. Open every nav item → no 404. Click Workflows → builder loads (after Phase 2/5 enablement) or is hidden.
**Impact.** Highest felt-quality-per-effort in the repo.
**Priority.** P0/P1.
**"Done" evidence.** Screen capture of follow-up turn; nav highlight; no dead toggle.

---

## PHASE 2 — Task Continuation + Durable Runtime + Live Computer (the keystone)
**Goal.** Make durable execution and multi-turn continuation the DEFAULT, with a unified supervisor and a tested production worker.
**Why.** A Devin/Manus-class product never loses a multi-hour run to a restart and is always continuable. AgentOS *built* this and ships it off.
**Current state (evidence).**
- `RESUME_ENABLED` default false → snapshots not written, lease columns inert, boot reaper *fails* orphans (`tasks.service.ts:224-235`).
- `.env` runs `EXECUTION_MODE=inline` (`.env:16`) → `TaskWorker`/`AutomationWorker` no-op; in-flight task is a fire-and-forget `void this.runTask()` (`tasks.service.ts:349`).
- Queue mode: BullMQ `attempts:1`, no stalled-job recovery configured (`queue/queue.providers.ts:45`) → worker death mid-job silently loses the task unless resume is on.
- Production `TaskWorker` has zero integration coverage (the queue test reconstructs its own inline `Worker`).
- Follow-up requires a snapshot and cannot fall back to `reduceEvents` (`tasks.service.ts:825-826`).
**Work items.**
1. Run profile: `EXECUTION_MODE=queue` + `RESUME_ENABLED=true` (code already supports; activates lease sweep, boot-resume, automations). Gate behind Phase 0 readiness so a missing Redis fails loudly, not silently.
2. Configure BullMQ stalled-job recovery: `attempts:2` + backoff, `Worker` `stalledInterval`/`maxStalledCount` (`queue.providers.ts`) so a crash is redelivered even with resume off — layer the two redelivery paths instead of either/or.
3. Add a bounded in-loop provider retry in `engine.ts` `safeComplete` (1–2× short backoff) so a transient 529 retries the step instead of failing the whole task (`engine.ts:285-296`).
4. Add an integration test that instantiates the real `TaskWorker` (not a stand-in).
5. Startup WARN when running a non-durable profile (`EXECUTION_MODE=queue && !RESUME_ENABLED`, or inline) so the durability posture is visible.
6. (Stretch) A single "task supervisor" invariant: every non-terminal task is running, leased, or queued — consolidate boot-reaper / resume-on-boot / lease-sweep / BullMQ behind one owner.
**Risks.** Medium. Switching the default exec mode changes the running path; mitigate with Phase 0 readiness gating + the existing crash/resume eval case (`11-resume-after-crash`) + `scripts/verify-resume.cjs`.
**Acceptance.** Kill the API mid-task → task resumes and completes without re-running the done step; follow-up turn continues the same task; one usage row per logical step.
**Test.** `verify-resume.cjs` (real process kill); `task-resume.integration.test.ts`; new `TaskWorker` test; queue stalled-job redelivery test.
**Impact.** Converts the flagship reliability work from dormant to live; removes silent data loss.
**Priority.** P0 (keystone).
**"Done" evidence.** Recorded process-kill → resume; WARN log absent under durable profile.

---

## PHASE 3 — Coding Workspace + Test Runner + Git/Patch/Rollback + Localhost Comfort
**Goal.** Turn the well-built coding *backend* into a usable loop: a dev image, dependency install, persisted deps, visible pass/fail, and (stretch) a preview.
**Why.** The agent can edit blind, can't install, often can't run the tests, and the user can't see the loop. That is the "localhost feels uncomfortable" core.
**Current state (evidence).**
- `CODING_WORKSPACE_ENABLED` false; local `.env` `ENABLE_SANDBOX=false` → no runner → `run_tests/lint/build` silently absent.
- Default `SANDBOX_IMAGE=alpine:3` (`env.ts:46`) — no node/npm; `${pm} test` exits "not found".
- Coding session hardcoded `networkDisabled:true` (`tools.factory.ts:189`) → `npm install` impossible.
- `write_file` large-diff gate counts total file lines not changed lines (`policy.service.ts:82-84`) — disagrees with `apply_patch`.
- No coding UI surface (no file tree/editor/terminal); no preview/dev-server (no `ExposedPorts` anywhere in `sandbox.ts`).
**Work items.**
1. `CODING_RUNNER_IMAGE` env (default `node:20-alpine`) used for the coding session instead of `alpine:3`.
2. `CODING_RUNNER_ALLOW_NETWORK` opt-in flag flipping `networkDisabled` so `npm install` works behind a deliberate switch.
3. Persist a per-(workspace,project) named volume for the coding session so `node_modules`/deps survive (the `persistVolume` mechanism exists, `sandbox.ts:84-85`).
4. Fix the `write_file` gate to count changed lines (mirror `countDiffLines`).
5. Render `run_tests`/`run_build` results as green/red badge + collapsible stderr in `TaskDetail` (data already carries `{exitCode,stdout,stderr,timedOut}`).
6. (Stretch) Preview: opt-in `ExposedPorts`/`PortBindings` for a dev server + a "live preview" URL in the Computer panel.
**Risks.** Medium. Network-on for installs reopens an SSRF/egress surface — keep it opt-in and behind the policy net-guard.
**Acceptance.** With the coding profile on, the agent installs deps, runs a real test suite red→green, and the user sees pass/fail.
**Test.** `verify-coding.cjs` against a real Docker daemon (UNVERIFIED locally — Docker won't boot here; run in CI); a new eval case that installs + tests a tiny repo.
**Impact.** Turns a dead loop into a working coding agent.
**Priority.** P1.
**"Done" evidence.** CI run of an install→test→fix loop with rendered pass/fail.

---

## PHASE 4 — Token / Cost / Context / Memory
**Goal.** Prompt caching, correct per-model attribution under routing, real metering for non-Anthropic brains, default cost bounds, token-aware compaction, and a cost dashboard.
**Why.** Every multi-step task re-pays full input for the stable prefix; routed/0-priced brains mis-meter; default runs are dollar-unbounded.
**Current state (evidence).**
- No `cache_control` anywhere in `anthropic-provider.ts:114-123` → cache columns dead on the write side; every step re-bills the full growing prompt.
- `Workspace.budgetCapUsd`/`costThresholdUsd`/`Project.budgetCapUsd` are schema-only — zero enforcement matches in services.
- Default `costBudgetUsd` optional with no default (`tasks.service.ts:314`) → unbounded unless user types one.
- Router records `provider.model` resolved via `pick({})` (default profile) while a *different* profile may have answered (`routing-provider.ts:44-63`) → wrong model attribution.
- OpenAI-compat factory never reads registry pricing → DeepSeek et al. meter at $0 (`llm-provider.factory.ts:140-147`, `openai-compat-provider.ts:148`).
- Compaction trigger is message-COUNT based (`engine.ts:397`), divorced from real tokens.
**Work items.**
1. Add ephemeral `cache_control` to the last system block + last tool def in `anthropic-provider.ts`; verify `cache_read_input_tokens>0`.
2. Wire registry pricing fallback in `llm-provider.factory.ts` when user pricing absent.
3. Default per-task `costBudgetUsd` (derive from `Workspace.budgetCapUsd` or a plan default).
4. Per-call usage ledger so cost attributes to the model that actually answered (fix router mis-attribution); enforce workspace/project caps before/while running.
5. Token-aware compaction using the existing `countTokens` rather than a flat message count.
6. Cost UI: cache tokens, per-model breakdown, budget burndown, `overThreshold` warning badge (data already in `view.cost`).
**Risks.** Medium. Cache breakpoints and per-call ledger touch the hot path; cover with cost-regression eval baseline.
**Acceptance.** Multi-step task shows non-zero cache reads and materially lower input spend; DeepSeek run reports non-zero cost; a workspace cap actually stops runs.
**Test.** `cost.test.ts` + the cost-regression eval case + a new cache-token multi-turn test + a budget-cap enforcement test.
**Impact.** Large recurring cost reduction + trustworthy cost numbers + real governance.
**Priority.** P1.
**"Done" evidence.** Usage rows with cache reads; cap-triggered stop in a test.

---

## PHASE 5 — Artifact + Automation + Playbook + Mobile (activate the built infra)
**Goal.** Turn on the durable artifact store with version history/rollback, make scheduled automations actually fire, fix the Workflow front door, and ship a mobile pairing page + service worker.
**Why.** Each is heavy, tested infra shipped dark; the gap is activation + a thin read/UX layer.
**Current state (evidence).**
- `ARTIFACT_PERSISTENCE_ENABLED` false and unset in every env → zero Artifact rows ever; durable panel never renders. Even on: no version-history endpoint, no rollback, no share (`listDurable` returns only current version).
- Automations never fire under `inline` (`automation.worker.ts:23`); `AUTOMATION_RUNS_ENABLED` off.
- Workflow nav unconditional but backend 404s; DSL has no scheduled trigger; UI copy lies about cron.
- Mobile: backend device-auth is production-grade but `setDeviceTokenProvider` is never called — no pairing UI; no service worker behind the "PWA/offline" claim; both flags off.
**Work items.**
1. Set `ARTIFACT_PERSISTENCE_ENABLED=true` + `ARTIFACT_STORE_ROOT` (outside sandbox) in the run profile; add `GET .../versions` and `POST .../rollback/:version` (logic already exists at the `currentVersionId` update); reconcile durable vs ephemeral file lists (badge durable files).
2. Enable `AUTOMATION_RUNS_ENABLED`; rely on Phase 2's `EXECUTION_MODE=queue` so ticks fire; add 3s run polling to the panels.
3. Gate the Workflows nav on the flag; enable `WORKFLOW_BUILDER_ENABLED`; remove the false "schedule (cron)" copy.
4. Mobile: a "Paired devices" settings page calling the existing `POST /auth/devices` (QR + copy-once); a scoped service worker for `/m`; wire the Artifacts tab to `downloadArtifact`; approval-count→browser Notification.
**Risks.** Low–medium. Artifact store root must be outside the sandbox (already validated). Mobile token handling must stay out of localStorage (already the case).
**Acceptance.** Deliverables appear in a durable panel and survive sandbox teardown; an automation fires on schedule; Workflows never 404; a phone can pair and approve.
**Test.** `artifact-persistence.integration.test.ts`; `automation-runs.integration.test.ts`; `device-sync.integration.test.ts`; manual mobile pairing.
**Impact.** Unlocks ~4 flagship subsystems that are currently invisible.
**Priority.** P1/P2.
**"Done" evidence.** Durable artifact with v1/v2 + rollback; scheduled automation run row.

---

## PHASE 6 — Security / Policy / RLS / Audit / Approval Hardening
**Goal.** Make risky actions gated by default, redact secrets at rest, enforce connector scopes pre-exec, and close audit-chain gaps.
**Why.** Security that defaults off is security that isn't there. Today nothing risky pauses by default and secrets land raw in the DB.
**Current state (evidence).**
- `POLICY_ENGINE_ENABLED` off → all classifiers dead. Even the legacy gate: default ceiling `high`, no tool is `critical`, gate is strict `>` → `high>high=false` (`engine.ts:545`) → only `publish_site` + local delete pause. `shell_exec`/`write_file`/`http_fetch`/browser writes run unattended.
- Connector scope `checkAction` runs AFTER the gate and its verdict is swallowed (`task-runner.ts:528-530`) — audit-only theater.
- `ToolCall.args`/`TaskLog.payload` persist raw input/output; `redactText` never called on write paths (`task-runner.ts:218,491`).
- Audit hash covers only `action/actor/target/createdAt` — `metadata`/`risk` are not tamper-evident (`audit.hash.ts:15-25`); chain write is racy (no unique on `(workspaceId, prevHash)`).
**Work items.**
1. Make the default gate actually gate `high`: ship `riskCeiling` default `'medium'` (or change the operator to `>=`) in the DTOs. Immediately pauses shell/fs/http out of the box.
2. Redact `event.input`/`event.output` via existing `redactText` before `toolCall.create`/`taskLog.create`.
3. Hoist connector `checkAction` into the engine `policyHook` (pre-exec) and return `deny` on `!ok`; remove the dead post-hoc call.
4. Enable `POLICY_ENGINE_ENABLED` once 1–3 land; classify connector mutation tools (gmail/outlook send, payment) as elevated.
5. Audit: hash canonical `metadata`+`risk`+`actorType`; add DB unique `(workspaceId, prevHash)` so concurrent forks fail loudly.
**Risks.** Medium. A stricter default gate increases approval prompts — pair with good approval UX (already present) and a workspace-level "trusted" override.
**Acceptance.** `shell_exec` pauses for approval by default; a `.env`-reading tool's secret never lands in `tool_calls.args`; a connector action with insufficient scope is blocked, not just logged.
**Test.** Eval cases 06/13/16/38; a new "secret-at-rest" test scanning `tool_calls`/`task_logs`; a connector-scope-deny test; RLS test extended across the sensitive table set.
**Impact.** Moves the default posture from permissive to safe.
**Priority.** P1.
**"Done" evidence.** Approval card on default `shell_exec`; redacted DB rows; blocked under-scoped connector call.

---

## PHASE 7 — Eval / Regression Harness + Observability + Quality Gates
**Goal.** Make the (excellent) eval harness GATING; add schema-drift + broader RLS gates; add supervisor/cost observability.
**Why.** A regression harness that never runs in CI is documentation. One forgotten command ships a security regression.
**Current state (evidence).**
- `grep -c eval ci.yml` = 0; root `ci` script has no `pnpm eval`. README admits it's local-only.
- No migration/schema-drift gate; RLS tested on exactly one table.
- No web/browser-flow E2E; no semantic/trajectory eval.
**Work items.**
1. Add `pnpm eval` as a gating CI step (Postgres already a CI service); also `--self-test` + `--determinism`.
2. Schema-drift gate: `prisma migrate diff ... --exit-code`.
3. Parameterize the RLS test across `['secret','artifact','auditLog','memory','automation']`.
4. Observability: surface lease/heartbeat/orphan metrics + a per-call cost ledger view; a "why did this resume" timeline.
5. (Phase 8-adjacent) one Playwright web-flow E2E: login → task → stream → approve → artifact.
**Risks.** Low. Mostly CI/test additions.
**Acceptance.** A deliberately-broken eval case fails the PR; a divergent migration fails CI; a new table without RLS fails CI.
**Test.** The harness's own negative self-test in CI.
**Impact.** Quality becomes an enforced invariant, not a snapshot.
**Priority.** P1.
**"Done" evidence.** Red CI on a seeded regression.

---

## PHASE 8 — Manus-Level Polish + Onboarding
**Goal.** Real light theme via semantic tokens, persistent navigation (where-am-I), onboarding/empty-states, plan-approval gate, live status line.
**Why.** The remaining "prototype feel" after Phases 0–1 is the design-system + navigation + onboarding layer.
**Current state (evidence).** No semantic token layer (117 hardcoded slate classes); modal-launcher navigation with no active concept; no first-run guidance; research plans run silently with no editable-plan gate.
**Work items.** Semantic color tokens + `dark:`/light discipline; router-driven persistent left rail + content region; onboarding tour + sample tasks; a "review plan / start" gate before the act loop (plan event already emitted); a single agent-status banner.
**Risks.** Medium (broad UI refactor) — do it token-by-token, surface-by-surface, no big-bang rewrite.
**Acceptance.** Light theme actually renders; the app always shows where you are; first-run is guided.
**Test.** Visual regression + the Phase 7 web E2E.
**Impact.** Crosses from "impressive prototype" to "credible product."
**Priority.** P2.
**"Done" evidence.** Working light/dark switch; active-nav; onboarding flow.

---

## PHASE 9 — Advanced: Hosting/Deploy, Marketplace, Multi-Device, Plugins
**Goal.** One-click publish (own VPS), a skills/connector marketplace, true multi-device + push, plugin SDK.
**Why.** These are differentiators after the core "runs like Manus" is true. Premature now.
**Current state.** Hosting tools exist; marketplace/plugins are docs/roadmap. Mobile is single-device, poll-only (no push).
**Work items.** Self-hosted publish pipeline to the Hetzner VPS; signed plugin SDK + capability scopes; FCM/web-push for approvals; persistent authenticated browser profile (the genuinely deep browser gap).
**Risks.** High (new surfaces). Strictly after Phases 0–7.
**Acceptance / Test / Impact.** Deferred — re-scope after Phase 7.
**Priority.** P3.

---

# 2. THE FIRST 10 TICKETS (execute now)

Front-loaded for low-risk/high-impact + keystone-adjacent continuity.

### TICKET-01 — Real `/health` readiness probe + Prisma connect-with-backoff
- **Problem.** `/health` lies (static `ok`); API crashes if Postgres is late.
- **Root cause.** Health asserted not measured; no boot dependency-wait.
- **Affected.** `services/api/src/health/health.controller.ts`, `services/api/src/prisma/prisma.module.ts`, the Prisma/Redis providers.
- **Changes.** Inject Prisma (+ optional Redis token); `SELECT 1`/`ping`; 503 + per-dep map; keep `/livez` static. Wrap `$connect()` in bounded retry (10×1s).
- **User impact.** "Mysterious disconnect" becomes a named cause; fewer manual restarts.
- **Security impact.** None (don't leak connection strings in the body).
- **Test plan.** Stop Postgres → 503 names postgres; late Postgres → API survives; Redis down in queue mode → degraded flag.
- **Acceptance.** `/health` reflects real dependency state; API tolerates a 5s-late Postgres.
- **Rollback.** Revert two files; behavior returns to static.
- **Risk.** Low.

### TICKET-02 — `scripts/up.ps1` + `scripts/doctor.ps1` (one-command bring-up + diagnosis)
- **Problem.** 5-step manual ritual; no preflight.
- **Root cause.** No lifecycle owner; build/migrate/run unbundled.
- **Affected.** `scripts/up.ps1` (new), `scripts/doctor.ps1` (new), reuse `scripts/run-local.ps1` env parser, `infra/compose.yaml`.
- **Changes.** `up.ps1`: compose up → wait `pg_isready` → `migrate deploy` → build-if-stale → start API → poll `/health` → serve web. `doctor.ps1`: checks + fix hints + exec-mode/flag summary + web↔API base match.
- **User impact.** Single-command, supervised boot.
- **Security impact.** None.
- **Test plan.** Cold machine → one command healthy; doctor diagnoses stopped Postgres + stale build + flag/mode mismatch.
- **Acceptance.** `up.ps1` reaches healthy `/health`; `doctor.ps1` exits non-zero on each seeded fault.
- **Rollback.** Delete scripts.
- **Risk.** Low. *(Depends on TICKET-01 for the readiness poll.)*

### TICKET-03 — Activate the durable runtime profile (queue + resume) with a startup WARN
- **Problem.** In-flight crashes lose work; automations never fire.
- **Root cause.** `.env` runs `inline`, `RESUME_ENABLED` off; durable code dormant.
- **Affected.** `.env`, `.env.example`, `scripts/run-local.ps1`, `services/api/src/tasks/tasks.service.ts` (`onModuleInit` WARN).
- **Changes.** `EXECUTION_MODE=queue`, `RESUME_ENABLED=true`, `AUTOMATION_RUNS_ENABLED=true`; WARN when running a non-durable profile. Gate behind Phase-0 readiness so a missing Redis fails loudly.
- **User impact.** Tasks survive restarts; automations fire.
- **Security impact.** None.
- **Test plan.** `verify-resume.cjs` (real kill); eval `11-resume-after-crash`; confirm an automation tick creates a Task.
- **Acceptance.** Mid-task kill → resume completes without re-running the done step; scheduled automation fires.
- **Rollback.** Revert env to `inline` (byte-identical legacy path).
- **Risk.** Medium (changes the running path). *(Depends on TICKET-01.)*

### TICKET-04 — BullMQ stalled-job recovery + in-loop provider retry
- **Problem.** Queue crash silently loses a job; one transient 529 fails a whole run.
- **Root cause.** `attempts:1`, no stalled config; engine treats every provider throw as terminal.
- **Affected.** `services/api/src/queue/queue.providers.ts`, `packages/agent-engine/src/engine.ts` (`safeComplete`).
- **Changes.** `attempts:2` + backoff, `stalledInterval`/`maxStalledCount`; bounded 1–2× retry with short backoff in `safeComplete` before emitting non-recoverable.
- **User impact.** Transient blips no longer kill long runs; crashed jobs redeliver even with resume off.
- **Security impact.** None.
- **Test plan.** New `TaskWorker` integration test; a forced stalled-job redelivery test; an engine test asserting a single transient throw retries then succeeds.
- **Acceptance.** Worker-death mid-job → redelivery; single 529 → step retry not task failure.
- **Rollback.** Revert constants and the retry block.
- **Risk.** Low–medium.

### TICKET-05 — Enable multi-turn follow-up end-to-end (server + web flag)
- **Problem.** Finished task is a dead-end; the built reply composer is dark.
- **Root cause.** `FOLLOWUP_TURNS_ENABLED` off on both server and web.
- **Affected.** `.env`/deploy env (`FOLLOWUP_TURNS_ENABLED=true`), web build env (`NEXT_PUBLIC_FOLLOWUP_TURNS_ENABLED=true`), verify `apps/web/components/TaskDetail.tsx` composer renders.
- **Changes.** Flag flips; confirm snapshot-preservation-across-terminal is active under the durable profile (TICKET-03).
- **User impact.** Continuous conversation — the keystone Manus feel.
- **Security impact.** Follow-up runs through the same guarded path; ensure cost-delta accounting (already implemented) is active.
- **Test plan.** `task-followup.integration.test.ts`; manual: finish → reply → same task continues, one run.
- **Acceptance.** Reply composer renders; a follow-up continues the SAME task with delta-only billing.
- **Rollback.** Unset both flags (endpoint 404s, byte-identical one-shot).
- **Risk.** Low. *(Best paired with TICKET-03 so snapshots persist.)*

### TICKET-06 — Make the default approval gate actually gate `high`
- **Problem.** Nothing risky pauses by default (`high>high=false`).
- **Root cause.** Strict `>` against a `high` ceiling + no `critical` tools.
- **Affected.** `services/api/src/tasks/dto.ts` (+ automations/skills DTOs), `packages/agent-engine/src/engine.ts:545`.
- **Changes.** Default `riskCeiling` to `'medium'` (or change operator to `>=` for `high`). Pair with the existing approval UX.
- **User impact.** `shell_exec`/`write_file`/`http_fetch` pause for approval out of the box.
- **Security impact.** Large positive — closes the "unattended risky action" default.
- **Test plan.** Eval cases 06/13; a new "shell pauses by default" case; ensure non-risky tools still auto-run.
- **Acceptance.** Default config pauses high-risk tools; low-risk tools unaffected.
- **Rollback.** Restore `'high'` default.
- **Risk.** Medium (more prompts) — add a workspace "trusted" override if noisy.

### TICKET-07 — Redact secrets at rest in the persisted trace
- **Problem.** Raw secrets land in `tool_calls.args` / `task_logs.payload`.
- **Root cause.** `redactText` applied only at UI/share boundaries, never on write.
- **Affected.** `services/api/src/tasks/task-runner.ts:218,491,541`.
- **Changes.** Pass `event.input`/`event.output` through existing `redactText` before `toolCall.create`/`taskLog.create`. Keep full output to the UI stream if desired, redact the persisted copy.
- **User impact.** None visible.
- **Security impact.** Closes secrets-at-rest; the trace/replay no longer leaks credentials.
- **Test plan.** New test: run a tool whose input contains `Bearer sk-…` → assert it's masked in `tool_calls`/`task_logs`.
- **Acceptance.** No live credential persists in the durable trace.
- **Rollback.** Remove the redact calls.
- **Risk.** Low (verify redaction doesn't corrupt replay needed for resume — resume uses the snapshot + reduced events; confirm reducer tolerance).

### TICKET-08 — Add the `web_search` tool (the missing core of web research)
- **Problem.** No web search in a web-research product; agent must already know URLs.
- **Root cause.** Never implemented; only a dead UI label + test references.
- **Affected.** `packages/tools/src/web-search-tool.ts` (new), `services/api/src/tasks/tools.factory.ts:114`.
- **Changes.** SSRF-safe search (fixed host / one API key) via existing `assertAllowedUrl`, returning `{title,url,snippet}[]`. UI category already exists (`TaskDetail.tsx:657`).
- **User impact.** Discovery → fetch → synthesize actually works.
- **Security impact.** Route through the net-guard; treat results as untrusted (fence in Phase-6/research).
- **Test plan.** New eval case: a research task that must search to find a fact; assert the tool is called and a source URL appears.
- **Acceptance.** Agent can answer a "find X on the web" task without a pre-known URL.
- **Rollback.** Remove the tool from the factory.
- **Risk.** Low–medium (external dependency; pick a stable provider).

### TICKET-09 — Prompt caching on the Anthropic provider
- **Problem.** Every step re-pays full input for the stable prefix.
- **Root cause.** No `cache_control` in the request body.
- **Affected.** `packages/llm/src/anthropic-provider.ts:114-123`.
- **Changes.** Convert `system` to a one-element block array with `cache_control:{type:'ephemeral'}`; add the breakpoint on the last tool def. (Consult the `claude-api` reference for the exact caching params/headers before editing.)
- **User impact.** None visible; faster + cheaper.
- **Security impact.** None.
- **Test plan.** Multi-turn run asserts `usage.cache_read_input_tokens>0`; cost-regression eval baseline updated intentionally.
- **Acceptance.** Cache reads > 0 on step ≥2; measurable input-cost drop.
- **Rollback.** Revert to plain string system + no breakpoint.
- **Risk.** Low.

### TICKET-10 — Durable artifact activation + version-history + rollback endpoints
- **Problem.** Durable store is dark; even on, versions are write-only (no list/rollback/share).
- **Root cause.** Flag unset; `listDurable` returns only current version; no version routes.
- **Affected.** `.env`/`.env.example` (`ARTIFACT_PERSISTENCE_ENABLED=true`, `ARTIFACT_STORE_ROOT`), `services/api/src/artifacts/artifacts.service.ts`, `artifacts.controller.ts`, `apps/web/components/TaskDetail.tsx`.
- **Changes.** Enable the flag; `GET id/:artifactId/versions` (+ per-version download); `POST id/:artifactId/rollback/:version` (reuse the existing `currentVersionId` update); badge durable vs ephemeral files.
- **User impact.** Deliverables persist, show v1/v2/v3, roll back.
- **Security impact.** Reads are workspace-scoped + RLS (already proven); keep that.
- **Test plan.** `artifact-persistence.integration.test.ts` + new version-list/rollback tests.
- **Acceptance.** A produced file survives sandbox teardown, lists versions, and rolls back.
- **Rollback.** Unset the flag (no Artifact rows written; byte-identical).
- **Risk.** Low.

---

# 3. IDEAL WORKING MODEL (how to build this going forward)

1. **Evidence before change.** No edit without a cited `file:line` proving the current behavior. "UNVERIFIED" is a valid state; never call a thing broken/present without proof.
2. **Incremental + flag-gated, byte-identical-when-off.** Keep the discipline that produced this strong chassis — BUT pair every flag with a **default-on plan and an activation ticket**. A flag is a staging state, not a resting state. Track a "flags that should be on by now" list so flagship work never ships dark indefinitely.
3. **Activation is a first-class deliverable.** "Built + tested behind a flag" is 70% done, not 100%. Done = reachable in the default run profile, with a doctor check confirming it's live.
4. **No big rewrites.** Every phase above is wiring/activation/UI deltas on existing engines. Refactor token-by-token (e.g. the theme), surface-by-surface, never big-bang.
5. **Gate quality, don't snapshot it.** The eval harness, RLS tests, and schema-drift must gate PRs (Phase 7). A green that doesn't block a merge is decoration.
6. **Measure the runtime.** Real `/health`, a `doctor`, supervisor metrics. The system must be able to tell you what's wrong before a user hits a 500.
7. **Depth over "looks-like".** Prefer one Manus-class capability that actually works (search+cite, persistent auth browser, secret-safe visuals) over another panel. Optimize "runs like Manus" before "looks like Manus."
8. **ChatGPT-peer loop.** For each ticket: state problem + cited evidence → propose the smallest change → implement behind a flag if behavior-changing → add the gating test → flip the flag in the profile → confirm via doctor/eval. Review with an adversarial pass before commit.

---

# 4. COPY-PASTE APPLICATION PROMPTS (first 5 tickets)

> Each is self-contained for a Claude/coding agent. Repo root: `C:\Yeni klasör` (pnpm + Turborepo). Read the cited files first; do not assume.

### Prompt — TICKET-01 (Real `/health` + Prisma backoff)
```
You are implementing TICKET-01 in the AgentOS monorepo (repo root C:\Yeni klasör, NestJS-on-Fastify API).
GOAL: make /health a real readiness probe and stop the API from crashing when Postgres boots late.
READ FIRST (cite line numbers in your plan): services/api/src/health/health.controller.ts, services/api/src/prisma/prisma.module.ts, and how the Prisma/Redis providers are injected.
CHANGES:
1) In health.controller.ts: inject the Prisma service and (if present) the Redis connection token. Run `SELECT 1` and `redis.ping()` (Redis only checked when EXECUTION_MODE=queue). Return 200 with {status:'ok', postgres:true, redis:true|null, queueMode} when healthy; on any failure return HTTP 503 with the per-dependency map and which one failed. Do NOT include connection strings/secrets in the body. Add a separate GET /livez that stays a static {status:'ok'}.
2) In prisma.module.ts: wrap the onModuleInit $connect() in a bounded retry (10 attempts, 1s apart) before rethrowing; log each retry at warn.
ACCEPTANCE: with Postgres stopped, GET /health returns 503 naming postgres; starting Postgres ~5s after the API still lets the API come up. /livez always 200.
TESTS: add an integration test (or extend an existing health test) asserting 503-when-db-down and 200-when-up. Run the api test suite.
CONSTRAINTS: additive only; no change to the agent loop; keep it flag-free. Provide a one-line rollback (revert the two files).
```

### Prompt — TICKET-02 (`up.ps1` + `doctor.ps1`)
```
You are implementing TICKET-02 in AgentOS (repo root C:\Yeni klasör, Windows/PowerShell primary).
GOAL: one idempotent bring-up script and a doctor script.
READ FIRST: scripts/run-local.ps1 (reuse its .env parser), infra/compose.yaml (has pg_isready + redis ping healthchecks), README bring-up steps (~70-92), package.json scripts.
CREATE scripts/up.ps1: (a) docker compose -f infra/compose.yaml up -d; (b) poll pg_isready until Postgres healthy (timeout w/ clear error); (c) pnpm --filter @agentos/db exec prisma migrate deploy; (d) build the API only if services/api/dist/main.js is missing or older than src; (e) load .env via run-local.ps1's parser and start node services/api/dist/main.js; (f) poll the new GET /health (from TICKET-01) until ready; (g) start the web (npx serve apps/web/out). Fail fast with a named cause at each step.
CREATE scripts/doctor.ps1: checks and prints PASS/FAIL + fix hint for: Postgres reachable, schema migrated (prisma migrate status), brain configured, API port free, EXECUTION_MODE/RESUME_ENABLED + key feature flags summary, and web NEXT_PUBLIC_API_BASE matches API_PORT. Exit non-zero if any check fails.
ACCEPTANCE: from a cold machine, up.ps1 reaches a healthy /health and a reachable web app in one command; doctor.ps1 exits non-zero when Postgres is stopped, when dist is stale, or when web base != API port.
CONSTRAINTS: pure scripting; no source changes. Depends on TICKET-01's /health.
```

### Prompt — TICKET-03 (Activate durable runtime profile)
```
You are implementing TICKET-03 in AgentOS (repo root C:\Yeni klasör).
GOAL: run the durable execution path by default and surface a warning when running non-durably.
READ FIRST: .env (currently EXECUTION_MODE=inline, no RESUME_ENABLED), packages/config/src/env.ts:72-75 and :143-149, services/api/src/queue/queue.providers.ts, services/api/src/tasks/task.worker.ts, services/api/src/tasks/tasks.service.ts (onModuleInit, boot reaper :224-235, resumeOrphansOnBoot, sweepExpiredLeases), services/api/src/automations/automation.worker.ts.
CHANGES:
1) Set EXECUTION_MODE=queue, RESUME_ENABLED=true, AUTOMATION_RUNS_ENABLED=true in .env and mirror in .env.example with comments. REDIS_URL already present.
2) In tasks.service.ts onModuleInit, log a clear WARN if the effective profile is non-durable (inline mode, or queue mode with RESUME_ENABLED=false) stating in-flight crashes are not recoverable.
3) Verify the durable profile does NOT regress: run eval case 11-resume-after-crash and scripts/verify-resume.cjs (real process kill). Do NOT change engine/runner logic — this is activation only.
ACCEPTANCE: killing the API mid-task resumes and completes without re-running the completed step; a scheduled automation actually fires; the WARN is absent under the durable profile and present under inline.
ROLLBACK: revert .env to EXECUTION_MODE=inline (legacy path is byte-identical).
RISK: medium — this changes the running path; gate the start on Postgres+Redis readiness (TICKET-01) so a missing dependency fails loudly, not silently.
```

### Prompt — TICKET-04 (BullMQ stalled recovery + in-loop provider retry)
```
You are implementing TICKET-04 in AgentOS (repo root C:\Yeni klasör).
GOAL: stop silently losing crashed queue jobs and stop failing a whole run on one transient provider error.
READ FIRST: services/api/src/queue/queue.providers.ts (currently attempts:1, no stalled config), services/api/src/tasks/task.worker.ts, packages/agent-engine/src/engine.ts:285-296 (safeComplete) and :437-440.
CHANGES:
1) queue.providers.ts: set attempts:2 with exponential backoff; configure the Worker with a sane stalledInterval and maxStalledCount so a worker-death mid-job is redelivered even when RESUME_ENABLED is false.
2) engine.ts safeComplete: before emitting the non-recoverable error, retry provider.complete 1–2 times with short backoff (e.g. 500ms, 1500ms). Preserve ALL existing failure semantics on exhaustion (still emit recoverable:false and return null).
TESTS: add an integration test that instantiates the REAL TaskWorker (not a hand-rolled inline Worker) and asserts a stalled job is redelivered; add an engine unit test asserting a single transient throw retries then succeeds, and that repeated throws still fail as before.
ACCEPTANCE: worker death mid-job → job redelivered; a single transient 529 → the step retries and the task continues; exhausted retries → unchanged failure behavior.
ROLLBACK: revert the two files.
RISK: low–medium.
```

### Prompt — TICKET-05 (Enable multi-turn follow-up)
```
You are implementing TICKET-05 in AgentOS (repo root C:\Yeni klasör).
GOAL: make a finished task continuable (multi-turn follow-up), end-to-end.
READ FIRST: packages/config/src/env.ts:81-84 (FOLLOWUP_TURNS_ENABLED, server), apps/web/lib/config.ts:20-21 (NEXT_PUBLIC_FOLLOWUP_TURNS_ENABLED, web build-time), apps/web/components/TaskDetail.tsx:557-597 (reply composer/thread), services/api/src/tasks/tasks.service.ts:816-855 (sendFollowup, atomic re-open) and :825-826 (snapshot requirement), services/api/src/tasks/tasks.controller.ts:113-122.
CHANGES:
1) Enable FOLLOWUP_TURNS_ENABLED=true on the server (.env + .env.example) and NEXT_PUBLIC_FOLLOWUP_TURNS_ENABLED=true in the web build env. Confirm BOTH are set — the web composer and the server endpoint are gated independently.
2) Confirm the durable profile (TICKET-03) preserves the task snapshot across terminal so sendFollowup's snapshot requirement (:825-826) is satisfied; if running without TICKET-03, document that follow-up requires snapshot preservation.
3) Do NOT change the sendFollowup logic — it already does the atomic re-open and delta-only cost accounting.
TESTS: run task-followup.integration.test.ts (atomic re-open: many simultaneous follow-ups → exactly one run; per-run costs sum to cumulative estCostUsd). Manually: finish a task → reply → the SAME task continues as a new run resumed from prior conversation.
ACCEPTANCE: the reply composer renders on a finished task; a follow-up continues the same task with delta-only billing and one run per re-open.
ROLLBACK: unset both flags (endpoint 404s; finished task is byte-identical one-shot).
RISK: low. Best paired with TICKET-03 so snapshots persist across terminal.
```

---

*Full board dossier and CTO digest: `docs/MASTER-AUDIT.md` / `docs/MASTER-AUDIT-v2.md`. This roadmap: `docs/MASTER-ROADMAP-v2.md`.*
