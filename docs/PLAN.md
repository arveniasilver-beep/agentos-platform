# AgentOS — Master Plan (Authoritative)

> **Status:** Planning only. No code is written by this document. TypeScript appears solely as interface *sketches* that pin contracts.
> **Codename:** `AgentOS` — a placeholder, trivially renameable. Every user-visible string and protocol scheme derives from a single source of truth, `packages/brand`. Renaming = edit one file + run one codegen script (§34).
> **Default model:** Claude Opus, exact id **`claude-opus-4-8`**, via the Anthropic API behind a clean `LlmProvider` abstraction. Key entered in settings, **encrypted at rest, never exposed to the frontend**.
> **This is the document you approve.** It is the read-through that ties every sub-doc together. Reply **`start`** to begin Phase 0.

---

## Executive summary

AgentOS is a **production-grade, security-first AI agent operating platform**. A user gives a natural-language task; the system understands it, makes a plan, decomposes it into steps, routes each step to typed tools (web search, code/file execution in a sandbox, cloud browser, and — on desktop — approved local files), logs every important action, **asks approval before any risky action**, recovers from errors, verifies the result, and delivers a clear final artifact. It is **not** a chatbot — the unit of work is a **Task** with a plan, steps, tool calls, artifacts, an audit log, and a verified deliverable.

It ships as **two surfaces sharing one UI codebase**: a web app and a real **Windows desktop app** (Electron), with the architecture portable to macOS/Linux later. The desktop adds a **local operator sidecar** (Rust) that operates *explicitly approved* local resources under per-action approval, with the cloud as supervisor — our headline **local-first privacy** differentiator.

Every action carries a **risk level** (`low | medium | high | critical`); `high`/`critical` require explicit approval; the user can **stop any action instantly**; sensitive data is masked everywhere; the LLM key is envelope-encrypted server-side and never reaches the renderer. We **mirror the capability category** of Manus-style agents with a fully original implementation and a different architecture (local-first, BYO-model, per-tool auditable permissions, open MCP/tool layer, sandboxed renderer, PKCE auth, container/microVM-per-session sandbox).

**The MVP** (Phases 0–4) proves the whole spine end-to-end on **both web and desktop**: sign in → give a task → watch *plan → decompose → run tools in a sandbox (web search + code/file + read-only local files) → approve a risky step → recover from an error → verify → deliver an artifact*, with full audit, cost tracking, and an instant stop. Everything else is sequenced into Phases 5–13.

**The stack** is TypeScript-everywhere (Rust for the sidecar): pnpm + Turborepo monorepo; Next.js static-export SPA (React 19) rendered identically on web and desktop; NestJS-on-Fastify API + Socket.IO gateway + BullMQ workers hosting the agent engine; PostgreSQL 16 + pgvector (Prisma); Redis; S3/R2/MinIO behind a `BlobStore`; container-per-session sandbox (Docker + gVisor); **Electron** for the desktop shell (verdict in §6).

---

## Decisions still needed from the user before coding

These do not block Phase 0 (foundations are decided), but we want your call before the phases that consume them:

1. **Product name & deep-link scheme.** Confirm the real `appName`, `appId` (bundle/AppUserModelId, e.g. `com.<you>.desktop`), and the `agentos://` deep-link scheme replacement. We wire these into `packages/brand` and re-sign. *(Default: keep `AgentOS`/`agentos://` until you decide.)* — needed before **Phase 4** (desktop deep-link) / **Phase 12** (signing).
2. **Hosting target & cloud accounts.** Where the backend, Postgres, Redis, object storage, and sandbox pool run (self-host vs a cloud), and which **object store** (Cloudflare R2 vs AWS S3 vs self-host MinIO). Affects KMS choice for envelope encryption. — needed before **Phase 1** infra.
3. **LLM key model.** Single platform-owned Anthropic key vs **BYO-key per workspace** (or both). Both use the same encrypted path; this only sets defaults and billing posture. — needed before **Phase 2**.
4. **Default budget policy.** Per-task / per-workspace / monthly USD caps and the **cost-estimate threshold** that triggers a pre-flight approval prompt. — needed before **Phase 2**.
5. **Code-signing identities.** Windows code-signing certificate (and, later, Apple notarization) for the app and the **hash-pinned sidecar** binary. — needed before **Phase 4** (sidecar spawn) / **Phase 12** (distribution).
6. **MVP local-folder default.** Which local folder(s) the desktop offers as the first **read-only** shared scope, and whether RW is allowed at all in MVP (default: **RO only** in MVP; RW + shell gated to Phase 5).
7. **Telemetry posture.** Confirm "one first-party pipeline + Sentry (errors only), no device fingerprinting" — or specify any compliance constraints (GDPR region, data residency). — needed before **Phase 1/3**.
8. **Brand/legal sign-off** that the originality rules are satisfied (no copied Manus branding/UI/copy/names/design/code; teardown used only for capability mapping).

---

## Documentation index

| Doc | Scope |
|---|---|
| **`docs/PLAN.md`** (this file) | Authoritative master plan — all §38 items, read-through, approval gate |
| `docs/README.md` | Index of the `docs/` folder |
| `docs/00-scope-and-phases.md` | Scope, capability mapping, MVP/Later, phases, per-phase acceptance, risks, first coding step |
| `docs/01-stack-and-system-architecture.md` | Tech stack + reasoning, Electron-vs-Tauri verdict, system architecture, folder structure, rename strategy |
| `docs/arch/agent-engine.md` | Agent loop state machine, task lifecycle, 13 engine subcomponents, tool registry/ABI, queue/worker, memory/context |
| `docs/arch/desktop-and-local.md` | Desktop app, local computer/browser operators, preferred browser, permission model, local-operator protocol |
| `docs/arch/cloud-browser.md` | Browser worker pool, session state machine, action set, live-view transport, takeover, safety |
| `docs/arch/files-and-media.md` | File system, artifacts/provenance, multimedia, design view, slides, data analysis, data providers |
| `docs/arch/platform-features.md` | Projects, Skills, Collaboration, Mail-to-Task, Meetings |
| `docs/arch/integrations.md` | Integration Center, MCP registry, no-code automations/triggers, website builder, Public API |
| `docs/arch/security-cost-testing.md` | Risk/permission model, approval flow, encryption, cost/resource control, logging, testing strategy |
| `docs/DATABASE.md` | PostgreSQL 16 / Prisma schema — 38 tables (+`approvals`), enums, pgvector, RLS, partitioning |
| `docs/API.md` | REST `/api/v1` + WebSocket (`/chat`, `/device`) endpoint draft |
| `docs/FEATURE_MATRIX.md` | 131 capability rows × 8 columns (capability, AgentOS equivalent, phase, module, test, risk, deps, acceptance) |
| `_research/MANUS_TEARDOWN.md` | Prior research: Manus desktop client teardown (capability mapping only) |
| `_research/BUILD_BLUEPRINT.md` | Prior research: product build blueprint |

---

# 1. Final project scope

**One sentence.** AgentOS turns a natural-language task into a planned, decomposed, tool-routed, auditable execution — across cloud and *approved* local computer resources — delivered through **both a web app and a Windows desktop app**, defaulting to Claude Opus (`claude-opus-4-8`) behind a clean provider abstraction.

**What it IS (v1):**
- A **task-execution platform**, not a chat toy. The unit of work is a Task (plan, steps, tool calls, artifacts, audit log, verified deliverable).
- An **agent runtime** running: *understand → plan → decompose → route to tools → act (browser/files/APIs/local) → log → ask approval on risk → recover → verify → deliver.*
- A **two-surface product**: one shared UI rendered by a web app and an Electron Windows app; OS-portable; desktop adds a **local operator bridge** (sidecar) for *explicitly approved* local resources.
- **Security-first and auditable**: every action has a risk level; `high`/`critical` gate on approval; instant stop; sensitive data masked; every important action logged.
- **BYO-model & cost-aware**: key encrypted at rest, never in frontend; tokens/cost tracked per task/workspace/user/month; pre-flight estimate for expensive tasks; context management to minimize spend and private-data exposure.

**What it is NOT (v1):** a bare chatbot; a Manus clone (no copied branding/UI/copy/names/design/code); a CAPTCHA/2FA bypass tool (the agent pauses and hands off); an unattended destructive-automation engine (high/critical always gate on approval); multi-OS at v1 desktop (Windows first); multi-cloud-LLM at v1 (Anthropic default, abstraction ready); a fake/demo (no placeholder endpoints/buttons, no TODOs in core paths, no module "done" without passing tests).

**Non-negotiable hard rules** (reflected in every design decision):
1. No fake endpoints/buttons; no placeholders/TODOs in core functionality.
2. No module marked done without passing tests.
3. Security-first; no secrets in the frontend; API keys encrypted at rest.
4. Every action has a risk level; `high`/`critical` require approval.
5. User can stop any action instantly (global kill switch + per-action stop).
6. Sensitive data masked in UI, logs, and model prompts.
7. No CAPTCHA/2FA bypass; no spam/abuse/ToS violations.

*Full detail: `docs/00-scope-and-phases.md` §1.*

---

# 2. Capability mapping (Manus-style category → AgentOS original)

We mirror the *capability category* with original implementations. Thirty capability classes (C1–C30) each map to an AgentOS equivalent with a differentiator and an MVP/Later tag. Highlights:

| Manus-style capability | AgentOS original | Differentiator | Tag |
|---|---|---|---|
| Server-side agent brain | **Agent Runtime** (plan→act→observe→replan; thin client) | Open event/tool ABI; step budgets + kill switch | **MVP** |
| Cloud sandbox VM | **Session Sandbox** (container-per-session, gVisor) | Documented isolation; idle-reaping; local-first alternative | **MVP** |
| Typed tool catalog | **Tool Registry** (typed + risk-tagged + scoped) | Per-tool revocable permissions, risk-gated approval | **MVP** |
| "Computer" live panel | **Live Activity Panel** (streamed terminal/file/browser) | Per-action audit overlay; approved takeover | **MVP** (read view) |
| Local sidecar bridge | **Local Operator** (Rust, reconcile loop, hash-pinned) | RO/RW scopes, OS jail, per-action approval, "what it touched" log | **MVP-lite** (files RO) |
| Deep-link OAuth | **PKCE deep-link auth** | One-time code over HTTPS (no plaintext token) | **MVP** |
| Realtime channel | **Realtime bus** (Socket.IO, typed contracts, `/chat`+`/device`) | Typed shared contracts; epoch-guarded op queue | **MVP** |
| Projects, Inbox, Library | **Projects / Inbox / Artifact Store** | Per-project budgets; risk-tagged approval queue; content-addressed artifacts | **MVP-lite** |
| Deliverable generators | **Generators** (reports/sheets MVP-lite → slides/design/media/sites Later) | Original viewers; preview-vs-published publish pipeline | **Later** |
| Connectors / MCP / Public API | **Connectors / MCP layer / Public API** | Sandboxed exec, scoped tokens, per-server permissions | **Later** |
| Automations, mail-to-task, meetings, collaboration, admin, billing, packaging | mapped 1:1 to originals | approval policy, allowlists, RBAC, pre-flight estimates, signed updates | **Later** |

*Full 30-row table with differentiators: `docs/00-scope-and-phases.md` §2; capability-to-test mapping: `docs/FEATURE_MATRIX.md`.*

---

# 3. Features that will DEFINITELY exist (committed across the v1 line)

"Definitely exists" ≠ "in MVP" — the phase each lands in is in §35 / Appendix A.

- **Agent core:** NL task intake with intent understanding; inspectable **plan + step decomposition**; ReAct loop with **replanning** and **step/cost budgets**; **verification** step; **error recovery** (retry/backoff, alternate routing, graceful give-up with explanation).
- **LLM provider:** default `claude-opus-4-8` behind `LlmProvider`; key encrypted at rest, never to frontend; token + cost accounting per task/workspace/user/month; **pre-flight cost estimate**; context management (prompt caching, summarization, file chunking, memory retrieval).
- **Tools & execution:** **Tool Registry** (typed schemas, risk levels, permission scopes); cloud **Session Sandbox** (shell/files/headless browser); **file/artifact** read-write with versioning + presigned transfer; **queue + worker** for durable resumable runs.
- **Safety & control:** per-action **risk level**; **approval gate** for high/critical; **instant stop** (global + per-action); **audit log**; **sensitive-data masking**; no CAPTCHA/2FA bypass.
- **Surfaces:** web + Windows desktop sharing one UI; two-pane workspace (plan/conversation + Live Activity); **PKCE** desktop auth; Workspaces / Projects / Tasks hierarchy.
- **Platform (committed, later phases):** realtime step streaming; replay; one first-party telemetry + Sentry; admin/RBAC; connectors/MCP; automations; collaboration; deliverable generators; publish pipeline; public API.

*Full list: `docs/00-scope-and-phases.md` §3.*

---

# 4. MVP — the smallest end-to-end proof

**MVP thesis:** a user signs in, gives a natural-language task, watches AgentOS **plan → decompose → run tools in a sandbox (web search + code/file + read-only local files) → ask approval on a risky step → recover from an error → verify → deliver an artifact**, with full audit, cost tracking, and instant stop — on **both web and the Windows desktop app**. MVP completes at the **end of Phase 4**.

**MVP IN (the spine):**
1. Monorepo + shared typed event & tool ABI consumed by web + desktop.
2. Backend API + DB (workspaces, users, projects, tasks, steps, events, artifacts, audit, usage).
3. Auth: web cookie session + desktop **PKCE** deep-link; workspace/project scoping.
4. Task Engine: intake → plan → decompose → ReAct → verify → deliver; step + cost budgets; replanning; **instant stop**.
5. LLM provider (`claude-opus-4-8`) behind abstraction; encrypted key; token/cost metering; pre-flight estimate; basic context management.
6. Tool Registry with risk tags + scopes; **MVP tools:** web search, code-exec, file read/write (sandbox), **read-only** local file read via Local Operator.
7. Session Sandbox (container-per-session) exposing shell/files/headless browser over WS.
8. File/artifact store (presigned, versioned).
9. Queue + worker for durable runs.
10. Cloud (headless) browser tool; basic Live Activity rendering.
11. Frontend workspace: Home/launcher, two-pane Task view, history, **approval UI**, **stop button**, cost readout, replay.
12. Desktop app (Windows): Electron shell (`app://` + CSP nonce, sandboxed renderer, named typed IPC, single-instance, window-state), PKCE login.
13. Local Operator (sidecar) **MVP-lite**: signed binary, `device_config`/`device_status` reconcile, **read-only** shared folder, live "what it touched" audit, per-action approval scaffolding.
14. Approval + audit + masking wired across the loop; replay of the persisted event stream.
15. Usage metering surfaced in UI.
16. One telemetry pipeline + Sentry; server-driven flags; **no secrets in bundle**.

**MVP OUT (explicitly deferred):** local shell/write exec; preferred-browser drive/takeover; VNC; in-cloud VS Code; automations/scheduling; mail-to-task; meetings; collaboration; admin console; slides/design/multimedia/website-builder/data-analysis generators (MVP delivers reports + files + spreadsheets-lite only); connectors/OAuth; MCP; public API; marketplace/skills; memory/knowledge depth; Wide Research; billing (metering only); Quick Launcher; Presenter; MSIX/Store packaging.

*Full detail: `docs/00-scope-and-phases.md` §4.*

---

# 5. Later-phase features

Grouped by theme (each maps to a phase in §35):

- **Full Local Operator** — read-write folders, gated shell/command exec (per-command allow/deny + approval), OS jail, codesign+hash-pin enforced. *(Phase 5)*
- **Preferred browser & takeover** — drive an approved local browser profile; instant takeover; per-domain consent. *(Phase 5)*
- **Automations** — cron + event triggers, dry-run preview, per-automation approval policy. *(Phase 6)*
- **Admin console** — RBAC, audit export, budget policy, org settings. *(Phase 7)*
- **Projects & Skills depth** — rich projects; Skills = reusable parameterized task graphs; Knowledge/Memory with RAG. *(Phase 7)*
- **Collaboration** — shared workspaces, comments, shared tasks, presence. *(Phase 7)*
- **Mail-to-task** — inbound email/webhook → task with sender allowlist + approval. *(Phase 8)*
- **Meeting module** — transcript ingestion → action items/tasks. *(Phase 8)*
- **Creation suite** — multimedia (image/video/audio), design view, slides + Presenter, data analysis, website builder (generate + deploy, preview/published, custom domains). *(Phase 9)*
- **MCP layer + Public API + Wide/Parallel Research + Billing.** *(Phase 10)*
- **Quick Launcher + Presenter + tray/global hotkeys.** *(Phase 9–later)*
- **macOS/Linux desktop parity; packaging & distribution (NSIS auto-update + MSIX Store; signed sidecar).** *(Phase 12)*
- **Docs** — user + developer + API + security/runbook. *(Phase 13)*

*Full detail: `docs/00-scope-and-phases.md` §5.*

---

# 6. Recommended stack + reasoning (and the Electron-vs-Tauri verdict)

Every decision is filtered through five constraints: **the brain is the product (~90% server-side); secrets never in frontend; one UI two shells; typed contracts end-to-end (Zod); local-first is first-class.**

| Concern | Decision | Why (one line) |
|---|---|---|
| Monorepo | **pnpm + Turborepo** | Shared `protocol`/`tool-abi` as one compiled source of truth; content-hash task caching |
| Language | **TypeScript (strict)** + **Rust** (sidecar) | Same types on both sides of every wire; Rust safety where bugs are catastrophic |
| Frontend | **Next.js App Router, `output: 'export'`, React 19** | A static SPA renders identically in a browser and over `app://` in the desktop shell |
| UI | **Tailwind + shadcn/ui (Radix), CSS-var tokens** | Owned component source (originality), accessible primitives, runtime theming |
| Client state | **Zustand (WS stream/UI) + TanStack Query (REST)** | Stream slices in Zustand; request/response cache in Query; clean, teachable split |
| Backend | **NestJS on the Fastify adapter** | DI/modules/guards/interceptors + first-class WS gateway + BullMQ; Fastify throughput |
| DB | **PostgreSQL 16** (system of record) | ACID + JSONB + pgvector + RLS + partitioned append-only event/audit logs |
| ORM | **Prisma** + raw SQL/Kysely escape hatch | Typed schema + safe migrations; raw SQL for vector KNN / hot aggregations |
| Vector | **pgvector (HNSW) inside Postgres** | One datastore, one tenancy/RLS boundary; Qdrant escape hatch behind `MemoryStore` |
| Queue | **BullMQ on Redis 7** | Durable, retryable, cancellable, cron-capable jobs; Postgres remains source of truth |
| Realtime | **Socket.IO v4 + Redis adapter, typed events** | Auto-reconnect, rooms/namespaces (`/chat`+`/device`), multi-node fan-out |
| Browser automation | **Playwright (Chromium), in the sandbox** | Best auto-wait/isolation/tracing; binaries stay server-side, not in the desktop bundle |
| **Desktop shell** | **Electron (hardened)** | **Verdict below** |
| Sidecar | **Rust** static binary, codesigned + hash-pinned | Memory-safe, single binary, trivially integrity-verified before spawn |
| Sandbox | **Container-per-session (Docker + gVisor)**; Firecracker later | Fast working sandbox; user-space kernel shrinks attack surface; microVM upgrade behind `SandboxProvider` |
| Object storage | **S3/R2/MinIO behind `BlobStore`**; local FS for local-first | Portable + self-hostable; presigned transfers keep blobs off the API |
| Validation/contracts | **Zod** (shared `protocol` + `tool-abi`) | One schema = one type = one validator; Zod→JSON-Schema feeds the LLM tool defs |
| Auth | **First-party OAuth + PKCE (desktop), cookie sessions (web)** | One-time code over HTTPS closes the plaintext-token deep-link risk; no token in renderer JS |
| LLM | **`claude-opus-4-8`** via Anthropic behind `LlmProvider`; key encrypted server-side | Mandated default + clean abstraction; key never serialized to any client bundle |
| Secrets | **Envelope encryption (KMS + AES-256-GCM)** | A DB dump alone yields only ciphertext; rotation re-wraps data keys |
| Testing | **Vitest + Playwright Test + Testcontainers + cargo test + contract tests** | Enforces "no module done without passing tests" in CI |
| Containers | **Docker + Compose** | One `docker compose up` = identical dev/CI environment |
| Observability | **First-party audit/logs + OpenTelemetry + Sentry (errors only)** | Audit log is a product feature; avoid the telemetry-vendor sprawl |

### Electron vs Tauri — **VERDICT: Electron (hardened).**

Two factors dominate for *this* product:
1. **The operator sidecar is our highest-risk, highest-value native component**, and Electron gives a proven, directly portable supervision blueprint (Node `child_process` spawn, PID lockfile, `taskkill /T /F`, `PARENT_PID`, orphan reaping, reconnect/epoch queue, `app://` privileged protocol + per-request CSP nonce).
2. **Engine uniformity** — bundling one Chromium means **web and desktop render in the same engine**, eliminating an entire QA axis for a UI that *is* a live-rendered agent stream. Tauri's per-OS WebView (WebView2/WKWebView/WebKitGTK) would force qualifying the SPA against three engines.

Tauri's real wins — smaller bundle and safer defaults — are **explicitly low-priority** here (the brief de-prioritizes install size; it isn't a headline feature) and **neutralized** by our itemized hardening checklist (we already enumerate Electron's exact weak spots and fixes). We accept ~100 MB+ installs and a higher memory baseline. **Electron is held to a non-negotiable hardening checklist:** `sandbox:true`/`contextIsolation:true`/`nodeIntegration:false`/`webSecurity:true` on every window; **named, typed, Zod-validated IPC allowlist only** (no generic `invoke` passthrough); **scoped CORS** (never `<all_urls>`); **full CSP** (`default-src`/`connect-src`/`object-src 'none'`/nonced `script-src`); `app://` assets (no `file://`, no localhost HTTP); **PKCE deep-link**; **sidecar codesign-verify + hash-pin before spawn** with a PID lockfile; `setWindowOpenHandler` denies all `window.open`; no secrets/dev endpoints in the bundle. A **documented Tauri reconsideration trigger** exists for a v2 shell behind the shell-agnostic renderer.

*Full reasoning, tradeoffs, and rejected alternatives per choice: `docs/01-stack-and-system-architecture.md` §6.*

---

# 7. System architecture & service topology

**Thin clients, fat brain.** Both shells render the same SPA; the desktop adds native supervision of the Rust sidecar. **No client holds the LLM key or any secret.** The backend trust zone (API/gateway/worker/engine) is the only place secrets are decrypted.

**Services (independently deployable):**
1. **Web App** (`apps/web`) — Next static-export SPA; REST (TanStack Query) + WS (`/chat`); cookie auth; no secrets.
2. **Desktop App** (`apps/desktop`) — Electron shell hosting the same renderer over `app://`; PKCE deep-link; window model (main/quickAsk/child/presenter); tray + hotkeys; **sidecar supervisor**; named typed IPC.
3. **Backend API** (`services/api`) — NestJS/Fastify front door: auth, tenancy, sessions, tasks, files/artifacts (presigned), connectors/MCP, billing/usage, settings (encrypted secrets), **risk-gate + approval**. Produces BullMQ jobs; reads/writes Postgres; decrypts secrets server-side only.
4. **Realtime Gateway** (`services/gateway`) — Socket.IO + Redis adapter; **`/chat`** (agent stream + stop/approve/takeover) and **`/device`** (sidecar control plane: `device_config` in, `device_status` out).
5. **Worker** (`services/worker`) — BullMQ consumers hosting the **Agent Engine**; long runs survive restarts (state in Postgres).
6. **Agent Engine** (`packages/agent-engine`) — plan→act→observe→replan over the typed tool catalog; context mgmt, prompt caching, summarization, memory retrieval, step budgets, kill switch, **risk classifier**; calls the LLM via `LlmProvider`.
7. **Tool Layer** (`packages/tool-abi` + executors) — each tool is a Zod-typed schema + risk tag + executor (sandbox or sidecar).
8. **Browser Automation** (in-sandbox) — Playwright/Chromium; navigate/read/fill/screenshot/download; headful + VNC for takeover; refuses CAPTCHA/2FA bypass.
9. **Sandbox Orchestrator** (`services/sandbox-orchestrator`) — container-per-session (Docker + gVisor); idle-reaping; resource limits; behind `SandboxProvider` (Firecracker upgrade path).
10. **Local Operator / Sidecar** (`apps/sidecar`, Rust) — reads/writes the user's real files, runs shell **only under per-action approval**; RO/RW scopes; OS jail; codesign+hash-pin; PID-lockfile lifecycle.
11. **PostgreSQL** — system of record + pgvector. 12. **Redis** — SIO adapter, BullMQ broker, rate limits, presence. 13. **Object Storage** — artifacts/uploads/traces behind `BlobStore`.

**End-to-end task flow (abridged):** renderer POSTs `createTask` → API persists Task (`PENDING`) + enqueues BullMQ job → renderer joins `/chat` room → worker starts the engine → engine builds a cache-friendly prompt and streams a **`plan`** → engine emits a **`cost_estimate`** (pauses if over threshold) → runs tools (cloud web-search/browser via orchestrator; **local file write via the sidecar under `device_config`**) → a write outside an approved scope classifies **`high`** and emits **`approval_request`** (run pauses) → on approve, the scoped op runs → engine **verifies** (re-reads the artifact) → emits **`final_output`**. Every event is appended to the Postgres **event log** (replayable) and **audit log** (risk levels + approval decisions). A client **`stop`** at any time sets a kill flag the engine checks between steps and that aborts in-flight tool/sidecar ops (epoch-guarded), marking the task `STOPPED`.

**Trust boundaries:** renderer (untrusted for secrets) → backend trust zone (only place secrets decrypt; enforces tenancy + RLS + risk-gate + audit) → sandbox (untrusted code under gVisor, egress-controlled) → sidecar (high-risk local; codesign/hash-pin, RO/RW scopes, OS jail, per-action approval, "disconnect = kill switch"). Data classes: **critical** (keys/tokens — envelope-encrypted, never logged), **sensitive** (files/prompts/tool I/O — minimized to model, redacted in logs), **operational** (events/metrics — first-party, no fingerprinting).

*Full diagram, communication matrix, wire-contract sketches, failure/backpressure/scaling: `docs/01-stack-and-system-architecture.md` §7.*

---

# 8–28. Module architecture summaries (with sub-doc links)

Each module below has a detailed sub-doc; the summary inlines the key decision, the rest is in the linked file. Phase tags conform to Appendix A.

### 8. Agent Engine & Execution Core — **MVP (Phase 2)** → `docs/arch/agent-engine.md`
The brain runs a precise **12-state agent loop** with invariants and a **9-state `TaskStatus` lifecycle** (`pending → planning → awaiting_approval → running → paused → verifying → completed | failed | stopped`) with a full allowed-transition table (`cancelled ≡ STOPPED`). Thirteen engine subcomponents are sketched in TS: understanding, planner, router, executor, verifier, recovery, risk classifier, permission/approval, context, memory, artifacts, cost, checkpoint/resume — over the `Task`/`Step`/`ToolCall`/`ToolDef` contracts.
It is the moat: every step is replanned on failure within step/cost budgets, every tool call is risk-classified before execution, and the whole run is checkpointed to the Postgres event log so a worker restart resumes deterministically. Wide/Parallel Research (map-reduce sub-agents) is sketched here but tagged Later.

### 9. Queue / Worker Topology — **MVP (Phase 2)** → `docs/arch/agent-engine.md` §8
BullMQ workers own long, multi-step, cancellable agent runs plus side jobs (artifact generation, deploy, scheduled triggers, Wide-Research fan-out). The **system of record is Postgres** — Redis/BullMQ is the execution coordinator, so a Redis loss degrades to "reschedule from Postgres state," not data loss. Concurrency control, retries-with-backoff, repeatable (cron) jobs, and parent/child flows are first-class; jobs are idempotent and resumable from the event log.

### 10. Tool Registry & Tool ABI — **MVP (Phase 2)** → `docs/arch/agent-engine.md` §7
Every tool is a Zod-typed `ToolDef<I,O>` carrying `name`, `input`/`output` schemas, a **risk tag**, a `surface` (`cloud`/`local`/`either`), and an `execute`. One source feeds both the **LLM JSON Schema** (via `zod-to-json-schema`) and runtime validation — eliminating drift between "what the model was told" and "what we accept." MVP tools: web search, code-exec, sandbox file read/write, RO local file read. The registry is the shared contract the client renders and the executor runs.

### 11. Cloud Browser & Automation — **MVP-light (Phase 2 headless), expands P4–5** → `docs/arch/cloud-browser.md`
A **browser-worker pool** runs one `BrowserContext` per session inside the gVisor sandbox, driven by a `BrowserSession` state machine, with encrypted cookie/storage-state save/delete and a fully Zod-typed action set (navigate/read/fill/click/screenshot/download/submit). The engine drives multi-step workflows. **Live-view transport decision:** CDP `Page.startScreencast` for the MVP **read-only** view (justified vs VNC); **takeover** and VNC are Later. Hard rule enforced in the tool layer: CAPTCHA/2FA pages are flagged and escalated to user takeover, never solved.

### 12. Live Activity Panel ("Cloud Browser UI") — **MVP (Phase 3)** → `docs/01...md` §7 + `docs/arch/cloud-browser.md` §7
The right-pane renderer of streamed `tool_call`/`tool_result`/terminal/file/browser events, with a per-action audit overlay and the read-only screencast for browser steps. It is a pure consumer of the `/chat` event stream (Zustand slices), so web and desktop render it identically.

### 13. Desktop App — **MVP (Phase 4)** → `docs/arch/desktop-and-local.md` §8
The Electron shell: window/process model, **hardened webPreferences**, a named/typed **Zod IPC allowlist** (no `invoke` passthrough), **PKCE deep-link login**, core flows, the **sidecar supervisor** (integrity gate, epoch guard, PID lockfile, kill switch), **instant STOP**, and a local **SQLite** store (`userData`) for device id, the localStorage shim, and the per-tool permission/audit ledger. The renderer is the same Next static export served over `app://` with a per-request CSP nonce.

### 14. Local Computer Operator (sidecar) — **MVP-lite RO (Phase 4) / full (Phase 5)** → `docs/arch/desktop-and-local.md` §9
The Rust sidecar reads/writes the user's real files under **RO/RW scopes** with path canonicalization (`realpath`) to defeat traversal, runs shell **only under per-action approval** (Phase 5), and streams a live "what it touched" audit. It is hash-pinned and codesign-verified by the shell before spawn, lives behind a PID lockfile, and treats **`/device` disconnect as a kill switch**. MVP ships read-only shared-folder access; RW + gated shell exec is Phase 5.

### 15. Local Browser Operator & Preferred Browser — **Later (Phase 5)** → `docs/arch/desktop-and-local.md` §10–11
Drive an *approved* local browser profile with explicit **per-domain consent** and **instant takeover** (user reclaims control immediately). No CAPTCHA/2FA bypass. Entirely Later; the contracts are sketched now so the MVP cloud-browser path and the permission model already account for it.

### 16. Permission / Approval Model (cross-cutting) — **MVP (Phase 2 gate; P3 web UI; P4 desktop)** → `docs/arch/desktop-and-local.md` §12 + `docs/arch/security-cost-testing.md` §3
A unified `Permission` (`capability`, `resourceScope`, `mode`, `maxRisk`, expiry, revocable) is the single grant primitive used by the risk-gate. Approvals can be **once / for-session / persistent / deny / stop**; `critical` requires extra-confirm (typed reason or re-auth) and can never be auto-approved by policy. Enforced server-side only (guard → RLS backstop → audit).

### 17. Local Operator Protocol — **MVP (Phase 4)** → `docs/arch/desktop-and-local.md` §13
The declarative `device_config` (desired) / `device_status` (actual) reconcile loop over `/device`: cloud emits desired folder scopes + session WS URLs; the desktop supervisor reconciles, ensures the sidecar is running for each folder, and reports actual state — debounced and epoch-guarded so a stale timer cannot resurrect a killed sidecar.

### 18. File System — **MVP (Phase 2 cloud; Phase 4 local RO)** → `docs/arch/files-and-media.md` §1
Typed `FileRecord`/`FileChunk` model with per-format handling, an ingestion pipeline (upload → parse → chunk → embed), a local-first RO folder scan (desktop), and deletion/retention policy. Chunking + embeddings feed memory retrieval while keeping private bytes minimized to the model.

### 19. Artifact System — **MVP-lite (Phase 2)** → `docs/arch/files-and-media.md` §2
Versioned `Artifact`/`ArtifactVersion` with a **mandatory first-class `Provenance`** record (which task/step/tool produced it), diff/rollback state machine, engine-side generators, and sharing/permissions. Content-addressed and audit-linked; presigned up/download.

### 20. Multimedia — **Later (Phase 9), media-store seams MVP** → `docs/arch/files-and-media.md` §3
Image/video/audio generation behind provider abstractions mirroring `LlmProvider`, with transcript & summary artifacts. Only the storage seams exist in MVP.

### 21. Design View — **Later (Phase 9)** → `docs/arch/files-and-media.md` §4
An original visual editor surface for deliverables (model + capabilities table). Fully Later.

### 22. Slides — **Later (Phase 9)** → `docs/arch/files-and-media.md` §5
An editable deck model as the source of truth + generation capabilities; multi-monitor **Presenter** ties to capability C21. Fully Later.

### 23. Data Analysis & Visualization — **Later (Phase 9), CSV/XLSX read MVP** → `docs/arch/files-and-media.md` §6
Notebook-style pipeline + a declarative, NL-editable, renderer-agnostic `ChartSpec`, with privacy/cost controls. MVP reads CSV/XLSX; the analysis depth is Later.

### 24. Data Provider Registry — **Later, MVP-lite freshness seam** → `docs/arch/files-and-media.md` §7
A registry of trusted external data providers with freshness/trust/safety controls. Only the freshness seam is MVP-lite.

### 25. Projects & Skills — **Projects-lite MVP (Phase 1) / depth Later (Phase 7)** → `docs/arch/platform-features.md` §17–18
**Projects** own shared files/memory/settings/budgets and inject context into every task via a deterministic, versioned, **pinned, audited, privacy-filtered, cost-estimated** `ProjectContextResolver` at intake. **Skills** = packaged, parameterized, versioned task graphs with mandatory **security scanning + risk analysis**, slash-command invocation, and progressive disclosure. Projects-lite (grouping + budgets) is MVP; rich projects + Skills are Phase 7.

### 26. Collaboration — **Later (Phase 7)** → `docs/arch/platform-features.md` §19
Real-time shared sessions (`CollaborationSession`), multi-user prompt queue, owner controls/roles/removal, sensitive-session warnings, and per-user cost attribution — added onto the `/chat` namespace. Fully Later.

### 27. Mail-to-Task & Meetings — **Later (Phase 8)** → `docs/arch/platform-features.md` §20–21
Inbound email/webhook → task with a **sender allowlist + approval-before-execute** (`MailTask`), plus a meeting module converting transcripts → action items/tasks. Both depend on the automation/trigger plumbing (Phase 6). Fully Later.

### 28. Integrations, MCP, Automations, Website Builder & Public API — **Later (Phases 6/9/10)** → `docs/arch/integrations.md`
**Integration Center/connectors = P10; MCP registry = P10; Public API = P10; Automations engine = P6** (ingestion triggers P8); **Website Builder generate = P9, deploy+sync+domains = P10.** Connectors broker scoped OAuth tokens server-side (no main-window navigation into third-party sites); MCP servers run sandboxed with per-server permission scopes; the Public API exposes scoped tokens, webhooks, OAuth apps, and rate limits. All Later, with the tool ABI/permission model battle-tested first.

---

# 29. Security / permission model

**Four risk levels**, exactly defined, assigned by a classifier on every tool call before execution:

| Level | Decision rule | Approval | Examples |
|---|---|---|---|
| **low** | Read-only / in-sandbox / fully reversible; no secret/PII; no external write | No (auto) | web search; read a public page; `ls`/`cat` in sandbox; token-count a prompt |
| **medium** | Mutates agent-created state or reads user-scoped private data, reversible, inside the trust boundary | No (auto, logged + masked) | write a file inside sandbox/approved RW folder; create an artifact; read an RO local folder; navigate to an allowlisted domain |
| **high** | Mutates resources outside an approved scope, sends data externally, writes to a 3rd-party API, or runs shell with side effects | **Yes** | write outside any approved scope; `email.send`; submit a web form; `api.write`; post to a connector; install a package |
| **critical** | Irreversible, destructive, mass-affecting, or security-sensitive | **Yes + extra-confirm** | `rm -rf`/drop table; bulk delete; send money/place order; rotate/expose a secret; mass email; `git push --force` to protected |

**Invariants (asserted in tests):** a tool's declared `risk` is a **floor**; the runtime classifier may **escalate, never silently de-escalate**; `critical` can never be auto-approved by policy; destructive ops are `critical` by default.

**Risk classifier pipeline** (in `packages/agent-engine`, pre-execution hook, first-match-wins, escalation-only): **(1)** hard blocklist (dangerous terminal commands, CAPTCHA/2FA bypass) → blocked, never executes, audited as `security`; **(2)** scope check (out-of-scope write/delete ≥ `high`); **(3)** action-class map (verb → base level); **(4)** argument heuristics (recursion/force flags, bulk counts, money keywords, recipient thresholds → escalate to `critical`); **(5)** floor merge `max(declaredFloor, pipelineLevel)`; **(6)** workspace policy may *raise* but never lower `critical`.

**Approval state machine:** `PROPOSED → PENDING_APPROVAL → {APPROVED → EXECUTED → VERIFIED | DENIED | EXPIRED | STOPPED}`. Unanswered approvals **auto-deny at `expiresAt`** (default 15 min) and fail into recovery; decisions are idempotent by `approvalId`; the user can **stop at any state**. The streamed `tool_call` carries the `risk` badge; on `requiresApproval` the engine emits `approval_request` and the run loop **blocks** (no tool executes) until a decision arrives over `/chat` or REST.

**Backend-only enforcement (defense in depth):** authn guard on every request + socket handshake (token in `auth`, never query string) → tenancy guard (`workspaceId` from the *authenticated* principal, not the body) → **Postgres RLS** backstop → capability check (active, unrevoked, unexpired `Permission` with `maxRisk ≥ verdict.risk`; approvers are themselves capability-checked) → **secret broker** (decrypt only in-process; no endpoint returns plaintext; only `last_four`) → audit row on every privileged mutation.

**Encryption:** **envelope encryption** — a KMS master key wraps per-row AES-256-GCM data keys; dev uses a local master key, prod uses cloud KMS. Secrets decrypt only inside the backend trust zone, are never logged, and are masked in all surfaces. **Other controls:** centralized masking layer (UI/logs/prompts/replays), path-traversal/unauthorized-read prevention (canonicalized paths + RO scopes), a terminal blocklist, gated action classes, browser-session deletion, and **PKCE** to close the plaintext-token deep-link risk. The hard rule "**no CAPTCHA/2FA bypass**" is enforced in code: the agent pauses and hands off.

*Full model: `docs/arch/security-cost-testing.md` §3.*

---

# 30. Cost / resource model

**Metering.** The `LlmProvider` records token usage per call; the engine meters tokens → USD (`numeric(14,6)`) into Postgres per **task / workspace / user / month** (`CostScope` enum). Numbers must reconcile with provider usage in a fixture test.

**Pre-flight estimate.** Before a multi-step or flagged-expensive run, the engine emits a `cost_estimate { estUsd, estTokens, overThreshold }`; if it exceeds the workspace threshold, it emits an `approval_request` and **pauses** before spending.

**Spend control.** Hard **budget caps** per task/workspace/month (a `budget_exceeded` error gates further runs); **prompt caching**, **summarization**, **file chunking**, **memory retrieval**, and cache-aware message construction minimize tokens; planned **model tiering** (cheaper planner / strong executor) is a later lever. Context management also serves privacy: only what the model needs is sent.

**Compute/resource control.** Container-per-session with **idle-reaping**, resource limits, and density tuning; **local-first** RO files offload cloud work entirely; microVMs only when multi-tenant density demands it (behind `SandboxProvider`). Realtime backpressure coalesces high-frequency partials before Postgres bulk-write.

*Full model (budgets, estimator, reaping, thresholds): `docs/arch/security-cost-testing.md` §4.*

---

# 31. Testing strategy

**Hard rule:** no module is "done" without passing tests; CI's Turborepo `test` task **gates merges** (build → test → lint → e2e).

- **Unit + integration:** **Vitest** across all TS packages/services (coverage via `v8`).
- **API/data integration:** **Testcontainers** spins ephemeral **Postgres + Redis + MinIO** so the data layer, queue, and blob store are tested against real engines, not mocks. DB migrations must **apply-and-rollback cleanly** (Phase 1 acceptance).
- **E2E:** **Playwright Test** drives both the **web** app and the **Electron** app (`_electron` API), so "give a task → watch the Computer panel → get a result" is verified on both surfaces; desktop E2E stays focused on shell-specific behavior (deep-link, IPC allowlist, sidecar spawn, window model).
- **Contract tests** on `packages/protocol` + `packages/tool-abi` guarantee client/server/sidecar stay wire-compatible, and assert **tool-ABI ↔ JSON-Schema parity** (no drift between what the model sees and what we validate). These are the highest-value tests in a streaming, tool-calling system.
- **Rust sidecar:** `cargo test` for path-traversal refusal, approval-gating, reconnect/reconcile, integrity-gate.
- **Security/chaos:** CSP/CORS posture checks, IPC-allowlist tests, sidecar tamper/refusal, kill-switch/chaos drills (stopping mid-tool leaves no orphaned sandbox or sidecar), secret-in-bundle CI scan, log-redaction tests, cost-regression and load tests (Phase 11 sweep).

*Full strategy + per-module scenarios: `docs/arch/security-cost-testing.md` §6 and each sub-doc's test section; cross-feature matrix in `docs/FEATURE_MATRIX.md`.*

---

# 32. Database schema

**Engine:** PostgreSQL 16 (single primary, system of record) via **Prisma** + raw-SQL/Kysely escape hatch. **pgvector(1536)** HNSW columns on `file_chunks` + `vector_documents`. **Secrets** (`secrets`, `api_keys`) carry envelope-encrypted ciphertext only. **RLS** enabled as a tenancy backstop; append-only logs (`task_logs`, `audit_logs`, `usage_records`, `cost_records`, event rows) are **monthly range-partitioned** for cheap retention/replay.

**Scale:** **38 tables** (+ the `approvals` supporting table) covering users/workspaces/projects/tasks/steps/events, tool registry mirror, artifacts/files/chunks, audit/usage/cost, secrets/api-keys, sessions/permissions/approvals, sandboxes, browser/preferred-browser sessions, automations/triggers, integrations/MCP, skills, collaboration, mail-tasks, notifications, memory/vectors. Native enums include `RiskLevel`, `TaskStatus` (9 states), `StepStatus`, `ApprovalStatus`, `MemberRole`, `SecretType`, `SandboxStatus`, `SessionMode`, `CostScope`. Every tenant-owned row carries `workspace_id`; money is `numeric(14,6)` USD; tokens are `bigint`; flexible payloads are `jsonb` (GIN-indexed where queried).

**Migrations:** `prisma migrate` for schema/relations + committed **raw-SQL** for the pgvector extension/HNSW indexes, native enums, RLS policies, and partition setup; every migration ships `up` + `down`, and CI asserts apply-then-rollback is clean.

*Full schema (all tables, fields, keys, relationships, indexes): `docs/DATABASE.md`.*

---

# 33. API draft

**Surfaces:** NestJS-on-Fastify REST under **`/api/v1`** + Socket.IO **`/chat`** and **`/device`** namespaces. Every body/param/event is **Zod-validated**. **Auth:** web = HTTP-only Secure SameSite cookie (CSRF on mutations); desktop = **PKCE** deep-link → token exchange over HTTPS; sockets/sidecar = short-lived token in the Socket.IO `auth` handshake (never the query string); public API = hashed API key. **Risk model per endpoint:** state-changing actions carry a `RiskLevel`; `high`/`critical` require approval; uniform error envelope includes `approval_required` and `budget_exceeded` codes; secrets are never returned (only `last_four`).

**Endpoint groups:** 1. Auth (incl. PKCE authorize/token/revoke) · 2. Workspaces · 3. Projects · 4. Tasks · 5. Tools · 6. Files · 7. Artifacts · 8. Automations · 9. Integrations · 10. MCP · 11. Skills · 12. Collaboration · 13. Admin/Settings · 14. Memory/Data · 15. Public API · 16. Webhooks · 17. WebSocket (`/chat`: `plan`/`message`/`tool_call`/`tool_result`/`approval_request`/`cost_estimate`/`status`/`final_output` server→client; `subscribe`/`stop`/`approve`/`deny`/`takeover` client→server; `/device`: `device_config`/`device_status`) · 18. Public-API auth + rate-limit design. Large blobs always move via **presigned URLs**, never streamed through the API.

*Full endpoint tables with request/response sketches, risk/scope tags, and acceptance notes: `docs/API.md`.*

---

# 34. Folder structure (+ rename strategy)

```
agentos/                         # repo root (folder name cosmetic)
├─ apps/
│  ├─ web/                       # Next.js static-export SPA (web surface)
│  ├─ desktop/                   # Electron shell (hosts the SAME renderer over app://)
│  └─ sidecar/                   # Rust local operator binary (per shared folder)
├─ services/
│  ├─ api/                       # NestJS/Fastify REST front door
│  ├─ gateway/                   # Socket.IO gateway (/chat + /device, Redis adapter)
│  ├─ worker/                    # BullMQ consumers; hosts the agent engine
│  └─ sandbox-orchestrator/      # container-per-session sandboxes
├─ packages/
│  ├─ brand/                     # ⭐ single source of product name/identity (rename here)
│  ├─ config/  protocol/  tool-abi/   # Zod env + wire/tool contracts (single source of truth)
│  ├─ agent-engine/  llm/        # loop + risk classifier + context mgmt; LlmProvider (Anthropic)
│  ├─ db/  blob-store/  memory/  queue/   # Prisma; S3/R2/MinIO+local FS; pgvector; BullMQ
│  ├─ ui/  desktop-ipc/          # owned shadcn/Radix components; Zod IPC contract
│  ├─ auth/  crypto/  logger/    # PKCE/session; envelope encryption; redaction
│  └─ test-utils/                # Testcontainers helpers, fixtures, contract-test harness
├─ infra/                        # compose.yaml (full local stack), docker/, migrations/
├─ tooling/                      # eslint/tsconfig/prettier configs; rename + codegen scripts
├─ docs/                         # planning + architecture docs (this file)
├─ turbo.json · pnpm-workspace.yaml · package.json
```

**Rename strategy (one-file edit + one script):** `packages/brand` is the only place the name is authored (`appName`, `appId`, `protocol`, `assetScheme`, `storageDomain`, `supportEmail`, `copyright`). An **ESLint `no-restricted-syntax` rule bans the literal `"AgentOS"`** (and scheme/appId literals) anywhere else — CI fails if one sneaks in. Non-TS surfaces (`package.json`, electron-builder config, manifest/MSIX metadata, i18n defaults, compose prefixes) are generated by a **`pnpm brand:apply`** codegen step from a single `brand.config.json`. Procedure: edit `brand`, run `brand:apply`, run `build` + `test` (the lint guard + contract tests confirm nothing hardcoded the old name).

*Full layout + per-package responsibilities: `docs/01-stack-and-system-architecture.md` §34.*

---

# 35. Development phases

Ordering follows the required implementation order (monorepo → backend → db → auth/workspace/project → task engine → LLM → tool registry → file/artifact → queue/worker → browser → frontend → cloud-browser UI → automation → desktop → local operators → preferred browser → admin → projects/skills → collaboration → mail-to-task → meeting → multimedia → design → slides → data analysis → MCP → website builder → public API → tests → packaging → docs), batched into shippable, testable increments. **Tests are continuous** (every module ships green) plus a dedicated hardening sweep. **14 phases (0–13); MVP completes at the end of Phase 4.**

| Phase | Theme | What lands |
|---|---|---|
| **0 — Foundations & Contracts** (`scaffold`) | One repo, one protocol, two shells, green CI | Monorepo; shared typed event & tool ABI; brand config; backend skeleton; CI gates |
| **1 — Backend, Data & Identity** (`backbone`) | Durable state + who-can-do-what | API; DB + migrations; auth (web session + desktop PKCE); workspaces/projects scoping; RBAC primitives; secrets vault; audit substrate |
| **2 — Agent Brain & Execution Spine** (`brain`) | The core loop, end to end, on cloud tools | Task Engine; LLM provider; Tool Registry; File/Artifact store; Queue+Worker; Session Sandbox; cloud headless browser |
| **3 — Web Workspace & Live Panel** (`surface`) | A human can drive and watch the agent on web | Frontend workspace; Live Activity Panel; approval UI; stop control; cost readout; replay; masking; telemetry + Sentry; flags |
| **4 — Desktop App & Local Operator** (`desktop`) | Native Windows shell + auditable local file access | Electron desktop (PKCE, hardened); Local Operator MVP-lite (RO folder, audit, approval scaffold); desktop↔backend parity. **★ MVP gate** |
| **5 — Full Local Power & Preferred Browser** (`local-power`) | Beyond read-only — the differentiator | RW + gated shell exec (per-command allow/deny, OS jail, hash-pin enforced); preferred-browser operator + takeover |
| **6 — Automations & Triggers** (`automate`) | Tasks that start themselves | Cron + event triggers; dry-run preview; per-automation approval policy |
| **7 — Admin, Projects/Skills & Collaboration** (`org`) | Multi-user, reusable, governed | Admin/RBAC + audit export; rich Projects + Skills + Knowledge/Memory RAG; collaboration |
| **8 — Ingestion: Mail-to-Task & Meetings** (`ingest`) | The world creates tasks | Mail-to-task (allowlist + approval); meeting transcript → tasks |
| **9 — Creation Suite** (`create`) | Make anything | Multimedia; design view; slides + Presenter; data analysis; website builder (generate) |
| **10 — Extensibility & Public Platform** (`open`) | Open the tool layer and the API | MCP layer; Public API (REST+webhooks+OAuth apps, rate limits); Wide/Parallel Research; billing/quota/tiers; website deploy+domains |
| **11 — Hardening & Test Sweep** (`harden`) | Prove it | E2E/integration/security suites; load + cost-regression; chaos/kill-switch drills; pen pass on sidecar/IPC/CORS/CSP; a11y + i18n |
| **12 — Packaging & Distribution** (`ship`) | Signed, updating, installable | electron-builder NSIS (auto-update) + MSIX (Store); signed + hash-pinned sidecar; crash reporting; macOS/Linux parity begins |
| **13 — Documentation** (`docs`) | Usable & buildable by others | User + developer/tool-ABI + API + security/runbook docs |

*Full module lists + ordering rationale per phase: `docs/00-scope-and-phases.md` §6.*

---

# 36. Per-phase acceptance criteria

Every phase inherits the **global gate:** all shipped modules have passing unit + integration tests; no placeholders/TODOs in core paths; no secrets in the frontend bundle (CI-scanned). Phase-specific highlights:

- **Phase 0:** `pnpm install && pnpm build` builds web + desktop from a clean checkout in CI; shared protocol exports versioned ABI types (consumers fail to compile on drift); **renaming requires editing only `brand.config.ts`** (asserted); CI lint + typecheck + tests block red.
- **Phase 1:** migrations apply and roll back cleanly; web session + desktop **PKCE** complete a login (token never in a renderer-readable URL — asserted); workspace/project scoping enforced (cross-workspace read denied); API key stored **encrypted at rest** (server-only decrypt; zero secrets in bundle scan); every privileged mutation writes an audit row.
- **Phase 2:** a NL task produces an inspectable **plan + decomposition** before execution; the ReAct loop executes ≥3 chained tool calls in a sandbox and returns a **verified** result; **instant stop** halts within a bounded time (≤2s) and marks the task stopped; token + cost metered per task/workspace and reconcile with provider usage; **pre-flight estimate** for an expensive task; replanning triggers on a forced tool failure; a `high` tool is **blocked pending approval**.
- **Phase 3:** end-to-end on web (submit → plan → Live Activity → artifact); **approval prompt** blocks a high-risk step until decided; **stop button** cancels and UI reflects stopped; **replay** reproduces the event stream deterministically; seeded secrets are **masked** in UI and replay; telemetry flows to the single pipeline and Sentry captures a forced error.
- **Phase 4 (MVP gate):** Windows app launches, logs in via PKCE, renders the same workspace as web; renderer is sandboxed and **only named typed IPC exists** (no raw `invoke` — asserted); sidecar binary is **signature/hash-verified before spawn** (unverified refused); agent reads a **read-only** folder (a write is denied + audited); "what it touched" log lists every access; killing the app terminates the sidecar (no orphans); **full loop (plan→tools→approval→recover→verify→deliver, with audit/cost/stop) passes on both web and desktop.**
- **Phases 5–13 (summary):** RW + gated shell with `critical` approval on `rm -rf`, OS-jail escape fails, takeover returns control instantly, CAPTCHA/2FA → pause+handoff (P5); cron fires + dry-run preview + instant disable (P6); RBAC + tamper-evident audit export + a Skill re-runs with new params + privacy-respecting memory + shared-workspace roles (P7); allowlisted email → task / non-allowlisted rejected + transcript → tasks (P8); each generator yields a valid openable artifact + Presenter spans monitors + site deploys then publishes with CNAME (P9); MCP server installs and runs sandboxed with risk tags + OAuth app creates a task via REST and gets a webhook + rate limits + Wide Research fans out within budgets + billing meters to Stripe (P10); green E2E across web+desktop + verified CSP/CORS/IPC/sidecar-signing + kill-switch leaves no orphans + cost/load within thresholds (P11); signed NSIS auto-updates + MSIX installs + hash-pinned sidecar tamper-blocks + macOS/Linux artifacts (P12); user/dev/API/security docs accurate and a new dev can build both surfaces from docs alone (P13).

*Full checklists: `docs/00-scope-and-phases.md` §7.*

---

# 37. Risks & solutions

| Category | Risk | Mitigation |
|---|---|---|
| **Technical** | Agent loops/stalls/destructive actions | Hard step + cost budgets, watchdog timeouts, replanning caps, **global kill switch**, risk-gated approval for high/critical (from Phase 2); destructive ops are `critical` by default |
| | Sandbox cost/scale dominates spend | Container-per-session (gVisor), **idle reaping**, density tuning; **local-first** RO files offload cloud; microVMs only when density demands |
| | Sidecar is the highest-risk component | Codesign + hash-pin before spawn; OS jail; **read-only default**; `realpath`-canonicalized scoped folder; **PID-lockfile** lifecycle; per-action approval + live audit |
| | Realtime fragility / reconnection storms | Staged backoff curve + **epoch-guarded serialized op queue**; token in `auth` handshake; base-URL diffing so a token-only change doesn't restart healthy sessions |
| | Provider/model drift | `LlmProvider` isolates `claude-opus-4-8`; contract tests pin request/response shape; model id from one constant |
| **Security** | Secrets leaking to frontend | Keys **encrypted at rest**, server-only decrypt; **CI bundle scan** fails on any secret/dev-endpoint; server-driven flags |
| | Renderer/IPC over-exposure | **Sandboxed renderer**, **named typed IPC only**, **scoped CORS**, **full CSP** + per-request nonce |
| | Plaintext-token interception | **PKCE** one-time code over HTTPS; nonce/state CSRF guard |
| | Sensitive data in logs/prompts/replays | Centralized **masking** layer across UI/logs/prompts/shared replays; tests seed secrets and assert redaction |
| **Cost** | Token spend on multi-step runs | Prompt caching, summarization, file chunking, memory retrieval, model tiering, **pre-flight estimates**, hard **budget caps** |
| | Telemetry vendor sprawl | **One first-party pipeline + Sentry (errors only)**; no fingerprinting at v1 |
| **Scope-creep** | "Just one more generator/connector" delays MVP | **MVP cut frozen**; extras tagged Later; MVP ends at Phase 4 as a hard gate before Phase 5+ |
| | Gold-plating the desktop | Quick Launcher / Presenter / tray-hotkeys deferred; desktop MVP = shell + PKCE + RO sidecar |
| **Legal / ToS** | CAPTCHA/2FA bypass / ToS violation | **Hard rule in code:** on CAPTCHA/2FA the agent **pauses and hands off**; no bypass tooling ships; per-domain consent for preferred browser |
| | Spam/abuse via automations/mail-to-task | Sender **allowlists**, rate limits, approval-before-execute, dry-run preview |
| | Branding/IP originality | No copied Manus branding/UI/copy/names/design/code; original design system; teardown used only for capability mapping |

*Full risk register: `docs/00-scope-and-phases.md` §8.*

---

# 38. First coding step after approval (Phase 0)

**Goal of step one:** a clean monorepo that **builds web + desktop**, exposes the **shared protocol/brand contracts**, and runs **green CI** — the substrate every later phase consumes. **No agent logic yet.**

**First commands (sketch):**
```bash
mkdir agentos && cd agentos && git init
corepack enable && corepack prepare pnpm@latest --activate && pnpm init
printf 'packages:\n  - "apps/*"\n  - "packages/*"\n' > pnpm-workspace.yaml
pnpm add -Dw typescript @types/node tsup eslint prettier vitest turbo
mkdir -p packages/brand packages/protocol packages/config apps/web apps/desktop services/api
pnpm -w exec vitest run      # protocol/brand contract tests must pass
pnpm -w build                # builds web + desktop + api skeletons
```

**First files (Phase 0 deliverables):** `pnpm-workspace.yaml`, root `package.json` (build/test/lint/typecheck), `tsconfig.base.json`, `turbo.json`, `.github/workflows/ci.yml`; `packages/brand/{brand.config.ts, brand.test.ts}` (renameability gate); `packages/protocol/src/{events.ts, tools.ts, risk.ts, index.ts}` + `protocol.test.ts` (drift tests); `packages/config/src/env.ts`; `apps/web` (Next static-export "hello"); `apps/desktop` (Electron skeleton: `app://` + CSP nonce, single-instance, sandboxed renderer, named typed IPC stub); `services/api` (health route + protocol import).

**Definition of done for step one:** `pnpm -w build` builds web + desktop + api; `pnpm -w exec vitest run` is green incl. the **renameability** and **protocol-drift** tests; CI runs install → typecheck → lint → test → build and **blocks on red**; **no secrets in the client bundle** (CI scan stub); the two surfaces render a static UI from the shared packages — proving "one UI, two shells" before any agent code exists.

*Full first-step spec: `docs/00-scope-and-phases.md` §9.*

---

## Awaiting your approval — reply **`start`** to begin Phase 0.
