# AgentOS — Scope, Capability Map & Phase Plan

> **Status:** Planning only (no code in this document).
> **Owner:** Lead Product Architect.
> **Companion docs:** `_research/MANUS_TEARDOWN.md`, `_research/BUILD_BLUEPRINT.md`.
> **Codename:** `AgentOS` — trivially renameable. Every user-facing string and protocol scheme derives from a **single source of truth**: `packages/brand/brand.config.ts` exporting `PRODUCT_NAME`, `PRODUCT_SLUG`, `DEEP_LINK_SCHEME`, `APP_PROTOCOL`, `APP_USER_MODEL_ID`, `SUPPORT_URL`. No literal product name appears anywhere else in code, packaging, or copy. Renaming = edit one file + regenerate assets.

---

## 0. Document map

| § | Section | Spec item |
|---|---|---|
| 1 | Final project scope (is / is NOT for v1) | 1 |
| 2 | Manus-style capability mapping → AgentOS originals | 2 |
| 3 | Features that will DEFINITELY exist | 3 |
| 4 | MVP features (smallest end-to-end proof) | 4 |
| 5 | Later-phase features | 5 |
| 6 | Development phases (Phase 0..N) + ordering rationale | 35 |
| 7 | Acceptance criteria per phase | 36 |
| 8 | Risks & mitigations | 37 |
| 9 | First concrete coding step after approval | 38 |
| A | Appendix: 30 module categories → phase map | (mapping) |

---

## 1. Final project scope

### 1.1 One-sentence definition
**AgentOS is a production-grade, security-first AI agent operating platform** that turns a natural-language task into a planned, decomposed, tool-routed, auditable execution — across cloud and *approved* local computer resources — delivered through **both a web app and a real Windows desktop app**, defaulting to Claude Opus (`claude-opus-4-8`) behind a clean provider abstraction.

### 1.2 What AgentOS IS (for v1)
- A **task-execution platform**, not a chat toy. The unit of work is a **Task** with a plan, steps, tool calls, artifacts, an audit log, and a verified final deliverable.
- An **agent runtime** running the core loop: *understand → plan → decompose → route to tools → act (browser/files/APIs/local) → log → ask approval on risk → recover from errors → verify → deliver.*
- A **two-surface product**: shared UI consumed by (a) a browser web app and (b) an Electron Windows desktop app. Architecture is OS-portable (macOS/Linux later) and the desktop adds a **local operator bridge** (sidecar) to operate **explicitly approved** local resources.
- **Security-first and auditable**: every action carries a **risk level** (`low | medium | high | critical`); `high`/`critical` require **explicit approval**; the user can **stop any action instantly**; sensitive data is masked; every important action is logged.
- **BYO-model & cost-aware**: API key entered in settings, **encrypted at rest, never exposed to the frontend**. Tokens and cost tracked per task / workspace / user / month; expensive tasks get a **pre-flight cost estimate**; context management, prompt caching, summarization, file chunking, and memory retrieval minimize spend and private-data exposure.

### 1.3 What AgentOS is NOT (for v1)
- **Not a bare chatbot / Q&A box.** Conversation exists only as the task-driving surface.
- **Not a Manus clone.** No copied branding, UI, copy, names, design, or code. We mirror the *capability category* with original implementations and a different architecture (local-first option, BYO-model, per-tool auditable permissions, open MCP/tool layer, sandboxed renderer, PKCE auth, container/microVM-per-session).
- **Not a captcha/2FA bypass tool.** Hard rule: never bypass CAPTCHA/2FA; on encountering them the agent pauses and hands control to the user.
- **Not an unattended destructive-automation engine.** High/critical actions always gate on approval; the agent never self-authorizes irreversible operations.
- **Not multi-OS at v1 desktop.** Windows is the v1 desktop target; macOS/Linux are architected-for but **later phase**.
- **Not multi-cloud-LLM at v1.** Anthropic (`claude-opus-4-8`) is the default and only required provider for v1; the **provider abstraction** is built so additional providers are a later, low-friction addition.
- **Not a fake/demo.** No placeholder endpoints/buttons, no TODOs in core paths, no module shipped "done" without passing tests.

### 1.4 Non-negotiable hard rules (apply to every design decision)
1. No fake endpoints/buttons; no placeholders/TODOs in core functionality.
2. No module marked done without passing tests.
3. Security-first; no secrets in the frontend; API keys encrypted at rest.
4. Every action has a risk level; `high`/`critical` require approval.
5. User can stop any action instantly (global kill switch + per-action stop).
6. Sensitive data masked in UI, logs, and model prompts.
7. No CAPTCHA/2FA bypass; no spam/abuse/ToS violations.

---

## 2. Manus-style capability mapping (each category → AgentOS original)

> Source categories distilled from `MANUS_TEARDOWN.md`. Right column = our **original** equivalent, with the differentiator and MVP/Later tag.

| # | Manus-style capability | AgentOS original equivalent | Differentiator | Tag |
|---|---|---|---|---|
| C1 | Server-side agent brain (planner/loop, model-blind client) | **Agent Runtime**: plan→act→observe→replan ReAct loop; client is a thin renderer of streamed step events | Open, documented event/tool ABI; step budgets + kill switch built in | **MVP** |
| C2 | Cloud sandbox VM (`manus.computer`) | **Session Sandbox**: container-per-session (gVisor) → microVM (Firecracker) at density; exposes shell/files/headless-browser over WS | Isolation choice documented; idle-reaping; local-first alternative | **MVP** (container) |
| C3 | Typed tool catalog (server-only, client renders `tool_call`) | **Tool Registry**: typed schema + **risk tag** + permission scope per tool; one ABI shared by client render + sandbox exec | Per-tool revocable permissions, risk-gated approval | **MVP** |
| C4 | "Computer" panel (live terminal/editor/browser; VNC + cloud VS Code) | **Live Activity Panel**: streamed terminal/file/browser view; VNC + in-cloud code server **later** | Per-action audit overlay; takeover with approval | **MVP** (read view) / VNC **Later** |
| C5 | My Computer sidecar (local file/shell bridge, `device_config`/`device_status`) | **Local Operator (sidecar)** + reconcile loop; signed/hash-pinned binary; PID lockfile | Per-tool revocable scopes, read-only vs read-write, OS jail, per-action approval, live "what it touched" log | **MVP-lite** (files RO) / full shell **Later phase** |
| C6 | My Browser / Takeover (agent drives user's local browser) | **Preferred Browser operator** + **Takeover**: agent drives an approved local browser profile; user reclaims control instantly | Explicit per-domain consent; no CAPTCHA/2FA bypass; instant takeover | **Later** |
| C7 | Deep-link OAuth login (`manus://?token`) | **PKCE deep-link auth** (`<scheme>://?code=` → HTTPS code exchange) | One-time code over HTTPS (no plaintext token interception) | **MVP** |
| C8 | Realtime channel (Socket.IO, `auth:{token}`, `/device` namespace) | **Realtime bus**: socket.io, typed event contracts, token in `auth` handshake, redacted logs, namespaced `chat`/`device` | Typed shared contracts; staged backoff + epoch-guarded op queue | **MVP** |
| C9 | Projects (group related tasks) | **Projects**: container grouping Tasks, shared files, memory, settings | Per-project budget caps + permission profiles | **MVP-lite** / depth **Later** |
| C10 | Scheduled tasks (cron) | **Automations**: cron + event triggers (mail-to-task, webhooks) | Approval policy per automation; dry-run preview | **Later** |
| C11 | Inbox (async results / approvals) | **Inbox**: approval requests, finished deliverables, agent questions | Risk-tagged approval queue with one-tap stop | **MVP-lite** (approvals) / full **Later** |
| C12 | Library (saved outputs/assets) | **Library / Artifact Store**: versioned artifacts, presigned up/download | Content-addressed, audit-linked artifacts | **MVP-lite** (artifacts) / browse UI **Later** |
| C13 | Wide Research / map-reduce sub-agents | **Parallel Research**: coordinator spawns N sub-sessions, reduces results | Per-sub-agent budget + isolation | **Later** |
| C14 | Memory / Knowledge / Playbooks / preferences | **Memory & Skills**: vector knowledge store, preferences, **Skills** = saved parameterized task graphs | Privacy controls on what reaches the model | **Later** |
| C15 | Deliverable generators: slides, images, video, audio, sheets, reports, websites | **Generators**: reports + spreadsheets (MVP-lite) → slides/design/multimedia/website-builder (Later) | Original viewers; deploy pipeline with preview vs published | **Later** (reports MVP-lite) |
| C16 | Deploy/hosting pipeline (`manus.space`, custom domains) | **Publish pipeline**: object-store static hosting, preview vs published, CNAME custom domains | Per-site access controls | **Later** |
| C17 | Connectors / first-party OAuth (Slack/GitHub/Gmail/Drive/Notion/Linear…) | **Connectors**: OAuth in sandboxed child window w/ proper callback | No main-window navigation into 3rd-party sites; scoped tokens brokered server-side | **Later** |
| C18 | MCP (user-installed servers) + skills marketplace | **MCP layer**: install/manage MCP servers; open tool layer | Sandboxed MCP exec, per-server permission scopes | **Later** |
| C19 | Billing / credits / quota / tiers | **Usage & Billing**: metered tokens→cost; per-task/workspace/user/month; quota & tiers | Pre-flight cost estimate; hard budget caps | **MVP-lite** (metering) / billing **Later** |
| C20 | QuickAsk launcher (Spotlight pill, STT) | **Quick Launcher**: global-hotkey pill, optional STT, hands off to workspace | Shipped **enabled** + cross-platform (Manus shipped dormant/macOS-only) | **Later** |
| C21 | Presenter window (multi-monitor slides) | **Presenter mode**: multi-monitor deliverable presentation | Cross-platform parity | **Later** |
| C22 | Replay / public share | **Replay & Share**: re-render persisted event stream; public links | Sensitive-data masking in shared replays | **MVP-lite** (replay) / public share **Later** |
| C23 | Telemetry sprawl (Amplitude+Sentry+Segment+Thumbmark+AppsFlyer) | **One first-party telemetry pipeline + Sentry (errors only)** | Minimal privacy/compliance surface; no fingerprinting at v1 | **MVP** |
| C24 | Feature flags / secrets baked into static bundle | **Server-driven flag service; keys never in bundle** | No secret-in-bundle, no dev-endpoint leaks | **MVP** |
| C25 | Admin / enterprise (`docs.manus.ai/enterprise`) | **Admin console**: workspace/users/roles, audit export, budget policy | RBAC + audit-first | **Later** |
| C26 | Collaboration (Team tier) | **Collaboration**: shared workspaces, roles, shared tasks/comments | Permission-scoped sharing | **Later** |
| C27 | Mail-to-task / Slack/webhooks ingestion | **Mail-to-Task & webhook triggers** | Sender allowlist; approval before execution | **Later** |
| C28 | Meeting capture | **Meeting module**: transcript ingestion → action items/tasks | Consent + on-device option | **Later** |
| C29 | Public/developer API + OAuth apps | **Public API**: REST + webhooks + OAuth apps; documented contracts | Scoped tokens, rate limits | **Later** |
| C30 | Packaging (NSIS + MSIX), auto-update | **Packaging**: NSIS/exe (auto-update feed) + MSIX (Store); signed, pinned | Signed sidecar + update channel; Store-safe | **Later** |

---

## 3. Features that will DEFINITELY exist (committed for v1 line, across phases)

These are committed product capabilities; the *phase* in which each lands is in §6/Appendix A. "Definitely exists" ≠ "in MVP".

**Agent core**
- Natural-language task intake with intent understanding.
- Planner that produces an explicit, inspectable **plan** and **step decomposition**.
- ReAct execution loop with **replanning** on failure and **step/cost budgets**.
- **Verification step**: the agent checks results before declaring done.
- **Error recovery**: retries with backoff, alternative tool routing, graceful give-up with explanation.

**LLM provider**
- Default **Claude Opus `claude-opus-4-8`** via Anthropic API behind a **provider abstraction** (`LlmProvider` interface).
- API key in settings, **encrypted at rest**, **never sent to frontend**.
- **Token + cost accounting** per task/workspace/user/month.
- **Pre-flight cost estimate** for expensive tasks.
- Context management: prompt caching, summarization, file chunking, memory retrieval; minimize private data sent to the model.

**Tools & execution**
- **Tool Registry** with typed schemas, **risk levels**, and **permission scopes**.
- Cloud **Session Sandbox** (container-per-session) providing shell, files, headless browser.
- **File / artifact** read-write with versioning and presigned transfer.
- **Queue + worker** execution layer for durable, resumable task runs.

**Safety & control**
- Per-action **risk level**; **approval gate** for `high`/`critical`.
- **Instant stop** (global + per-action).
- **Audit log** of every important action.
- **Sensitive-data masking** in UI, logs, and prompts.
- No CAPTCHA/2FA bypass; ToS-respecting browser automation.

**Surfaces**
- **Web app** + **Windows desktop app** sharing one UI codebase.
- Two-pane workspace: plan/conversation + **Live Activity Panel**.
- **PKCE** desktop auth; web session auth.
- Workspaces / Projects / Tasks hierarchy.

**Platform**
- Realtime streaming of step events.
- Replay of persisted event streams.
- One first-party telemetry pipeline + Sentry (errors only).
- Admin/RBAC, connectors/MCP, automations, collaboration, deliverable generators, publish pipeline, public API — **all committed**, scheduled to later phases.

---

## 4. MVP features (smallest set that proves the agent OS works end-to-end)

> **MVP thesis:** "A user signs in, gives a natural-language task, watches AgentOS **plan → decompose → run tools in a sandbox (web search + code/file + read-only local files) → ask approval on a risky step → recover from an error → verify → deliver an artifact**, with full audit, cost tracking, and an instant stop — on **both web and the Windows desktop app**." Everything else is Later.

**MVP IN (the end-to-end spine):**
1. **Monorepo + shared protocol** (typed event & tool ABI) consumed by web + desktop.
2. **Backend API + DB** (workspaces, users, projects, tasks, steps, events, artifacts, audit, usage).
3. **Auth**: web session + desktop **PKCE** deep-link; workspace/project scoping.
4. **Task Engine**: intake → plan → decompose → ReAct loop → verify → deliver; step + cost budgets; replanning; **instant stop**.
5. **LLM provider** (`claude-opus-4-8`) behind abstraction; **encrypted key at rest**; token/cost metering; pre-flight estimate; basic context management (chunking + summarization + prompt caching).
6. **Tool Registry** with risk tags + permission scopes; **MVP tools**: web search, code-exec, file read/write (in sandbox), and **read-only** local file read via Local Operator.
7. **Session Sandbox** (container-per-session) exposing shell/files/headless browser over WS.
8. **File / artifact store** (presigned up/download, versioned).
9. **Queue + worker** for durable task runs.
10. **Cloud browser** tool (headless) for web tasks; basic Live Activity rendering of browser/terminal/file events.
11. **Frontend workspace**: Home/launcher, two-pane Task view (plan + Live Activity), session history, **approval prompt UI**, **stop button**, cost readout.
12. **Desktop app (Windows)**: Electron shell (`app://` + CSP nonce, sandboxed renderer, named typed IPC, single-instance, window-state), PKCE login.
13. **Local Operator (sidecar) — MVP-lite**: signed binary, `device_config`/`device_status` reconcile loop, **read-only** shared-folder access, live "what it touched" audit, per-action approval scaffolding.
14. **Approval + audit + masking** wired across the loop; **replay** of the persisted event stream.
15. **Usage metering** (tokens/cost per task/workspace) surfaced in UI.
16. **One telemetry pipeline + Sentry**; server-driven flags; **no secrets in bundle**.

**MVP OUT (explicitly deferred to keep the cut small):**
- Local shell/command execution (sidecar write/exec) — MVP is **read-only** local files.
- Preferred-browser drive / Takeover; VNC; in-cloud VS Code.
- Automations/scheduling, mail-to-task, meetings, collaboration, admin console.
- Slides/design/multimedia/website-builder/data-analysis generators (MVP delivers **reports + files + spreadsheets-lite** only).
- Connectors/OAuth integrations, MCP, public API, marketplace/skills, memory/knowledge depth, Wide Research, billing (metering only), Quick Launcher, Presenter, MSIX/Store packaging.

---

## 5. Later-phase features

Grouped by theme; each maps to a phase in §6 and Appendix A.

- **Local power (Phase): full Local Operator** — read-write folders, gated shell/command exec (per-folder `allowCmd` replaced by per-command allow/deny + approval), OS-level jail, codesign+hash-pin enforcement.
- **Preferred browser & takeover** — drive an approved local browser profile; instant takeover; per-domain consent.
- **Automations** — cron + event triggers, dry-run preview, approval policy per automation.
- **Admin console** — workspaces/users/roles (RBAC), audit export, budget policy, org settings.
- **Projects & Skills depth** — rich project workspaces; Skills = reusable parameterized task graphs; Knowledge/Memory with RAG.
- **Collaboration** — shared workspaces, comments, shared tasks, presence.
- **Mail-to-task** — inbound email/webhook → task with sender allowlist + approval.
- **Meeting module** — transcript ingestion → action items/tasks.
- **Multimedia generators** — images/video/audio/podcast.
- **Design view** — original visual editor surface for deliverables.
- **Slides** — deck generation + multi-monitor Presenter mode.
- **Data analysis** — notebook-style analysis, charts, spreadsheets depth.
- **MCP layer** — install/manage MCP servers; open tool extension.
- **Website builder** — generate + deploy sites; preview vs published; custom domains.
- **Public API** — REST + webhooks + OAuth apps; documented contracts; rate limits.
- **Wide/Parallel Research** — map-reduce sub-agents with per-sub budgets.
- **Quick Launcher + Presenter + tray/global hotkeys** — cross-platform, enabled by default.
- **Billing/credits/quota/tiers** — Stripe metering, daily quota, tier gating.
- **macOS/Linux desktop** — packaging + native parity.
- **Packaging & distribution** — NSIS auto-update + MSIX Store; signed sidecar; update channel.
- **Docs** — user + developer + API + security docs.

---

## 6. Development phases (Phase 0..N) — themes, modules, ordering rationale

> Ordering follows the user's required implementation order (monorepo → backend → db → auth/workspace/project → task engine → LLM provider → tool registry → file/artifact → queue/worker → browser → frontend → cloud browser UI → automation → desktop → local operators → preferred browser → admin → projects/skills → collaboration → mail-to-task → meeting → multimedia → design view → slides → data analysis → MCP → website builder → public API → tests → packaging → docs). Phases batch that order into shippable, testable increments. **Tests are continuous** (every module ships with passing tests — hard rule), plus a dedicated **hardening phase** before packaging.

### Phase 0 — **Foundations & Contracts** (`scaffold`)
- **Theme:** One repo, one protocol, two shells, green CI.
- **Modules delivered:** Monorepo layout; shared **typed event & tool ABI** package; brand config (renameable); base backend service skeleton; CI building web + desktop + running tests; lint/format/typecheck gates.
- **Ordering rationale:** Everything downstream consumes the shared protocol and repo conventions. The ABI is the single contract for streaming + tool calls, so it must exist first.

### Phase 1 — **Backend, Data & Identity** (`backbone`)
- **Theme:** Durable state + who-can-do-what.
- **Modules:** Backend API; **Database** (schema, migrations); **Auth** (web session + desktop **PKCE**); **Workspaces / Projects** scoping; RBAC primitives; secrets vault (encrypted API-key storage); audit-log substrate.
- **Ordering rationale:** Backend → DB → auth/workspace/project is the spec's required spine; the task engine cannot persist or scope without it. Secrets vault and audit substrate land here because the hard rules (encryption, audit) must predate any agent action.

### Phase 2 — **Agent Brain & Execution Spine** (`brain`)
- **Theme:** The core loop, end to end, on cloud tools.
- **Modules:** **Task Engine** (intake→plan→decompose→ReAct→verify→deliver, replanning, step/cost budgets, **instant stop**); **LLM Provider** abstraction (`claude-opus-4-8`, encrypted key, token/cost metering, pre-flight estimate, context management); **Tool Registry** (typed + risk-tagged + permission-scoped); **File/Artifact** store; **Queue + Worker**; **Session Sandbox** (container-per-session) with shell/files; **Cloud (headless) Browser** tool.
- **Ordering rationale:** Mirrors task engine → LLM → tool registry → file/artifact → queue/worker → browser. This phase makes the agent *actually run* against real cloud tools and is the heart of the product moat.

### Phase 3 — **Web Workspace & Live Panel** (`surface`)
- **Theme:** A human can drive and watch the agent on the web.
- **Modules:** **Frontend** workspace (Home/launcher, two-pane Task view, session history); **Live Activity Panel** (terminal/file/browser event rendering = "cloud browser UI"); **approval prompt UI**; **stop control**; cost readout; **Replay**; safety masking in UI; telemetry pipeline + Sentry; server-driven flags.
- **Ordering rationale:** Frontend → cloud-browser-UI per the order. Now the brain is observable and controllable; this is the **first full end-to-end demo on web**.

### Phase 4 — **Desktop App & Local Operator** (`desktop`)
- **Theme:** Native Windows shell + auditable local file access.
- **Modules:** **Electron desktop** (`app://`+CSP nonce, sandboxed renderer, named typed IPC, single-instance, window-state, PKCE login); **Local Operator (sidecar) MVP-lite** (signed binary, reconcile loop, **read-only** shared folder, live audit, per-action approval scaffolding); desktop↔backend realtime parity.
- **Ordering rationale:** Order places desktop then local operators; desktop needs the web surface (Phase 3) to wrap. Read-only local files complete the **MVP end-to-end claim on desktop**. *(MVP line ends here.)*

### Phase 5 — **Full Local Power & Preferred Browser** (`local-power`)
- **Theme:** Beyond read-only — the differentiator.
- **Modules:** Local Operator **read-write + gated shell/command exec** (per-command allow/deny + approval, OS jail, codesign+hash-pin enforced); **Preferred Browser** operator + **Takeover** (per-domain consent, instant reclaim, no CAPTCHA/2FA bypass).
- **Ordering rationale:** Order: local operators → preferred browser. Highest-risk surfaces, so they follow the proven read-only baseline and the full approval/audit machinery.

### Phase 6 — **Automations & Triggers** (`automate`)
- **Theme:** Tasks that start themselves.
- **Modules:** **Automations** (cron + event triggers, dry-run preview, per-automation approval policy); trigger plumbing reused later by mail-to-task/webhooks.
- **Ordering rationale:** Order lists automation right after the browser/frontend block; built once the manual task loop is solid so scheduled runs inherit approval + budgets.

### Phase 7 — **Admin, Projects/Skills & Collaboration** (`org`)
- **Theme:** Multi-user, reusable, governed.
- **Modules:** **Admin console** (RBAC, audit export, budget policy); **Projects/Skills depth** (rich projects, Skills = parameterized task graphs, Knowledge/Memory + RAG); **Collaboration** (shared workspaces, roles, comments, presence).
- **Ordering rationale:** Order: admin → projects/skills → collaboration. Governance precedes broad sharing; skills/memory enrich reuse before teams collaborate on them.

### Phase 8 — **Ingestion: Mail-to-Task & Meetings** (`ingest`)
- **Theme:** The world creates tasks.
- **Modules:** **Mail-to-Task** (inbound email/webhook → task, sender allowlist, approval); **Meeting** module (transcript ingestion → action items/tasks).
- **Ordering rationale:** Order: mail-to-task → meeting. Both depend on automations/triggers (Phase 6) and collaboration/projects (Phase 7).

### Phase 9 — **Creation Suite** (`create`)
- **Theme:** Make anything.
- **Modules:** **Multimedia** (image/video/audio); **Design view** (visual editor); **Slides** (+ Presenter); **Data analysis** (notebooks/charts/spreadsheets depth); **Website builder** (generate + deploy, preview/published, custom domains).
- **Ordering rationale:** Order: multimedia → design view → slides → data analysis → … → website builder. Heavy deliverable generators batch after the platform is governed and stable; they share viewers/publish pipeline.

### Phase 10 — **Extensibility & Public Platform** (`open`)
- **Theme:** Open the tool layer and the API.
- **Modules:** **MCP layer** (install/manage MCP servers; open tool extension); **Public API** (REST + webhooks + OAuth apps, rate limits, docs); **Wide/Parallel Research** (map-reduce sub-agents); **Billing/credits/quota/tiers**.
- **Ordering rationale:** Order: MCP → website builder → public API. MCP + public API exposed only after the tool ABI and permission model are battle-tested; billing gates external usage.

### Phase 11 — **Hardening & Test Sweep** (`harden`)
- **Theme:** Prove it. (Continuous tests + dedicated sweep.)
- **Modules:** End-to-end/integration/security test suites; load & cost-regression tests; chaos/kill-switch drills; penetration pass on sidecar + IPC + CORS + CSP; accessibility & i18n pass.
- **Ordering rationale:** Order places `tests` before packaging. Per hard rules nothing ships "done" without tests *throughout*; this phase is the consolidated gate before release.

### Phase 12 — **Packaging & Distribution** (`ship`)
- **Theme:** Signed, updating, installable.
- **Modules:** electron-builder dual targets (**NSIS/exe** auto-update feed + **MSIX** Store); signed + hash-pinned sidecar; auto-update channel; crash reporting; **macOS/Linux** desktop parity build-out begins here.
- **Ordering rationale:** Order: packaging after tests. Distribution last so we ship a verified, hardened build.

### Phase 13 — **Documentation** (`docs`)
- **Theme:** Make it usable and buildable by others.
- **Modules:** User docs; developer/tool-ABI docs; **public API** reference; security & permissions docs; operator/runbook docs.
- **Ordering rationale:** Order ends with docs. Docs finalize once surfaces and API contracts are frozen.

**Phase count: 14 (Phase 0 through Phase 13). MVP completes at the end of Phase 4.**

---

## 7. Acceptance criteria per phase (objective, testable)

> Every phase additionally inherits the global gate: **all shipped modules have passing unit + integration tests; no placeholders/TODOs in core paths; no secrets in frontend bundle (CI-scanned).**

### Phase 0 — Foundations & Contracts
- [ ] `pnpm install && pnpm build` builds web + desktop targets from a clean checkout in CI.
- [ ] Shared protocol package exports versioned event + tool ABI types; consumers fail to compile on contract drift.
- [ ] Renaming the product requires editing **only** `brand.config.ts` (verified by a test asserting no hard-coded product name elsewhere).
- [ ] CI runs lint + typecheck + unit tests; red build blocks merge.

### Phase 1 — Backend, Data & Identity
- [ ] DB migrations apply and roll back cleanly; schema matches the documented table/field list.
- [ ] Web session auth + desktop **PKCE** flow complete a login; token never appears in any URL the renderer can read (asserted).
- [ ] Workspace/project scoping enforced: a user cannot read another workspace's rows (authz test).
- [ ] API key stored **encrypted at rest**; decrypt path is server-only; a frontend bundle scan finds zero secrets.
- [ ] Every privileged mutation writes an audit-log row.

### Phase 2 — Agent Brain & Execution Spine
- [ ] A natural-language task produces an inspectable **plan + step decomposition** before execution.
- [ ] ReAct loop executes ≥3 chained tool calls in a container-per-session sandbox and returns a verified result.
- [ ] **Instant stop** halts an in-flight task within a bounded time (e.g. ≤2s) and marks it stopped.
- [ ] Token + cost metered per task and per workspace; numbers reconcile with provider usage in a fixture test.
- [ ] **Pre-flight estimate** is produced for a task flagged expensive; replanning triggers on a forced tool failure.
- [ ] Tool calls carry a **risk level**; a `high` tool is blocked pending approval in an automated test.

### Phase 3 — Web Workspace & Live Panel
- [ ] End-to-end on web: submit task → see plan → watch Live Activity (terminal/file/browser events) → receive artifact.
- [ ] **Approval prompt** appears for a high-risk step and blocks until the user decides.
- [ ] **Stop button** cancels the run; UI reflects stopped state.
- [ ] **Replay** of a finished task reproduces the event stream deterministically.
- [ ] Sensitive values are masked in UI and in shared/replay views (asserted on a seeded secret).
- [ ] Telemetry events flow to the single first-party pipeline; Sentry captures a forced error.

### Phase 4 — Desktop App & Local Operator (MVP completion)
- [ ] Windows desktop app launches, logs in via PKCE, and renders the same workspace as web.
- [ ] Renderer is sandboxed (`sandbox:true`); only named typed IPC methods exist (no raw `invoke(channel,…)` passthrough) — asserted.
- [ ] Sidecar binary is **signature/hash-verified** before spawn; an unverified binary is refused.
- [ ] Agent reads a **read-only** shared folder; a write attempt is denied and audited.
- [ ] Live "what it touched" log lists every local file access; per-action approval prompt is reachable.
- [ ] Killing the desktop app terminates the sidecar (PID-lockfile, no orphans).
- [ ] **MVP gate:** full loop (plan→tools→approval→recover→verify→deliver, with audit/cost/stop) passes on **both web and desktop**.

### Phase 5 — Full Local Power & Preferred Browser
- [ ] Read-write folder mode and gated shell exec work; a destructive command (`rm -rf`) triggers a `critical` approval and is blocked until approved.
- [ ] Per-command allow/deny list enforced; OS-level jail confined to the shared folder (escape attempt fails).
- [ ] Preferred-browser operator drives an approved profile; **Takeover** returns control to the user instantly.
- [ ] CAPTCHA/2FA encountered → agent pauses and hands off (never bypasses) — asserted in a test harness.

### Phase 6 — Automations & Triggers
- [ ] A cron automation fires on schedule and creates a task that inherits approval + budget policy.
- [ ] **Dry-run preview** shows planned actions without executing.
- [ ] Disabling/deleting an automation stops future runs immediately.

### Phase 7 — Admin, Projects/Skills & Collaboration
- [ ] RBAC: roles gate admin actions; audit export produces a complete, tamper-evident log.
- [ ] A **Skill** (parameterized task graph) runs with new parameters and reproduces structure.
- [ ] Knowledge/Memory retrieval improves a task and respects privacy settings (excluded data never sent to model — asserted).
- [ ] A shared workspace lets a second user view/comment per their role; unauthorized access denied.

### Phase 8 — Mail-to-Task & Meetings
- [ ] An allowlisted inbound email creates a task pending approval; a non-allowlisted sender is rejected.
- [ ] A meeting transcript is converted into action items/tasks with correct linkage.

### Phase 9 — Creation Suite
- [ ] Each generator (multimedia, design, slides, data analysis, website) produces a valid, openable artifact.
- [ ] Slides Presenter mode spans multiple monitors.
- [ ] Website builder deploys to a preview URL, then publishes; a custom domain resolves via CNAME.

### Phase 10 — Extensibility & Public Platform
- [ ] An MCP server installs, exposes tools through the registry with risk tags, and runs sandboxed.
- [ ] Public API: an OAuth app obtains a scoped token, creates a task via REST, and receives a webhook on completion; rate limits enforced.
- [ ] Wide Research fans out N sub-agents and reduces to one result within per-sub budgets.
- [ ] Billing meters usage to Stripe; quota exhaustion gates further runs.

### Phase 11 — Hardening & Test Sweep
- [ ] E2E suite green across web + desktop; coverage thresholds met on core paths.
- [ ] Security pass: CORS scoped (not `<all_urls>`), full CSP (`default-src`/`connect-src`/`object-src`), IPC allowlist, sidecar signing — all verified.
- [ ] Kill-switch/chaos drills: stopping mid-tool leaves no orphaned sandbox or sidecar.
- [ ] Cost-regression and load tests pass within budget thresholds.

### Phase 12 — Packaging & Distribution
- [ ] Signed NSIS build auto-updates from the feed; MSIX build installs from Store path with auto-update disabled.
- [ ] Sidecar shipped signed + hash-pinned; tamper detection blocks launch.
- [ ] macOS/Linux parity build produces installable artifacts.

### Phase 13 — Documentation
- [ ] User, developer (tool ABI), API, and security docs published and accurate against shipped behavior.
- [ ] A new developer can build and run both surfaces following docs alone (dry-run validated).

---

## 8. Risks & solutions (with concrete mitigations)

### Technical
| Risk | Mitigation |
|---|---|
| **Agent loops/stalls/destructive actions.** | Hard **step + cost budgets**, watchdog timeouts, replanning caps, **global kill switch**, and the **risk-gated approval** for `high`/`critical` from Phase 2. Destructive ops are `critical` by default. |
| **Sandbox cost/scale dominates spend.** | Container-per-session (gVisor) first; **idle reaping**, density tuning; **local-first** read-only files offload cloud work; microVMs only when multi-tenant density demands. |
| **Sidecar is highest-risk component** (token-bearing WS + filesystem). | **Codesign + hash-pin** before spawn; OS-level jail; **read-only default**, scoped shared folder via `realpath` canonicalization; **PID-lockfile** lifecycle (no kill-by-name); per-action approval + live audit. |
| **Realtime fragility / reconnection storms.** | Staged backoff curve + **epoch-guarded serialized op queue**; token in `auth` handshake; base-URL diffing so token-only change doesn't restart healthy sessions. |
| **Provider/model drift.** | `LlmProvider` abstraction isolates `claude-opus-4-8`; contract tests pin request/response shape; model id sourced from one constant. |

### Security
| Risk | Mitigation |
|---|---|
| **Secrets leaking to frontend.** | API keys **encrypted at rest**, server-only decrypt; **CI bundle scan** fails the build on any secret/dev-endpoint; server-driven flags (nothing baked into static bundle). |
| **Renderer/IPC over-exposure** (Manus's raw `invoke` + global CORS). | **Sandboxed renderer** (`sandbox:true`), **named typed IPC** only (no generic passthrough), **scoped CORS** (our origins only), **full CSP** (`default-src`/`connect-src`/`object-src` + per-request nonce). |
| **Plaintext-token interception** (Manus deep-link weakness). | **PKCE**: one-time code in deep link, exchanged for token over HTTPS; nonce CSRF guard retained. |
| **Sensitive-data exposure in logs/prompts/replays.** | Centralized **masking** layer applied to UI, logs, model prompts, and shared replays; tests seed secrets and assert redaction. |

### Cost
| Risk | Mitigation |
|---|---|
| **Token spend on multi-step runs.** | Prompt **caching**, **summarization**, **file chunking**, **memory retrieval**, model tiering (cheap planner / strong executor later), **pre-flight estimates**, hard **budget caps** per task/workspace/month. |
| **Telemetry vendor sprawl.** | **One first-party pipeline + Sentry (errors only)**; no fingerprinting/attribution SDKs at v1. |

### Scope-creep
| Risk | Mitigation |
|---|---|
| **"Just one more generator/connector" delays MVP.** | **MVP cut frozen** (§4); all extras tagged Later (§5) and slotted into post-MVP phases; MVP ends at Phase 4 and is a hard gate before Phase 5+. |
| **Gold-plating the desktop.** | Quick Launcher, Presenter, tray/hotkeys deferred to later phases; desktop MVP = shell + PKCE + read-only sidecar. |

### Legal / ToS
| Risk | Mitigation |
|---|---|
| **CAPTCHA/2FA bypass / ToS violation.** | **Hard rule enforced in code**: on CAPTCHA/2FA the agent **pauses and hands off**; no bypass tooling ships. Browser automation respects robots/ToS; per-domain consent for Preferred Browser. |
| **Spam/abuse via automations/mail-to-task.** | Sender **allowlists**, rate limits, approval-before-execute, dry-run preview. |
| **Branding/IP originality.** | No copied Manus branding/UI/copy/names/design/code; original design system; teardown used only for capability mapping and architecture lessons. |

---

## 9. First concrete coding step after approval (Phase 0)

> Goal of step one: a clean monorepo that **builds web + desktop**, exposes the **shared protocol/brand contracts**, and runs **green CI** — the substrate every later phase consumes. (No agent logic yet.)

### 9.1 Exact first commands
```bash
# 1. Initialize the monorepo
mkdir agentos && cd agentos
git init
corepack enable && corepack prepare pnpm@latest --activate
pnpm init

# 2. Workspace + tooling
printf 'packages:\n  - "apps/*"\n  - "packages/*"\n' > pnpm-workspace.yaml
pnpm add -Dw typescript @types/node tsup eslint prettier vitest turbo
npx tsc --init

# 3. Create the package/app skeleton
mkdir -p packages/brand packages/protocol packages/config \
         apps/web apps/desktop services/api

# 4. First green test + build
pnpm -w exec vitest run        # protocol/brand contract tests must pass
pnpm -w build                  # builds web + desktop + api skeletons

# 5. First commit (only after user asks to commit)
git add -A
git commit -m "Phase 0: monorepo scaffold, shared protocol + brand contracts, green CI"
```

### 9.2 Exact first files (Phase 0 deliverables)
```
agentos/
├─ pnpm-workspace.yaml
├─ package.json                      # root scripts: build, test, lint, typecheck
├─ tsconfig.base.json                # shared TS config
├─ turbo.json                        # task pipeline (build/test/lint)
├─ .github/workflows/ci.yml          # install → typecheck → lint → test → build (blocks red)
├─ packages/
│  ├─ brand/
│  │  ├─ brand.config.ts             # PRODUCT_NAME, PRODUCT_SLUG, DEEP_LINK_SCHEME, APP_PROTOCOL, APP_USER_MODEL_ID
│  │  └─ brand.test.ts               # asserts no hard-coded product name elsewhere (renameability gate)
│  ├─ protocol/
│  │  ├─ src/events.ts               # typed step-event ABI (plan/tool_call/tool_result/message/approval/stop)
│  │  ├─ src/tools.ts                # Tool schema: id, inputSchema, riskLevel, permissionScope
│  │  ├─ src/risk.ts                 # RiskLevel = 'low'|'medium'|'high'|'critical'
│  │  ├─ src/index.ts                # versioned export + VERSION constant
│  │  └─ protocol.test.ts            # contract/drift tests
│  └─ config/
│     └─ src/env.ts                  # server-only env schema (no secrets in client bundle)
├─ apps/
│  ├─ web/                           # Next.js App Router static-export shell (renders "hello AgentOS")
│  └─ desktop/                       # Electron skeleton: app:// + CSP nonce, single-instance, sandboxed renderer, named typed IPC stub
└─ services/
   └─ api/                           # backend service skeleton (health route + protocol import)
```

### 9.3 Definition of done for step one
- `pnpm -w build` builds `apps/web`, `apps/desktop`, `services/api`.
- `pnpm -w exec vitest run` is green, including the **renameability** test and **protocol drift** test.
- CI workflow runs install → typecheck → lint → test → build and **blocks on red**.
- No secrets anywhere in the client bundle (CI scan stub in place).
- The two surfaces render a static UI from the shared packages — proving "one UI, two shells" before any agent code exists.

---

## Appendix A — 30 module categories → phase map

| # | Module category (from spec order) | Phase | MVP? |
|---|---|---|---|
| 1 | Monorepo | 0 | ✅ |
| 2 | Backend | 1 | ✅ |
| 3 | DB | 1 | ✅ |
| 4 | Auth / Workspace / Project | 1 | ✅ |
| 5 | Task engine | 2 | ✅ |
| 6 | LLM provider | 2 | ✅ |
| 7 | Tool registry | 2 | ✅ |
| 8 | File / artifact | 2 | ✅ |
| 9 | Queue / worker | 2 | ✅ |
| 10 | Browser (cloud/headless) | 2 | ✅ |
| 11 | Frontend | 3 | ✅ |
| 12 | Cloud browser UI (Live Activity) | 3 | ✅ |
| 13 | Automation | 6 | ⬜ Later |
| 14 | Desktop | 4 | ✅ |
| 15 | Local operators | 4 (read-only) / 5 (full) | ✅ (RO) |
| 16 | Preferred browser | 5 | ⬜ Later |
| 17 | Admin | 7 | ⬜ Later |
| 18 | Projects / skills | 7 | ⬜ Later (Projects-lite in 1) |
| 19 | Collaboration | 7 | ⬜ Later |
| 20 | Mail-to-task | 8 | ⬜ Later |
| 21 | Meeting | 8 | ⬜ Later |
| 22 | Multimedia | 9 | ⬜ Later |
| 23 | Design view | 9 | ⬜ Later |
| 24 | Slides | 9 | ⬜ Later |
| 25 | Data analysis | 9 | ⬜ Later |
| 26 | MCP | 10 | ⬜ Later |
| 27 | Website builder | 9/10 | ⬜ Later |
| 28 | Public API | 10 | ⬜ Later |
| 29 | Tests | continuous + 11 | ✅ (continuous) |
| 30 | Packaging | 12 | ⬜ Later |
| (+) | Docs | 13 | ⬜ Later |

> Safety, audit, masking, cost-tracking, and telemetry are **cross-cutting** and embedded from Phase 1 onward (not a single module), per the hard rules.
