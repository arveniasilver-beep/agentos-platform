# AgentOS — MASTER AUDIT v2 (CTO Synthesis)

*Evidence-based state report synthesized from 12 independent board audits (runtime, browser, coding, cost, ux, artifacts, security, automation, mobile, testeval, devops, research). Every load-bearing claim is carried up with file:line proof. Date: 2026-06-23. Branch: feat/policy-engine.*

---

## 1. How I understood the project — the real goal and the user's pain

**The goal.** AgentOS is an original, self-hosted, Manus/Devin/ChatGPT-Agent-class autonomous agent platform: a web app + Windows desktop where a (Turkish-speaking, quality-demanding) user gives a high-level task and watches an Opus-brained agent *plan → act → observe* — browsing live, editing code, running tools, producing durable deliverables — with a human-in-the-loop approval layer, durable execution that survives crashes, cost governance, and a mobile control panel. It is a pnpm+Turborepo monorepo: `apps/web` (Next.js static export), `services/api` (NestJS-on-Fastify), `packages/{agent-engine,tools,llm,config,db}`, Postgres+RLS, BullMQ, MinIO.

**The real engineering reality.** The *chassis* is genuinely strong and, in several places, world-class: an event-sourced durable task spine, a real CDP browser screencast with human take-over, a true edit==exec coding filesystem, hash-chained audit, RLS tenancy, and a deterministic eval harness that passes 44/44 live against Postgres. This is not a mockup — the live-execution core is Manus-grade.

**The user's pain (the "kopukluk" / disconnect).** The most impressive work is **dark by default**. The shipped local profile runs the *least* durable, least safe, least capable path. Eleven flagship subsystems sit behind OFF-by-default flags, and the actual `.env` enables none of them and runs `EXECUTION_MODE=inline` (verified: `.env:16` `EXECUTION_MODE=inline`, `ENABLE_SANDBOX=false` at `.env:18`, and none of the eleven `*_ENABLED` flags present). The result is a system that is *provably durable, safe, and capable in tests* yet *runs non-durably, unsafely, and stripped-down in practice* — plus a comfort layer (theme, onboarding, navigation, search, citations) that is missing or broken. The product is more capable than the running app, and the running app feels like a prototype.

---

## 2. Honest state vs world-standard, per subsystem

Legend: **STRONG** = works end-to-end, world-ish. **HALF** = built well but flag-gated/half-wired/unreachable. **PROTOTYPE** = visibly incomplete or misleading.

| Subsystem | Verdict | Strongest proof | Killer caveat |
|---|---|---|---|
| Durable task spine (event log, snapshots, lease/fencing) | **STRONG (engine) / HALF (shipped)** | append-only `TaskLog` with `@@unique([taskId,seq])` (`schema.prisma:591`); fenced heartbeat self-cancels (`task-runner.ts:253-266`); live-Postgres resume suite | `RESUME_ENABLED` defaults false (`env.ts:72-75`); `.env` runs `inline` → boot reaper *fails* in-flight tasks (`tasks.service.ts:224-235`) |
| Agent loop (plan/act/observe) | **STRONG** | refusal/max_tokens/empty = failure, not fake "Done" (`engine.ts:446-479`); live `update_plan` checklist | every provider throw is terminal — no in-loop retry (`engine.ts:285-296`) |
| Live browser operator (screencast + take-over) | **STRONG (live feel) / HALF (safety)** | real CDP `Page.startScreencast` → `socket.volatile.emit` → live `<img>` (`browser-tools.ts:99-105` → `agent.gateway.ts:121-123`); human-control mutex (`browser-tools.ts:62-83`) | headless-only, no persistent login; frames/screenshots leak secrets unredacted; `BROWSER_OPERATOR_ENABLED` off (`env.ts:168-171`) |
| Coding workspace (edit==exec) | **STRONG (kernel) / PROTOTYPE (product)** | one host dir is edit target AND `/work` bind-mount (`coding.service.ts:39-42` + `tools.factory.ts:188-191`); strict patch engine throws on mismatch (`diff.ts:119`) | off by default; default image `alpine:3` can't run node; `networkDisabled:true` → no `npm install`; no UI/preview |
| Web research | **PROTOTYPE** | real loop + wide-research map-reduce (`tasks.service.ts:711-769`) | **NO web_search tool exists** (verified: grep of `packages/tools/src` → zero); no citations; no `research` mode; 12-step default |
| Cost / context | **HALF** | Opus 4.8 pricing exact (`cost.ts:11-16`); per-task budget enforced (`engine.ts:280-281`) | **prompt caching never requested** (`anthropic-provider.ts:114-123` has no `cache_control`) — every step re-pays full input; workspace/project caps schema-only |
| Artifacts | **STRONG (storage) / HALF (lifecycle)** | blob-first crash-safe register (`artifacts.service.ts:307,343`); content-addressed versioning, RLS, 11 tests | `ARTIFACT_PERSISTENCE_ENABLED` off + unset everywhere → zero rows ever; no version history/rollback/share UI |
| Security / policy | **STRONG (design) / PROTOTYPE (default)** | catastrophic-shell/SSRF/secret classifiers (`classifiers.ts`); hash-chained audit; RLS fail-closed boot guard (`prisma.module.ts:44-50`) | `POLICY_ENGINE_ENABLED` off; legacy gate uses strict `>` so `high > high = false` (`engine.ts:545`) → only 2 tools ever pause; secrets stored RAW at rest (`task-runner.ts:218,491`) |
| Automation / workflows | **STRONG (engine) / PROTOTYPE (shipped)** | idempotent minute-bucket fire key + overlap-skip + retry, 7 tests (`automation-runs.service.ts`) | all 3 flags off + `inline` → **nothing ever fires**; Workflow nav unconditionally mounted but `create` 404s (`workflow.controller.ts:18-19`); UI advertises cron triggers the DSL rejects |
| Mobile control panel | **STRONG (auth) / PROTOTYPE (reach)** | hash-only device tokens, fail-closed revoke, per-device audit, live tests | **no pairing UI mints a token** (`setDeviceTokenProvider` never called in `apps/web`); no service worker; `/m` shows a config-instruction stub to users |
| UX / product | **STRONG (task surface) / PROTOTYPE (comfort)** | real streaming + REST fallback; approvals UX; ⌘K palette | **theme toggle is dead** — 0/26 components use a `dark:` variant, 117 hardcoded `bg-slate-9x0`; modal-launcher nav with no where-am-I |
| QA / eval | **STRONG (harness) / HALF (not gating)** | 44/44 live against Postgres; working negative self-test; RLS tested under least-priv role | **eval never runs in CI** (`grep -c eval ci.yml` = 0); no UI E2E; no migration drift gate; RLS proven on 1 table |
| Local-run / devops | **PROTOTYPE** | correct compose healthchecks; fail-fast env | no `up` command (5 manual steps); `/health` is a static literal (`health.controller.ts:13-20`); Prisma `$connect` no retry → crashes if PG late |

---

## 3. TOP 20 ROOT PROBLEMS (ranked by impact)

Each: **problem → root cause → evidence → user-felt symptom.**

1. **The flagship reliability/safety/capability work is OFF by default.** *Cause:* every hardening ticket shipped behind an OFF flag under a "byte-identical when off" contract; the shipped `.env` enables none. *Evidence:* `env.ts:72-171` (11 flags default false), `.env:16-18` (`inline`, sandbox off). *Symptom:* the product the user runs is the old, permissive, non-durable one; everything impressive is invisible.

2. **No process supervisor / one-command bring-up; runtime is the user's job.** *Cause:* API runs on host outside compose, started by hand alongside `npx serve`. *Evidence:* no `up`/`dev:local` in `package.json`; `run-local.ps1` only injects env + runs node (no build/migrate/wait); stray `api-live.log`/`api-mock.log`/`web-serve.log` in repo root. *Symptom:* "service keeps dying, I restart it by hand."

3. **There is NO web_search tool in a web-research product.** *Cause:* breadth-first build never specialized the research payload. *Evidence:* grep of `packages/tools/src` returns zero `web_search` matches (verified); it exists only as a dead UI label (`TaskDetail.tsx:657`). *Symptom:* the agent can't discover anything it doesn't already have a URL for.

4. **In-flight crashes lose work in the shipped config.** *Cause:* `inline` + resume-off → boot reaper *fails* orphans; queue mode has `attempts:1` + no stalled-job config. *Evidence:* `tasks.service.ts:224-235`; `queue.providers.ts:45`; `void this.runTask()` fire-and-forget (`tasks.service.ts:349`). *Symptom:* a multi-minute task dies on any restart with "Interrupted by a server restart."

5. **Prompt caching is priced but never requested → every step re-pays full input.** *Cause:* provider is a one-shot wrapper with no cacheable-prefix notion. *Evidence:* `anthropic-provider.ts:114-123` has no `cache_control`; repo-wide search finds it only in docs. *Symptom:* multi-step tasks cost 2–5× what they should; cache columns dead.

6. **Nothing risky is approval-gated by default.** *Cause:* policy engine off; legacy gate uses strict `>` and no tool is `critical`. *Evidence:* `engine.ts:545` `RISK_ORDER[riskLevel] > RISK_ORDER[riskCeiling]` with default ceiling `high` → `2>2=false` (verified); only `publish_site` + local delete have `approvalRequired:true`. *Symptom:* `shell_exec`, `write_file`, `http_fetch`, all browser writes run fully unattended.

7. **Secrets are persisted RAW at rest in the durable trace.** *Cause:* redaction treated as a presentation concern, applied only on the share read-path. *Evidence:* `ToolCall.args = event.input` verbatim (`task-runner.ts:491`); `TaskLog.payload` verbatim (`task-runner.ts:218`); `redactText` never on a write path. *Symptom:* a `curl -H 'Authorization: Bearer …'` lands in plaintext, readable by anyone with DB/task-detail access.

8. **The theme toggle is a dead button — the strongest "prototype feel" defect.** *Cause:* no design-token / `dark:`-variant layer; colors hardcoded inline. *Evidence:* 0/26 components use a `dark:` variant; 117 hardcoded `bg-slate-9x0`; toggle only swaps an icon (`WorkspaceView.tsx:243-265`). *Symptom:* clicking "light theme" changes nothing; app is permanently dark.

9. **Automations never fire in the shipped config.** *Cause:* scheduling requires `EXECUTION_MODE=queue`; `.env` is `inline`. *Evidence:* `automation.worker.ts:23` returns if not queue; `automations.service.ts:283` no-ops if `queue` null. *Symptom:* you create an automation, see its cron, and it never runs.

10. **Workflow Builder 404s on first click.** *Cause:* UI reachability decoupled from backend gating. *Evidence:* nav mounted unconditionally (`WorkspaceView.tsx:122`) but `WorkflowController.create` throws `NotFoundException` when flag off (`workflow.controller.ts:18-19`). *Symptom:* a visible feature fails immediately; UI copy even advertises cron triggers the DSL rejects (`workflow-dsl.ts:47-51`).

11. **The eval harness — the best work in the repo — never gates merges.** *Cause:* built beside CI, not into it. *Evidence:* `grep -c eval ci.yml` = 0; `ci` script lacks `pnpm eval`. *Symptom:* a security/behavior regression can go red and still ship.

12. **Live browser frames and screenshots leak secrets.** *Cause:* redaction is text-only (`browser_read`); the visual channel has none. *Evidence:* `redactWebSecrets` only touches read text (`browser-tools.ts:393`); JPEG frames + auto-PNGs are raw pixel captures saved as durable artifacts. *Symptom:* typed passwords/OTPs/banking dashboards stream to the client and land on disk unmasked.

13. **No persistent/authenticated browser → can't do most real agent work.** *Cause:* `headless:true`, fresh `newContext` per task, no `storageState`. *Evidence:* `browser-tools.ts:115-118`; `tools.factory.ts:162`. *Symptom:* the agent starts logged-out everywhere; cannot operate any site the user is signed into.

14. **No clarifying questions / editable plan before a long run.** *Cause:* engine plans silently then immediately executes. *Evidence:* `engine.ts:323-346`. *Symptom:* the user can only watch or Stop — the #1 trust pattern of deep-research products is absent.

15. **Default runs are cost-unbounded; workspace/project caps unenforced.** *Cause:* `costBudgetUsd` optional with no default; hierarchy is schema-only. *Evidence:* `dto.ts:15` optional; repo-wide search for `budgetCapUsd`/`costThresholdUsd` in services = 0. *Symptom:* a tool-loop is bounded only by 12 steps, not dollars; no spend ceiling.

16. **Coding loop is a dead-end: can't install deps, default image can't run node.** *Cause:* security sandbox repurposed as dev env. *Evidence:* `SANDBOX_IMAGE` default `alpine:3` (`env.ts:46`); coding session `networkDisabled:true` (`tools.factory.ts:189`). *Symptom:* the agent edits, "runs tests," and fails on missing modules with no recourse.

17. **No durable artifact panel / no version history by default.** *Cause:* durable store built as a flag-gated shadow of the sandbox file list. *Evidence:* `ARTIFACT_PERSISTENCE_ENABLED` off + unset; `listDurable` returns only current version (`artifacts.service.ts:387-390`); no rollback/regenerate endpoints. *Symptom:* deliverables feel like files in a temp folder; versions stored but never viewable.

18. **`/health` lies and Prisma boot has no dependency-wait.** *Cause:* health asserted, not measured; no retry/backoff on `$connect`. *Evidence:* `health.controller.ts:13-20` static `{status:'ok'}`; `prisma.module.ts:19` bare `$connect()`. *Symptom:* API reports "ok" while DB is down; crashes if Postgres is late after a Docker restart.

19. **Mobile is unreachable: no pairing flow ever mints a token.** *Cause:* backend-first sequencing left a complete auth spine with no head. *Evidence:* `setDeviceTokenProvider` defined but never called in `apps/web`; no `POST /auth/devices` call from any UI; no service worker. *Symptom:* `/m` shows a config-instruction stub; the secure device system is reachable only via curl.

20. **Connector capability-scope enforcement is audit-only theater.** *Cause:* `checkAction` wired as a post-hoc observer, not a pre-exec choke point. *Evidence:* called in `applySideEffect` after the gate with `.catch(()=>undefined)` (`task-runner.ts:528-530`); writes an audit row but never blocks. *Symptom:* a connector action with insufficient granted scopes still runs.

---

## 4. The most important DIFFERENCES vs Manus / Devin / ChatGPT-Agent (the "feel" gaps)

- **Durability is a flag, not a posture.** Devin never loses a multi-hour run to a pod restart; AgentOS does in its default config. The durable machinery exists and is tested — it's just off.
- **No first-class search + no citations.** Manus/ChatGPT-Agent/Perplexity lead with search and earn trust via inline sources. AgentOS produces un-sourced prose and can't discover URLs — the *appearance* of research without the verifiable substrate.
- **No confirm-plan-then-run-long loop.** Competitors ask clarifying questions, let you edit the plan, then run for many minutes. AgentOS plans silently, runs immediately, and caps at ~12 steps.
- **No iterative conversation by default.** The follow-up composer is built but flag-gated off; a finished task is a one-shot dead-end — the opposite of the Manus loop.
- **No persistent authenticated browser, no replayable computer session, no DOM-grounded acting.** The live take-over feel is genuinely good and matches Manus; but it's headless/logged-out, ephemeral (no recorded scrub), and the model flies blind between screenshots (no AX/DOM snapshot).
- **No always-on, can't-be-disabled risky-action gate.** Manus non-optionally gates send-email / payment / publish / credential use with an approval card. Here those run unattended by default.
- **No light theme, no onboarding, no where-am-I navigation.** Manus is light-first with a persistent rail and seeded examples; AgentOS is permanently dark with a modal-launcher and a bare composer.
- **Mobile is a read-mostly monitor, not a control client, and you get no push when the agent is blocked.** Where it *matches*: the mobile security posture (hash-only tokens, fail-closed revoke, minimal snapshot) is genuinely Manus-class.

---

## 5. LOW-RISK / HIGH-IMPACT immediate fixes (ranked)

1. **Ship a working run profile + one `scripts/up.ps1`.** Set `EXECUTION_MODE=queue`, `RESUME_ENABLED=true`, `AUTOMATION_RUNS_ENABLED=true`, `WORKFLOW_BUILDER_ENABLED=true`, `SKILLS_PLAYBOOKS_V2_ENABLED=true`, `ARTIFACT_PERSISTENCE_ENABLED=true` (+ `ARTIFACT_STORE_ROOT`), and add an idempotent script: compose up → wait `pg_isready` → migrate → build-if-stale → start → poll `/health`. *Files:* `.env`, `.env.example`, new `scripts/up.ps1`. **Single highest leverage:** activates a huge body of already-tested code with near-zero code change.
2. **Make the eval gate PRs.** Add `- run: pnpm eval` to `ci.yml` after Test; optionally add `pnpm eval` to the `ci` script. Turns 44 green cases from decorative to load-bearing.
3. **Add prompt caching to the Anthropic provider.** Put `cache_control:{type:'ephemeral'}` on the last `system` block and last tool def in `anthropic-provider.ts:114-123`. Immediate per-step input-cost cut; activates the dead cache pricing.
4. **Add a real `web_search` tool.** New `packages/tools/src/web-search-tool.ts` (SSRF-safe via `assertAllowedUrl`), wire in `tools.factory.ts`. The UI category already exists; unlocks discover→fetch→synthesize.
5. **Default the gate to actually gate `high`.** Ship `riskCeiling` default `'medium'` (`dto.ts:13`) or change `>` to `>=` at `engine.ts:545`. Out-of-box, `shell_exec`/`write_file`/`http_fetch` pause for approval.
6. **Redact the persisted trace.** Wrap `event.input`/`event.output` through existing `redactText` before `toolCall.create`/`taskLog.create` (`task-runner.ts:218,491,541`).
7. **Make `/health` a real readiness probe + add Prisma connect-with-backoff.** `health.controller.ts` runs `SELECT 1`/`redis.ping()` → 503 on failure; `prisma.module.ts:19` bounded retry. Kills the #1 boot crash and the "mysterious disconnect."
8. **Mask passwords in the screencast.** Inject CDP CSS to blur `input[type=password]` before `Page.startScreencast` (`browser-tools.ts:86-110`). Removes the worst visual leak.
9. **Gate the Workflows nav on its flag + fix false "schedule (cron)" UI copy** (`WorkspaceView.tsx:122`, `WorkflowsPanel.tsx:84`). Removes a broken-on-first-click feature and a direct lie.
10. **Add an active-nav state + kill/relabel the dead theme toggle + seed 3-4 starter prompts** (`WorkspaceView.tsx`). Large perceived-quality jump.
11. **Wire OpenAI-compat registry pricing + a default per-task cost budget** (`llm-provider.factory.ts:140-147`, `tasks.service.ts:314`). Stops $0 metering and unbounded runs.
12. **Add a "Paired devices" settings page** calling the already-built `POST /auth/devices` (QR + copy-once). Converts the dead mobile spine into a reachable feature.

---

## 6. BIG architectural risks

- **No single "task supervisor" owns redelivery.** Redelivery is split across BullMQ attempts, the boot reaper, `resumeOrphansOnBoot`, and `sweepExpiredLeases` — each flag-gated differently. The inline/queue × resume-on/off matrix yields four behaviors with gaps in two. Nothing guarantees "every non-terminal task is running, leased, or queued."
- **Two parallel stacks per domain, gated by divergent defaults.** Browser (capability ON / safety OFF), artifacts (sandbox-files vs durable shadow), templates (Playbooks client-side vs Skills server-side). The powerful half ships on, the safe/durable half off — the unsafe configuration is the default.
- **Cost is a single scalar attributed to one model string** while the Model Router, deliberation peer, and compaction summarizer all use different models/pricing — attribution and pricing break under routing (`task-runner.ts:317` records default-profile model via `pick({})`).
- **Engine treats every dependency failure as terminal** (`engine.ts:285-296`) — durability covers infra crashes but not the more common dependency flakiness (a single transient 529 kills an expensive run).
- **Enforcement vs observation are conflated** — the only real pre-exec choke point (engine gate) doesn't consult connector scopes or redaction; both are wired as after-the-fact observers.
- **Web↔API coupling is build-time** (`NEXT_PUBLIC_API_BASE` baked into the static export) — change `API_PORT` and the bundle silently points at the wrong place.

---

## 7. UX / product-quality problems

Dead theme toggle (no token layer; 117 hardcoded slate classes). Modal-launcher navigation with no active state / breadcrumb (you never know where you are). Follow-up chat, mobile, and light theme all flag-gated off — the three most Manus-feeling capabilities are dark in the default build. No onboarding / empty-first-run guidance (bare "What can I do for you?"). Inconsistent loading states (Insights/Knowledge flash empty). `window.prompt`/`confirm` for core flows (rename, new project, delete, elevated confirm). Plan is a flat checklist with no single "Agent is: browsing / waiting on you / thinking" status line. Workflow authoring is raw JSON in a textarea — unusable for a non-technical user. Mobile is read-mostly with no composer.

## 8. Token / cost / context problems

No prompt caching (the #1 cost defect — full input re-billed every step). OpenAI-compat brains meter at $0 unless the user hand-types pricing (registry pricing dead, `llm-provider.factory.ts:140-147`). Default runs cost-unbounded; workspace/project caps schema-only/unenforced. Router mis-attributes usage to the default profile's model and can mis-price every routed call. Two cost ledgers (live `estCostUsd` vs durable `CostRecord`) with no reconciliation — crashes undercount spend. Compaction is message-count-based (`>40`), divorced from real tokens; `countTokens` exists but is unused for context decisions. Full tool list re-sent every step with no narrowing (compounds the no-cache problem). UI shows only input+output tokens as "~$" estimate; cache tokens and the `overThreshold` warning never rendered.

## 9. Runtime / browser / coding-workspace problems

**Runtime:** durability off by default; production `TaskWorker` never tested (the queue test reconstructs its own inline worker); inline vs queue reliability asymmetry surfaced nowhere; `maxToolErrors` hardcoded (not config-wired); every provider throw terminal (no in-loop retry). **Browser:** durable operator layer dead by default → page text re-enters the model un-fenced (prompt-injection) and unredacted (token-leak); `closeSession`/`setTakeover` never called → sessions stranded at status `acting`, take-over invisible in audit; frames/screenshots leak secrets; headless-only no-login; zero test coverage for the live-view/take-over path; `screenshotArtifactId`/`approvalId` columns dead. **Coding:** off by default + sandbox off locally; default `alpine:3` can't run node; `networkDisabled:true` → no `npm install`; `write_file` large-diff gate counts file size not changed lines (`policy.service.ts:82`); no workspace UI / file tree / terminal / preview / dev-server; always starts in an empty room (no repo ingestion, no persisted `node_modules`); live runner UNVERIFIED on this host (Docker won't boot).

## 10. Security / policy / test / eval gaps

**Security:** policy engine dead by default; nothing risky gated even by the legacy gate; connector scope-check is audit-only theater; raw secrets at rest; audit hash chain doesn't cover `metadata`/`risk`/`actorType` (partial tamper-evidence) and the write is racy (read-then-create can fork the chain). Connector tools (`gmail_send`/`outlook_send`) aren't classified at all → fall through to `allow`. **Test/eval:** strongest domain — 44/44 live, working negative self-test, RLS under least-priv role — but **never gates CI**; zero web-UI/browser-flow E2E; no migration/schema-drift gate; RLS proven on exactly 1 of ~40 tables; coding eval uses a stub runner (not Docker); resume eval is in-process simulation (not a real process kill); no semantic/LLM-judge or trajectory-at-scale eval to tell "ran" from "did it correctly."

## 11. HONESTY ASSESSMENT

**Can this realistically reach Manus-level short-term?** Partially, and faster than it looks — *because the gap is overwhelmingly configuration and comfort-layer, not missing engines.* The hard, expensive kernels (durable execution, live browser, edit==exec coding, RLS, audit, eval harness) are built and tested. A focused 2–4 week push on the Section 5 quick wins (turn the durable profile on, add search + citations + caching + real gating + a supervisor + readiness/health + the comfort layer) would move the *felt* product from "impressive prototype" to "credible Manus-class" without a rewrite. The honest blocker is not capability — it's that the team optimized "looks like Manus" and breadth (21 tickets) over "researches/runs like Manus" and depth, and shipped everything dark.

**Modules BETTER than expected:** (1) the durable task spine — genuinely event-sourced, lease/fenced, with a live-Postgres crash/resume/dedup/poison test suite that exercises the hard cases. (2) the eval harness — real, deterministic, secret-safe, with a *working negative control* (self-test that proves it can fail), passing 44/44 live. (3) the mobile *security* model — hash-only tokens, fail-closed owner-scoped revoke, no-token-in-localStorage, minimal snapshot. (4) the coding *kernel* — true edit==exec FS + strict patch + symlink-safe path resolution. These are not prototype-grade.

**"Rewrite-tempting but actually a small delta":** the cost layer (looks broken — $0 metering, no caps, no caching — but each is a localized wire-through: one `cache_control`, one registry-pricing fallback, one default budget). The Workflow Builder 404 (looks like a broken feature; it's one flag/nav-gate). The dead theme (looks like a missing design system; the plumbing/bootstrap already exists — it's `dark:`-variant discipline on existing files). Mobile (looks unbuilt; the entire backend spine is done — it needs one pairing page). The whole "nothing fires / not durable" complaint (it's `.env` + a launcher script, not code).

**"Looks small but is a deep problem":** (1) **secret-safety of the visual + at-rest channels** — masking passwords in a screencast and redacting the trace touches a cross-cutting boundary nobody owns (presentation vs persistence vs visual); doing it *correctly* (DOM-region masking, not just text) is real work. (2) **prompt-injection of un-fenced web content** — flipping the flag helps, but DOM-grounded, fenced, citation-tracked research is a genuine architecture, not a toggle. (3) **persistent authenticated browser** — `storageState`/profile persistence + credential handling is a security-sensitive subsystem, not a config change. (4) **a true task supervisor** owning redelivery across the inline/queue/resume matrix — unifying four divergent mechanisms is design-altitude work. (5) **per-call cost ledger under routing** — the "one model, one cost" assumption is baked into the schema and accumulator; fixing attribution is more than a wire-through.

**Bottom line:** AgentOS is a strong, occasionally world-class *engine* wearing a prototype's clothes. The single most honest sentence in this report: *it is provably durable, safe, and capable in tests, and runs non-durably, unsafely, and stripped-down in practice — and the distance between those two is mostly a profile, a launcher, and a comfort layer, not a rewrite.*
