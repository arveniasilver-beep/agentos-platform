# AgentOS — Feature Completeness Matrix (Spec §37)

> **Status:** Planning only — no code. This is the authoritative, pre-coding completeness map.
> **Owner:** Lead Product Architect.
> **Pinned-decision conformance:** This matrix is fully consistent with `docs/00-scope-and-phases.md` (codename, scope, MVP cut, Phase 0–13 plan, 30-module phase map in Appendix A) and `docs/01-stack-and-system-architecture.md` (stack, service topology, wire contracts, folder layout). Where those docs assign a phase or MVP/Later tag, this matrix uses the **same** assignment. No decision here contradicts F1.
> **Codename:** `AgentOS` — every user-visible/identifier string derives from `packages/brand`. Treat each "AgentOS" below as `BRAND.appName`.

---

## 0. How to read this matrix

Each area is a table. **Every row** carries the eight required columns from spec §37:

| Column | Meaning |
|---|---|
| **Manus-style capability category** | The teardown-derived capability we are matching (see `00-scope-and-phases.md §2`, ids `C1…C30`). |
| **AgentOS equivalent** | Our original implementation of that capability. |
| **MVP / Later phase** | `MVP` (lands ≤ Phase 4, the MVP gate) or `Later`, plus the exact Phase number (`P0…P13`) from F1. Tags match F1's Appendix A and §4/§5 exactly. |
| **Technical module** | The owning service/package/folder from `01-stack-and-system-architecture.md §34` (e.g. `services/api`, `packages/agent-engine`). |
| **Test scenario** | A concrete, runnable scenario id (`T-<area>-<n>`). Cross-referenced to F1's scenarios (`A1`, `B3`, `C1`, …) where one already exists. |
| **Risk level** | The product **risk-tag** for the capability's most dangerous action (`low | medium | high | critical`) per the hard-rule risk model. Distinct from delivery risk. |
| **Dependencies** | Other rows/modules that must exist first. |
| **Acceptance criteria** | Objective, testable pass condition. |

**Conventions:**
- **MVP gate = end of Phase 4** (per F1 §6). Anything tagged `MVP` must work on **both web and desktop** by then.
- **Cross-cutting** rows (security, audit, masking, cost, logging, testing) are embedded from Phase 1 onward, not a single late module (F1 Appendix A note).
- Risk-tag legend: `low` = read/idempotent; `medium` = scoped writes/spend; `high` = out-of-scope writes, external side effects, money; `critical` = irreversible/destructive, secret exposure, privilege escalation.

---

## Area index (maps to the 30 spec module categories + cross-cutting)

| # | Spec module category | Matrix area § | Primary phase |
|---|---|---|---|
| 1 | Users / Workspaces / Projects | [§1](#1-users-workspaces--projects) | P1 |
| 2 | Agent chat (task-driving surface) | [§2](#2-agent-chat--task-conversation-surface) | P2–P3 |
| 3 | Agent engine | [§3](#3-agent-engine-the-brain) | P2 |
| 4 | Tool registry | [§4](#4-tool-registry--tool-abi) | P2 |
| 5 | Cloud browser | [§5](#5-cloud-browser-headless--takeover) | P2 |
| 6 | Local browser operator | [§6](#6-local-browser-operator--preferred-browser--takeover) | P5 |
| 7 | Preferred browser | [§6](#6-local-browser-operator--preferred-browser--takeover) | P5 |
| 8 | Local computer operator (sidecar) | [§7](#7-local-computer-operator-sidecar) | P4/P5 |
| 9 | File system | [§8](#8-file-system--artifacts) | P2/P4 |
| 10 | Artifacts | [§8](#8-file-system--artifacts) | P2 |
| 11 | Automations / scheduled | [§9](#9-automations--scheduled-tasks--triggers) | P6 |
| 12 | Wide research | [§10](#10-wide--parallel-research) | P10 |
| 13 | Memory / context | [§11](#11-memory--context-management) | P1/P7 |
| 14 | Permission / risk | [§12](#12-permission--risk--approval) | P2 |
| 15 | API / integration center | [§13](#13-api--integration-center-connectors) | P7 |
| 16 | Public API | [§14](#14-public-api--developer-platform) | P10 |
| 17 | Projects (depth) | [§15](#15-projects-depth) | P7 |
| 18 | Skills | [§16](#16-skills-reusable-task-graphs) | P7 |
| 19 | Collaboration | [§17](#17-collaboration) | P7 |
| 20 | Mail-to-task | [§18](#18-mail-to-task) | P8 |
| 21 | Meeting minutes | [§19](#19-meeting-module) | P8 |
| 22 | Multimedia | [§20](#20-multimedia-generators) | P9 |
| 23 | Design view | [§21](#21-design-view) | P9 |
| 24 | Slides | [§22](#22-slides--presenter) | P9 |
| 25 | Data analysis | [§23](#23-data-analysis) | P9 |
| 26 | Data provider registry | [§24](#24-data-provider-registry) | P9/P10 |
| 27 | No-code / webhook | [§25](#25-no-code--webhook-builder) | P10 |
| 28 | MCP connector | [§26](#26-mcp-connector-layer) | P10 |
| 29 | Website builder | [§27](#27-website-builder--publish-pipeline) | P9/P10 |
| 30 | Admin / settings | [§28](#28-admin--settings) | P1/P7 |
| + | Security (cross-cutting) | [§29](#29-security-cross-cutting) | P1+ |
| + | Cost control (cross-cutting) | [§30](#30-cost-control-cross-cutting) | P2+ |
| + | Logging / audit / telemetry | [§31](#31-logging-audit--telemetry-cross-cutting) | P1+ |
| + | Database | [§32](#32-database) | P1 |
| + | Testing | [§33](#33-testing-cross-cutting) | P0+ |
| + | Packaging / distribution | [§34](#34-packaging--distribution) | P12 |
| + | Documentation | [§35](#35-documentation) | P13 |

> All 30 numbered spec categories plus the cross-cutting concerns (security, cost, logging, database, testing) the spec lists as modules are covered. Multiple rows per category where the capability decomposes.

---

## 1. Users, Workspaces & Projects

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Identity / accounts | Email+password first-party account, server-issued identity | **MVP · P1** | `services/api/auth`, `packages/auth`, `packages/db` | T-UWP-1: register → login → fetch `/me` | medium | DB (§32) | Account created; password hashed (argon2id); `/me` returns scoped profile; no token in JS-readable storage |
| Web session | HTTP-only, Secure, SameSite cookie session + CSRF guard | **MVP · P2** | `services/api/auth`, `packages/auth` | T-UWP-2 (=F1 D2 web side) | medium | T-UWP-1 | Session cookie set; not readable from JS; CSRF token required on mutations |
| Desktop login | PKCE Authorization-Code deep-link (`agentos://?code=`) → HTTPS code exchange | **MVP · P2** | `apps/desktop`, `packages/auth` | T-UWP-3 (=F1 D2) | high | T-UWP-1, §28 | One-time code exchanged over HTTPS w/ `code_verifier`; plaintext token never in deep-link; state/nonce mismatch rejected |
| Workspaces (tenancy) | Workspace = top-level tenant; all rows workspace-scoped + RLS backstop | **MVP · P1** | `services/api/workspaces`, `packages/db` | T-UWP-4 (=F1 P1 authz) | high | T-UWP-1, §32 | User cannot read another workspace's rows; RLS denies cross-tenant query in a test |
| Projects (grouping) | Project = container grouping Tasks/files/memory/settings within a workspace (Projects-**lite**) | **MVP · P1** | `services/api`, `packages/db` | T-UWP-5: create project, attach task | low | T-UWP-4 | Task can be created under a project; project scoping enforced; budget cap field present |
| RBAC primitives | Role enum (`owner/admin/member/viewer`) gating mutations | **MVP · P1** | `services/api/auth` | T-UWP-6: viewer blocked from mutate | high | T-UWP-4 | `viewer` denied create/delete; `owner` allowed; decision audited |
| Per-workspace budget cap | Hard monthly USD cap + per-task cap on the workspace | **MVP · P1** (cap config) / depth **Later · P10** | `services/api/billing`, `packages/db` | T-UWP-7 (see §30) | medium | §30 | Cap stored; over-cap run is blocked before spend (full enforcement in §30) |

---

## 2. Agent chat / task conversation surface

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Task intake (NL prompt) | Natural-language task box → `createTask` REST → `Session`+`Task` rows | **MVP · P2** | `services/api/tasks`, `apps/web` | T-CHAT-1: submit task → `sessionId` | low | §1, §32 | POST creates Session+Task (`PENDING`), writes initial event, enqueues job, returns `sessionId` |
| Live streamed conversation | `/chat` socket stream of `message`/`plan`/`tool_*` events into the left pane | **MVP · P3** | `services/gateway`, `apps/web`, `packages/protocol` | T-CHAT-2 (=F1 B1) | low | §3, §31 | `plan` precedes any `tool_call`; partial `message` events render incrementally; stream ends on `final_output` |
| Two-pane workspace | Left = plan/conversation; right = Live Activity panel | **MVP · P3** | `apps/web`, `packages/ui` | T-CHAT-3 (=F1 B1) | low | §3, §5 | Submitting a task shows plan left + tool activity right; layout identical on web + desktop |
| Stop control | Per-session **Stop** button → `stop` event / REST kill flag | **MVP · P2/P3** | `apps/web`, `services/gateway`, `packages/agent-engine` | T-CHAT-4 (=F1 B3) | high | §3 | `stop` halts within one step boundary (≤2s); task→`STOPPED`; no further events; audited |
| Approval prompt UI | Inline approval card for `approval_request` events; approve/deny | **MVP · P3** | `apps/web`, `packages/ui` | T-CHAT-5 (=F1 C1) | high | §12 | High-risk step renders blocking card; run paused until decision; both outcomes audited |
| Cost readout | Live per-task token/USD meter in the chat header | **MVP · P3** | `apps/web`, §30 | T-CHAT-6 | low | §30 | Running cost updates from `cost_estimate`/usage events; reconciles with persisted usage |
| Session history | List of past sessions per project/workspace | **MVP · P3** | `apps/web`, `services/api` | T-CHAT-7 | low | §32 | History lists prior sessions scoped to workspace; opening one loads its replay |
| Voice / STT intake | Optional speech-to-text into the task box | **Later · P10** (Quick Launcher) | `apps/web`, `apps/desktop` | T-CHAT-8 | low | §1 | STT transcribes to the task box; disabled by default; no audio leaves device without consent |

---

## 3. Agent engine (the brain)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Intent understanding | LLM intent/parse stage producing a structured task spec | **MVP · P2** | `packages/agent-engine`, `packages/llm` | T-ENG-1 | low | §29 (key), §32 | Free-text task yields a structured spec (goal, constraints, deliverable) before planning |
| Planner / decomposition | Explicit, inspectable **plan** + step decomposition emitted as a `plan` event | **MVP · P2** | `packages/agent-engine` | T-ENG-2 (=F1 P2) | low | T-ENG-1 | Inspectable plan with ordered steps emitted before any execution |
| ReAct execution loop | plan→act→observe→replan over the typed tool catalog | **MVP · P2** | `packages/agent-engine`, §4 | T-ENG-3 (=F1 P2) | medium | §4, §5, §32 | ≥3 chained tool calls run in a sandbox session and return a result |
| Replanning on failure | Forced tool failure triggers re-plan within replan cap | **MVP · P2** | `packages/agent-engine` | T-ENG-4 (=F1 P2) | medium | T-ENG-3 | A forced failure causes a re-plan; replan cap prevents infinite loop |
| Verification step | Agent re-checks the result before declaring done | **MVP · P2** | `packages/agent-engine` | T-ENG-5 | low | T-ENG-3, §8 | Final deliverable is re-read/validated; unverifiable result is flagged, not silently "done" |
| Error recovery | Retry w/ backoff, alternative tool routing, graceful give-up with explanation | **MVP · P2** | `packages/agent-engine` | T-ENG-6 | medium | T-ENG-3 | Transient tool error retried w/ backoff; persistent failure ends with a clear explanation, not a crash |
| Step / cost / wall-clock budgets | Hard budgets + loop detection checked between steps | **MVP · P2** | `packages/agent-engine`, §30 | T-ENG-7 | high | §30 | Exceeding step/token/time budget halts the run and reports why |
| Instant stop (kill switch) | Engine checks kill flag between steps; aborts in-flight tool + sidecar ops (epoch-guarded) | **MVP · P2** | `packages/agent-engine` | T-ENG-8 (=F1 B3) | critical | T-CHAT-4 | Stop aborts within one step boundary; in-flight tool + sidecar op cancelled; no orphans |
| Risk classifier | Classifies each action `low/medium/high/critical`; gates high/critical to approval | **MVP · P2** | `packages/agent-engine`, §12 | T-ENG-9 (=F1 C1) | high | §12 | A `high` tool is blocked pending approval in an automated test; classification is deterministic for fixtures |
| Durable / resumable runs | Run state in Postgres event log; resumes after worker restart | **MVP · P2** | `services/worker`, `packages/queue`, §32 | T-ENG-10 | medium | §9 (queue), §32 | Killing the worker mid-run and restarting resumes from the persisted event log |

---

## 4. Tool registry / Tool ABI

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Typed tool catalog | `packages/tool-abi`: Zod-typed `ToolDef` (name/input/output/risk/surface/execute) | **MVP · P2** | `packages/tool-abi` | T-TOOL-1 (=F1 A3) | low | §32 | Each tool has Zod input/output, a `risk` tag, and a `surface` (`cloud/local/either`) |
| Model-facing schema parity | Zod→JSON-Schema codegen feeds the LLM tool definitions from the same source | **MVP · P2** | `packages/tool-abi`, `tooling/scripts` | T-TOOL-2 (=F1 A3) | low | T-TOOL-1 | Parity test: runtime-validated shape == model-facing JSON Schema (no drift) |
| Per-tool risk tag | Every tool carries `RiskLevel`; high/critical require approval | **MVP · P2** | `packages/tool-abi`, §12 | T-TOOL-3 | high | §12 | Calling a `high` tool routes through the risk-gate before execution |
| Per-tool permission scope | Revocable permission scope per tool per workspace/session | **MVP · P2** (scaffold) / depth **Later · P7** | `packages/tool-abi`, `services/api` | T-TOOL-4 | high | §12, §28 | A revoked scope causes the tool to be denied + audited |
| MVP tool set | `web_search`, `code_exec`, `file_read`, `file_write` (sandbox), `local_file_read` (RO sidecar) | **MVP · P2/P4** | `packages/tool-abi`, executors | T-TOOL-5 | medium | §5, §7, §8 | All five tools execute end-to-end; each carries the correct risk tag |
| Tool execution routing | One ABI; executor runs in sandbox (cloud) or via sidecar (local) by `surface`+mode+approval | **MVP · P2/P4** | `packages/agent-engine`, §5, §7 | T-TOOL-6 | medium | §5, §7 | Same `file_write` def runs in sandbox (cloud) or sidecar (local); client render identical |
| Third-party tool ingestion | MCP servers register tools into the registry with risk tags | **Later · P10** | `packages/tool-abi`, §26 | T-TOOL-7 | high | §26 | An MCP-provided tool appears in the registry with a risk tag and runs sandboxed |

---

## 5. Cloud browser (headless + takeover)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Headless web automation | Playwright/Chromium in the session sandbox: navigate/read/fill/screenshot/download | **MVP · P2** | `services/sandbox-orchestrator`, sandbox image | T-CB-1 | medium | §3, §8 | Agent navigates, reads a page, returns content; one Playwright context per session |
| Live browser view (read) | Streamed browser/terminal/file events rendered in the Live Activity panel | **MVP · P3** | `apps/web`, `services/gateway` | T-CB-2 (=F1 B1) | low | §2 | Browser steps render in the right pane as `tool_call`/`tool_result` events |
| Egress / data redaction | Network interception enforces egress policy + redacts sensitive request/response before logging | **MVP · P2** | sandbox image, `packages/logger` | T-CB-3 (=F1 F2) | high | §31 | Seeded secret in a request is redacted in logs; disallowed egress blocked |
| CAPTCHA / 2FA refusal | On CAPTCHA/2FA the tool flags + escalates to approval/takeover; **never** auto-solves | **MVP · P2** (policy) / takeover **Later · P5** | `packages/tool-abi`, `packages/agent-engine` | T-CB-4 (=F1 P5) | high | §12 | CAPTCHA/2FA page → agent pauses & hands off; no bypass tooling present (asserted) |
| VNC takeover / headful | Headful Chromium + VNC for human takeover of the cloud browser | **Later · P5** | `services/sandbox-orchestrator` (Xvfb/VNC) | T-CB-5 | high | T-CB-1 | User can take over the cloud browser via VNC; agent control suspended during takeover |
| In-cloud code editor | Cloud VS Code / code-server view alongside the browser | **Later · P5** | `services/sandbox-orchestrator` | T-CB-6 | medium | T-CB-1 | A code editor view streams into the panel; read view first |

---

## 6. Local browser operator / Preferred browser / Takeover

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Drive user's local browser | **Preferred Browser** operator: agent drives an approved local browser profile | **Later · P5** | `apps/desktop`, `apps/sidecar` | T-LB-1 (=F1 P5) | high | §7, §12 | Agent drives an approved profile; per-domain consent required before navigation |
| Instant takeover | User reclaims browser control instantly | **Later · P5** | `apps/desktop` | T-LB-2 (=F1 P5) | high | T-LB-1 | Takeover returns control to the user instantly; agent actions suspended |
| Per-domain consent | Explicit allowlist of domains the agent may drive | **Later · P5** | `apps/desktop`, `services/api` | T-LB-3 | high | T-LB-1, §12 | Non-allowlisted domain navigation is blocked + prompts for consent |
| CAPTCHA/2FA hard stop | Same refusal policy on the local browser | **Later · P5** | `apps/sidecar`, `packages/agent-engine` | T-LB-4 (=F1 P5) | high | T-CB-4 | CAPTCHA/2FA → pause + hand off; never bypassed (asserted) |

---

## 7. Local computer operator (sidecar)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Sidecar binary lifecycle | Rust static binary; desktop **codesign-verify + hash-pin** before spawn; PID lockfile | **MVP · P4** | `apps/sidecar`, `apps/desktop` (supervisor) | T-LO-1 (=F1 E1) | critical | §1 (desktop) | Tampered binary refused; PID-lockfile lifecycle; killing app kills sidecar (no orphans) |
| Declarative reconcile loop | `device_config` (desired) → `device_status` (actual) over `/device` namespace | **MVP · P4** | `apps/sidecar`, `services/gateway` | T-LO-2 | medium | §32, `packages/protocol` | Pushing `device_config` reconciles folder scopes; `device_status` reflects actual state |
| Read-only local files | Agent reads an approved shared folder (RO); writes denied | **MVP · P4** | `apps/sidecar` | T-LO-3 (=F1 E2) | medium | T-LO-1 | RO read succeeds; write attempt denied + audited |
| Path-traversal jail | Canonicalized (`realpath`) path check confines to the shared folder | **MVP · P4** | `apps/sidecar` | T-LO-4 (=F1 E2) | critical | T-LO-1 | `../` escape outside the shared folder is refused + audited |
| "What it touched" audit | Live local activity/audit stream of every file access | **MVP · P4** | `apps/sidecar`, §31 | T-LO-5 | medium | §31 | Every local file access appears in the live audit log |
| Disconnect = kill switch | Losing `/device` supervision stops all sidecars; epoch guard blocks stale-timer resurrection | **MVP · P4** | `apps/sidecar`, `services/gateway` | T-LO-6 (=F1 E3) | critical | T-LO-2 | Dropping `/device` stops all sidecars; stale timer cannot resurrect; status resets on reconnect |
| Local-first privacy | File bytes never leave the machine; only model-necessary content sent | **MVP · P4** | `apps/sidecar`, `packages/agent-engine` | T-LO-7 (=F1 E4) | high | T-LO-3 | Local file task with cloud disabled: object storage untouched; only needed content sent |
| Read-write folders | RW scope mode under per-action approval | **Later · P5** | `apps/sidecar` | T-LO-8 (=F1 P5) | high | T-LO-3, §12 | RW write succeeds only after approval; scope enforced |
| Gated shell / command exec | Per-command allow/deny + approval; OS-level jail | **Later · P5** | `apps/sidecar` | T-LO-9 (=F1 P5) | critical | T-LO-8, §12 | Destructive command (`rm -rf`) triggers `critical` approval, blocked until approved; jail escape fails |

---

## 8. File system & artifacts

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Sandbox file read/write | File tools inside the session sandbox | **MVP · P2** | `services/sandbox-orchestrator`, `packages/tool-abi` | T-FS-1 | medium | §5 | Read/write within the sandbox FS; outside-scope write is `high` and gated |
| Artifact store | Versioned, content-addressed artifacts; presigned up/download via `BlobStore` (S3/R2/MinIO) | **MVP · P2** | `packages/blob-store`, `services/api/files` | T-FS-2 | medium | §32 | Large blob uploaded via presigned URL; version recorded; download link audit-linked |
| Local FS (sidecar) | Local-first file ops on the user's real disk via sidecar | **MVP · P4** (RO) / **Later · P5** (RW) | `apps/sidecar`, `packages/blob-store` (local-FS adapter) | T-FS-3 (=T-LO-3) | medium | §7 | Same `FileTool` contract over sandbox or local FS by mode |
| Artifact library browse UI | Library surface listing/previewing saved artifacts | **MVP-lite · P3** (basic) / full **Later · P7** | `apps/web` | T-FS-4 | low | T-FS-2 | Finished artifacts listed + previewable; full browse/search Later |
| Browser trace artifacts | Playwright traces saved as audit-linked artifacts | **MVP · P2** | `services/sandbox-orchestrator`, `packages/blob-store` | T-FS-5 | low | §5 | A run produces a trace artifact linked from the audit log |

---

## 9. Automations / scheduled tasks / triggers

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Cron scheduled tasks | **Automations**: BullMQ repeatable (cron) jobs creating tasks | **Later · P6** | `services/worker`, `packages/queue` | T-AUT-1 (=F1 P6) | medium | §3, §32 | A cron automation fires on schedule and creates a task that inherits approval + budget |
| Event triggers | Trigger plumbing (webhook/mail) reused by §18/§25 | **Later · P6** | `services/api`, `services/worker` | T-AUT-2 | medium | T-AUT-1 | An event trigger creates a pending task; trigger source recorded |
| Dry-run preview | Preview planned actions without executing | **Later · P6** | `packages/agent-engine`, `apps/web` | T-AUT-3 (=F1 P6) | low | §3 | Dry-run lists planned actions; nothing executes |
| Per-automation approval policy | Approval policy + budget cap attached to each automation | **Later · P6** | `services/api`, §12 | T-AUT-4 | medium | §12, §30 | Automation runs respect their approval policy and budget |
| Enable / disable | Disabling/deleting an automation stops future runs immediately | **Later · P6** | `services/api`, `packages/queue` | T-AUT-5 (=F1 P6) | low | T-AUT-1 | Disabled automation produces no further runs |

---

## 10. Wide / parallel research

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Map-reduce sub-agents | **Parallel Research**: coordinator spawns N sub-sessions via BullMQ flow (parent/child) | **Later · P10** | `services/worker`, `packages/agent-engine`, `packages/queue` | T-WR-1 (=F1 P10) | medium | §3, §30 | Coordinator fans out N sub-agents and reduces to one result |
| Per-sub-agent budget | Each sub-agent has its own step/token budget + isolation | **Later · P10** | `packages/agent-engine`, §30 | T-WR-2 | high | §30 | Sub-agents stay within per-sub budgets; one failing sub doesn't break the reduce |

---

## 11. Memory & context management

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Context management | Chunking + summarization + cache-aware message construction in the engine | **MVP · P2** | `packages/agent-engine`, `packages/llm` | T-MEM-1 | low | §3 | Long input is chunked/summarized; context stays within model limits; cache hints applied |
| Prompt caching | Anthropic prompt-cache via `LlmProvider` cache hints | **MVP · P2** | `packages/llm` | T-MEM-2 | low | §3, §29 | Repeated stable prefix yields a cache hit; cost meter reflects cached tokens |
| Vector memory retrieval (RAG) | `MemoryStore` over pgvector (HNSW), tenant-scoped | **MVP-minimal · P1** / depth **Later · P7** | `packages/memory`, `packages/db` | T-MEM-3 | medium | §32 | KNN retrieval filtered by `workspace_id`; no cross-tenant leakage |
| Privacy controls on memory | User controls what reaches the model; excluded data never sent | **Later · P7** | `packages/memory`, `packages/agent-engine` | T-MEM-4 (=F1 P7) | high | T-MEM-3, §29 | Data marked excluded never appears in a model prompt (asserted) |
| Knowledge / playbooks | Knowledge base + preferences enriching tasks | **Later · P7** | `packages/memory` | T-MEM-5 (=F1 P7) | medium | T-MEM-3 | Retrieved knowledge measurably improves a task while respecting privacy settings |

---

## 12. Permission / risk / approval

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Risk levels | `low/medium/high/critical` on every action (hard rule) | **MVP · P2** | `packages/tool-abi`, `packages/agent-engine` | T-RISK-1 (=F1 C1) | high | §4 | Every action carries a risk level; classification deterministic for fixtures |
| Approval gate | high/critical actions pause for explicit approval before execution | **MVP · P2/P3** | `services/api/approvals`, `packages/agent-engine`, `apps/web` | T-RISK-2 (=F1 C1) | high | §2 | `approval_request` emitted; run pauses; `approve` proceeds, `deny` aborts cleanly; both audited |
| Scope grant on approval | Approval may grant a scope (e.g. a folder) carried in `approve{scope}` | **MVP · P4** | `services/api`, `apps/sidecar` | T-RISK-3 | high | §7 | Approving a write grants the target folder scope to the sidecar for that session |
| Instant stop / kill switch | Global + per-action stop (hard rule) | **MVP · P2** | `packages/agent-engine`, `services/gateway` | T-RISK-4 (=F1 B3) | critical | §3 | Stop halts within one step boundary; in-flight ops aborted; audited |
| Sensitive-data masking | Centralized masking in UI, logs, prompts, replays (hard rule) | **MVP · P1+** | `packages/logger`, `apps/web`, `packages/agent-engine` | T-RISK-5 (=F1 F2) | high | §31 | Seeded secret is masked in UI, logs, model prompts, and shared replay |
| Destructive-action default | Irreversible ops default to `critical` and always gate | **MVP · P2** (policy) / enforced **P5** | `packages/agent-engine`, `apps/sidecar` | T-RISK-6 (=F1 P5) | critical | §7 | `rm -rf` classified `critical`; blocked until approved |

---

## 13. API / integration center (connectors)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| OAuth connectors | **Connectors**: OAuth in a sandboxed child window; scoped tokens brokered server-side | **Later · P7** | `services/api/connectors`, `apps/desktop` | T-INT-1 | high | §1, §29 | OAuth completes in a sandboxed child window; token stored encrypted, never in renderer |
| Connector token vault | Connector tokens envelope-encrypted at rest | **Later · P7** | `packages/crypto`, `packages/db` | T-INT-2 | critical | §29 | DB dump yields only ciphertext for connector tokens |
| Third-party action tools | Connector-backed tools (e.g. send message, read doc) registered with risk tags | **Later · P7** | `packages/tool-abi`, §4 | T-INT-3 | high | T-INT-1, §12 | A connector tool runs with correct risk tag; high-risk action gated |
| No main-window 3rd-party nav | Connector flows never navigate the main window into 3rd-party sites | **Later · P7** | `apps/desktop` | T-INT-4 | medium | §29 | Connector navigation confined to a sandboxed child window |

---

## 14. Public API / developer platform

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| REST public API | Documented REST endpoints (create task, fetch, artifacts) | **Later · P10** | `services/api` | T-API-1 (=F1 P10) | high | §1, §29 | OAuth app obtains a scoped token and creates a task via REST |
| Webhooks | Outbound webhooks on task lifecycle events | **Later · P10** | `services/api`, `services/worker` | T-API-2 (=F1 P10) | medium | T-API-1 | Task completion delivers a signed webhook to the registered URL |
| OAuth apps | Third-party OAuth app registration + scoped tokens | **Later · P10** | `services/api/auth` | T-API-3 | high | §1 | App registered; scopes enforced on each call |
| Rate limits | Per-token/per-workspace rate limiting (Redis) | **Later · P10** | `services/api`, Redis | T-API-4 (=F1 P10) | medium | T-API-1 | Exceeding the limit returns 429; limit reset behaves correctly |

---

## 15. Projects (depth)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Project workspaces | Rich project surface: shared files, memory, settings, budget profile | **Later · P7** | `apps/web`, `services/api` | T-PRJ-1 | low | §1 | Project shows shared files/memory/settings; budget profile enforced |
| Per-project permission profile | Permission + approval profile scoped to a project | **Later · P7** | `services/api`, §12 | T-PRJ-2 | high | §12 | Project-scoped permission profile overrides workspace defaults where set |

> Projects-**lite** (grouping + budget field) ships MVP in §1; this section is the depth deferred to P7 (matches F1 Appendix A note "Projects-lite in 1").

---

## 16. Skills (reusable task graphs)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Saved playbooks | **Skills** = saved, parameterized task graphs | **Later · P7** | `packages/agent-engine`, `services/api` | T-SKL-1 (=F1 P7) | medium | §3 | A Skill runs with new parameters and reproduces its structure |
| Skill parameters | Typed parameter schema (Zod) per Skill | **Later · P7** | `packages/tool-abi`/`agent-engine` | T-SKL-2 | low | T-SKL-1 | Invalid params rejected; valid params bind into the graph |
| Skill sharing | Share Skills within a workspace | **Later · P7** | `services/api`, §17 | T-SKL-3 | medium | §17 | Shared Skill runnable by permitted members only |

---

## 17. Collaboration

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Shared workspaces | Multi-user workspace membership with roles | **Later · P7** | `services/api/workspaces` | T-COL-1 (=F1 P7) | medium | §1 | A second user views per role; unauthorized access denied |
| Comments | Comments on tasks/artifacts | **Later · P7** | `services/api`, `apps/web` | T-COL-2 | low | T-COL-1 | Comment created, visible per role, audited |
| Presence | Live presence in shared sessions (Redis) | **Later · P7** | `services/gateway`, Redis | T-COL-3 | low | T-COL-1 | Presence reflects active viewers; clears on disconnect |
| Shared tasks | Tasks visible/actionable by permitted members | **Later · P7** | `services/api` | T-COL-4 | medium | T-COL-1 | Permitted member can view/act; permission-scoped sharing enforced |

---

## 18. Mail-to-task

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Inbound email → task | **Mail-to-Task**: inbound email/webhook creates a pending task | **Later · P8** | `services/api`, `services/worker`, §9 | T-MTT-1 (=F1 P8) | high | §9 | Allowlisted inbound email creates a task pending approval |
| Sender allowlist | Only allowlisted senders may create tasks | **Later · P8** | `services/api` | T-MTT-2 (=F1 P8) | high | T-MTT-1 | Non-allowlisted sender is rejected + logged |
| Approval before execute | Mail-created tasks require approval before running | **Later · P8** | §12 | T-MTT-3 | high | §12 | Task does not execute until approved |

---

## 19. Meeting module

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Transcript → action items | **Meeting module**: transcript ingestion → action items/tasks | **Later · P8** | `services/worker`, `packages/agent-engine` | T-MTG-1 (=F1 P8) | medium | §3 | Transcript converts into action items/tasks with correct linkage |
| Consent / on-device option | Consent capture + optional on-device transcription | **Later · P8** | `apps/desktop` | T-MTG-2 | high | §29 | Consent required; on-device option keeps audio local |

---

## 20. Multimedia generators

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Image/video/audio generation | **Multimedia** generators → artifacts | **Later · P9** | `services/worker`, `packages/blob-store` | T-MM-1 (=F1 P9) | medium | §8 | Each generator produces a valid, openable artifact |
| Original viewers | Original in-app viewers for generated media | **Later · P9** | `apps/web`, `packages/ui` | T-MM-2 | low | T-MM-1 | Generated media renders in an original viewer |

---

## 21. Design view

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Visual deliverable editor | **Design view**: original visual editing surface for deliverables | **Later · P9** | `apps/web`, `packages/ui` | T-DSN-1 (=F1 P9) | low | §8 | A deliverable is edited in the design view and re-saved as an artifact |

---

## 22. Slides + Presenter

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Deck generation | **Slides** generator → deck artifact | **Later · P9** | `services/worker`, `packages/blob-store` | T-SLD-1 (=F1 P9) | low | §8 | A valid, openable deck is generated |
| Presenter mode | Multi-monitor Presenter window | **Later · P9** | `apps/desktop` | T-SLD-2 (=F1 P9) | low | T-SLD-1 | Presenter spans multiple monitors |

---

## 23. Data analysis

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Notebook-style analysis | **Data analysis**: notebook + charts in the sandbox | **Later · P9** | `services/sandbox-orchestrator`, `apps/web` | T-DA-1 (=F1 P9) | medium | §5, §8 | An analysis runs and produces charts/tables as artifacts |
| Spreadsheets-lite | Basic spreadsheet read/write/generate | **MVP-lite · P2/P3** (reports+sheets-lite) / depth **Later · P9** | `packages/agent-engine`, `packages/blob-store` | T-DA-2 | low | §8 | A simple spreadsheet artifact is generated (MVP-lite per F1 §4 "spreadsheets-lite") |
| Charts depth | Rich charting and dashboards | **Later · P9** | `apps/web`, `packages/ui` | T-DA-3 | low | T-DA-1 | Charts render correctly from analysis output |

---

## 24. Data provider registry

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Data source catalog | **Data Provider Registry**: typed, risk-tagged data-source connectors feeding tools | **Later · P9/P10** | `packages/tool-abi`, `services/api/connectors` | T-DPR-1 | high | §13, §26 | A registered data provider exposes a typed, risk-tagged fetch tool |
| Provider credentials | Provider credentials envelope-encrypted | **Later · P9/P10** | `packages/crypto` | T-DPR-2 | critical | §29 | Provider creds stored encrypted; never in renderer |

> Bridges Connectors (§13) and MCP (§26); shares the tool-ABI risk model.

---

## 25. No-code / webhook builder

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Webhook trigger builder | **No-code/webhook**: configure inbound webhooks → tasks (reuses §9 triggers) | **Later · P10** | `services/api`, `services/worker` | T-NC-1 | high | §9 | A configured webhook creates a pending task; signature verified |
| Visual flow builder | No-code visual composition of Skills/automations | **Later · P10** | `apps/web` | T-NC-2 | medium | §16, §9 | A visually composed flow runs as a Skill/automation |

---

## 26. MCP connector layer

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Install/manage MCP servers | **MCP layer**: install/manage user MCP servers; open tool extension | **Later · P10** | `packages/tool-abi`, `services/api` | T-MCP-1 (=F1 P10) | high | §4, §29 | An MCP server installs, exposes tools through the registry with risk tags, runs sandboxed |
| Per-server permission scopes | Each MCP server gets revocable permission scopes | **Later · P10** | `services/api`, §12 | T-MCP-2 | high | §12 | Revoking a server's scope blocks its tools + audits |
| Sandboxed MCP exec | MCP tool execution confined to the sandbox | **Later · P10** | `services/sandbox-orchestrator` | T-MCP-3 | high | §5 | MCP tool cannot access backend secrets; runs under sandbox isolation |

---

## 27. Website builder + publish pipeline

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Generate site | **Website builder**: generate static site artifact | **Later · P9** | `services/worker`, `packages/blob-store` | T-WB-1 (=F1 P9) | medium | §8 | A site is generated as a deployable artifact |
| Preview vs published | Publish pipeline: object-store static hosting, preview then publish | **Later · P9/P10** | `packages/blob-store`, `services/api` | T-WB-2 (=F1 P9) | high | T-WB-1 | Deploys to a preview URL, then publishes |
| Custom domains (CNAME) | CNAME custom-domain mapping with per-site access control | **Later · P10** | `services/api` | T-WB-3 (=F1 P9) | high | T-WB-2 | A custom domain resolves via CNAME; access controls enforced |

---

## 28. Admin & settings

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Settings: API key entry | Settings stores the Anthropic key **encrypted at rest**, never in frontend | **MVP · P1** | `services/api/settings`, `packages/crypto` | T-ADM-1 (=F1 F1) | critical | §29, §32 | Key stored envelope-encrypted; decrypt server-only; bundle scan finds zero secrets |
| Settings: model/provider | Default model `claude-opus-4-8`; provider selectable via `LlmProvider` (Anthropic only v1) | **MVP · P1** | `packages/llm`, `services/api/settings` | T-ADM-2 | medium | §3 | Default model is `claude-opus-4-8`; provider abstraction in place; BYO-key per workspace |
| Settings: budgets/permissions | Per-workspace budget caps + per-tool permission defaults | **MVP-lite · P1** / depth **Later · P7** | `services/api`, §12, §30 | T-ADM-3 | medium | §30 | Budget + permission defaults persisted and applied |
| Admin console (RBAC) | **Admin console**: workspaces/users/roles, org settings | **Later · P7** | `apps/web`, `services/api` | T-ADM-4 (=F1 P7) | high | §1 | Roles gate admin actions; unauthorized admin action denied |
| Audit export | Tamper-evident audit export | **Later · P7** | `services/api`, §31 | T-ADM-5 (=F1 P7) | high | §31 | Export produces a complete, tamper-evident audit log |
| Budget policy admin | Org-level budget policy management | **Later · P7** | `services/api/billing`, §30 | T-ADM-6 | medium | §30 | Org budget policy enforced across workspaces |
| Server-driven feature flags | Flags served from backend; never baked into the bundle | **MVP · P0/P1** | `services/api`, `packages/config` | T-ADM-7 (=F1 C24) | medium | §29 | No flags/secrets in the static bundle; flags fetched at runtime |

---

## 29. Security (cross-cutting)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| No secrets in frontend | LLM key/secrets never reach renderer; CI bundle scan gate | **MVP · P1** | `packages/config`, CI | T-SEC-1 (=F1 F1) | critical | §32 | Bundle scan finds zero secrets/dev-endpoints; CI fails on any leak |
| Envelope encryption | KMS master key wraps per-secret AES-256-GCM data keys | **MVP · P1** | `packages/crypto` | T-SEC-2 (=F1 F1) | critical | §32 | DB dump yields only ciphertext; key rotation re-wraps without re-encrypting all data |
| Sandboxed renderer + typed IPC | `sandbox:true`, `contextIsolation:true`, named allowlisted IPC (no `invoke` passthrough) | **MVP · P0/P4** | `apps/desktop`, `packages/desktop-ipc` | T-SEC-3 (=F1 D1) | high | §1 | Unlisted IPC channel rejected; only Zod-validated named methods succeed |
| Full CSP + scoped CORS | `default-src`/`connect-src`/`object-src 'none'` + nonce'd `script-src`; CORS our-origins only | **MVP · P0/P4** | `apps/desktop`, `services/api` | T-SEC-4 (=F1 D4) | high | §1 | Full CSP present; no `<all_urls>` CORS strip |
| PKCE deep-link auth | One-time code over HTTPS; no plaintext token in deep-link | **MVP · P2** | `apps/desktop`, `packages/auth` | T-SEC-5 (=F1 D2) | high | §1 | Plaintext token never in deep-link; state/nonce mismatch rejected |
| Sidecar integrity | Codesign-verify + hash-pin before spawn; refuse unverified | **MVP · P4** | `apps/desktop`, `apps/sidecar` | T-SEC-6 (=F1 E1) | critical | §7 | Tampered/unsigned binary refused |
| Tenancy isolation (RLS) | Workspace scoping + Postgres RLS backstop | **MVP · P1** | `packages/db`, `services/api` | T-SEC-7 (=F1 P1) | high | §32 | Cross-tenant query denied at the DB layer |
| CAPTCHA/2FA hard rule | Agent pauses + hands off; no bypass tooling ships | **MVP · P2** (policy) / **P5** (browser) | `packages/agent-engine`, `packages/tool-abi` | T-SEC-8 (=F1 P5) | high | §5, §6 | CAPTCHA/2FA → pause + hand off; no bypass code present (asserted) |
| Window-open / navigation guard | `setWindowOpenHandler` denies `window.open`; untrusted nav opened externally | **MVP · P4** | `apps/desktop` | T-SEC-9 | medium | §1 | `window.open` denied; untrusted `will-navigate` cancelled, opened in external browser |

---

## 30. Cost control (cross-cutting)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Token/cost metering | Per-call usage → metered to Postgres per task/workspace/user/month | **MVP · P2** | `packages/llm`, `services/api/billing`, §32 | T-COST-1 (=F1 P2) | medium | §29 | Token+cost metered per task & workspace; reconciles with provider usage in a fixture |
| Pre-flight cost estimate | `cost_estimate` emitted before expensive runs; pauses over threshold | **MVP · P2** | `packages/agent-engine` | T-COST-2 (=F1 C2) | high | T-COST-1 | `cost_estimate{overThreshold:true}` pauses the run for approval before spending |
| Hard budget caps | Per-task / workspace / month caps block over-budget runs | **MVP · P2** | `services/api/billing`, `packages/agent-engine` | T-COST-3 | high | T-COST-1 | A run that would exceed the cap is blocked before spend; audited |
| Context-management savings | Caching/summarization/chunking/memory reduce spend | **MVP · P2** | `packages/agent-engine`, §11 | T-COST-4 | low | §11 | Cached/summarized run costs measurably less than naive run on a fixture |
| Billing / credits / tiers | Stripe metering, quota, tier gating | **Later · P10** | `services/api/billing` | T-COST-5 (=F1 P10) | high | T-COST-1 | Usage meters to Stripe; quota exhaustion gates further runs |

---

## 31. Logging, audit & telemetry (cross-cutting)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Append-only event log | Every event persisted to Postgres event log; replayable | **MVP · P1/P3** | `packages/db`, `services/gateway` | T-LOG-1 (=F1 B1) | medium | §32 | Every event persisted; replay reproduces the stream deterministically |
| Audit log w/ risk + approvals | Every important action audited with risk level + approval decision | **MVP · P1** | `services/api`, `packages/db` | T-LOG-2 (=F1 P1) | high | §32 | Every privileged mutation writes an audit row incl. risk + decision |
| Replay | Re-render persisted event stream | **MVP · P3** | `apps/web`, §32 | T-LOG-3 (=F1 B1) | low | T-LOG-1 | Finished task replays deterministically |
| Log redaction / masking | Tokens/PII redacted at the logging boundary | **MVP · P1** | `packages/logger` | T-LOG-4 (=F1 F2) | high | §29 | Tokens/PII redacted in all sinks and in `chat`/`device` URLs |
| First-party telemetry + Sentry | One first-party pipeline + Sentry (errors only); no fingerprinting | **MVP · P1/P3** | `services/api`, `apps/web` | T-LOG-5 (=F1 P3) | low | — | Telemetry flows to one pipeline; Sentry captures a forced error; no fingerprinting SDKs |
| OpenTelemetry traces | Spans across request→queue→engine→tool→sandbox | **MVP · P2+** | services, `packages/logger` | T-LOG-6 | low | §3 | A long run produces a connected trace across services |

---

## 32. Database

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Schema + migrations | PostgreSQL 16 + Prisma; reversible migrations | **MVP · P1** | `packages/db` | T-DB-1 (=F1 P1) | medium | — | Migrations apply and roll back cleanly; schema matches documented table list |
| Core tables | `users, workspaces, projects, sessions, tasks, plans, steps, events, tool_invocations, audit_log, permissions, usage, artifacts, memory(+vector), connectors, automations, approvals` | **MVP core · P1** (later tables per phase) | `packages/db` | T-DB-2 | medium | T-DB-1 | All MVP tables exist with workspace scoping; later tables added in their phase |
| pgvector embeddings | `vector` columns + HNSW index in the same DB | **MVP-minimal · P1** / **P7** | `packages/db`, `packages/memory` | T-DB-3 | low | T-DB-1 | KNN query returns tenant-scoped results via HNSW |
| Append-only partitioning | Event/audit tables partitioned by time/session | **MVP · P1** (basic) / scale **Later** | `packages/db` | T-DB-4 | low | T-DB-1 | Event/audit inserts succeed at volume; partition strategy documented |
| Desktop local store | SQLite in desktop `userData` (local index, device id, permission/audit ledger) | **MVP · P4** | `apps/desktop`, `apps/sidecar` | T-DB-5 | medium | §7 | Local SQLite holds device id + per-tool permission/audit ledger |

---

## 33. Testing (cross-cutting)

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Unit/integration harness | Vitest across all TS; coverage via v8 | **MVP · P0+** | all packages, `packages/test-utils` | T-TST-1 (=F1 H2) | low | — | `test` task green; failing test blocks merge (no module "done" w/o tests) |
| Contract tests | `protocol`/`tool-abi` contract + JSON-Schema parity tests | **MVP · P0** | `packages/protocol`, `packages/tool-abi` | T-TST-2 (=F1 A2/A3) | medium | §4 | Contract drift fails compile in both client + server; ABI↔schema parity holds |
| API/integration (Testcontainers) | Ephemeral Postgres/Redis/MinIO for data-layer + queue tests | **MVP · P1+** | `packages/test-utils` | T-TST-3 (=F1 H1) | low | §32 | Integration tests run against real engines, not mocks |
| E2E (web + desktop) | Playwright Test on web + Electron (`_electron`) | **MVP · P3/P4** | E2E suite | T-TST-4 (=F1 D3) | medium | §2, §1 | Identical UI results on web (Chromium) + Electron renderer; full task loop passes on both |
| Rust sidecar tests | `cargo test` for traversal refusal, approval gating, reconnect | **MVP · P4** | `apps/sidecar` | T-TST-5 (=F1 E1/E2) | high | §7 | Path-traversal + RO-write refusals and reconnect logic pass |
| Hardening / chaos sweep | Dedicated E2E/security/load/kill-switch/pen-test sweep | **Later · P11** | all | T-TST-6 (=F1 P11) | high | all MVP | Kill-switch/chaos drills leave no orphaned sandbox/sidecar; security posture verified |
| Cost-regression / load | Cost-regression + load tests within budget thresholds | **Later · P11** | `services/*`, §30 | T-TST-7 (=F1 P11) | medium | §30 | Cost + load tests pass within thresholds |

---

## 34. Packaging & distribution

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| Installer + auto-update | electron-builder dual target: NSIS (self-update feed) + MSIX (Store) | **Later · P12** | `apps/desktop`, `infra` | T-PKG-1 (=F1 P12) | high | §1 | Signed NSIS auto-updates from feed; MSIX installs from Store path |
| Signed + hash-pinned sidecar | Sidecar shipped signed + hash-pinned; tamper blocks launch | **Later · P12** | `apps/sidecar`, `apps/desktop` | T-PKG-2 (=F1 P12) | critical | §7 | Tamper detection blocks launch |
| macOS/Linux parity | Cross-platform build-out begins | **Later · P12** | `apps/desktop`, `apps/sidecar` | T-PKG-3 (=F1 P12) | medium | T-PKG-1 | macOS/Linux parity build produces installable artifacts |
| Crash reporting | Crash/error reporting wired (Sentry) | **Later · P12** | `apps/desktop`, §31 | T-PKG-4 | low | §31 | A forced crash is reported with a redacted payload |
| Quick Launcher / Presenter / tray | Global-hotkey pill, Presenter, tray (cross-platform, enabled) | **Later · P10/P12** | `apps/desktop` | T-PKG-5 | low | §1 | Quick Launcher hotkey opens the pill; tray + Presenter functional |

---

## 35. Documentation

| Manus capability | AgentOS equivalent | MVP/Phase | Technical module | Test scenario | Risk | Dependencies | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| User docs | End-user guide for the task loop, approvals, local-first | **Later · P13** | `docs/` | T-DOC-1 (=F1 P13) | low | all surfaces | Docs accurate against shipped behavior |
| Developer / tool-ABI docs | Tool-ABI + protocol developer reference | **Later · P13** | `docs/` | T-DOC-2 (=F1 P13) | low | §4 | A new developer builds + runs both surfaces from docs alone (dry-run validated) |
| API reference | Public API reference | **Later · P13** | `docs/` | T-DOC-3 | low | §14 | API reference matches shipped endpoints |
| Security & permissions docs | Security model, risk levels, permission scopes, runbooks | **Later · P13** | `docs/` | T-DOC-4 | low | §29 | Security/permissions docs match enforced behavior |

---

## Coverage check (all 30 spec categories + cross-cutting)

`users/workspaces/projects §1` · `agent chat §2` · `agent engine §3` · `tool registry §4` · `cloud browser §5` · `local browser operator §6` · `preferred browser §6` · `local computer operator §7` · `file system §8` · `artifacts §8` · `automations/scheduled §9` · `wide research §10` · `memory/context §11` · `permission/risk §12` · `API/integration center §13` · `public API §14` · `projects §15` · `skills §16` · `collaboration §17` · `mail-to-task §18` · `meeting minutes §19` · `multimedia §20` · `design view §21` · `slides §22` · `data analysis §23` · `data provider registry §24` · `no-code/webhook §25` · `MCP connector §26` · `website builder §27` · `admin/settings §28` · `security §29` · `cost control §30` · `logging §31` · `database §32` · `testing §33` · `packaging §34` · `docs §35`. **All present.**

---

## Row inventory & MVP/Later tally

| Bucket | Rows |
|---|---|
| **Total capability rows** | **131** |
| **MVP (≤ Phase 4, incl. MVP-lite / MVP-minimal)** | **64** |
| **Later (Phase 5–13)** | **67** |

> MVP rows land across Phases 0–4 and constitute the MVP gate (end of Phase 4) — the full loop *plan→tools→approval→recover→verify→deliver* with audit, cost, masking, and instant-stop on **both web and desktop**. Later rows (Phases 5–13) extend local power, browser takeover, automations, org/admin, ingestion, the creation suite, the open platform (MCP + public API + wide research + billing), hardening, packaging, and docs. All tags match `docs/00-scope-and-phases.md` Appendix A and §4/§5.
