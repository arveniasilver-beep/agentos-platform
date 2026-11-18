# AgentOS — Stack & System Architecture

> **Status:** Planning only. No code in this document — TypeScript appears solely as interface *sketches* to pin contracts.
> **Scope of this doc:** Sections **6 (Technology Stack + Reasoning)**, **7 (System Architecture / Service Topology)**, and **34 (Folder/File Structure + Rename Strategy)** of the AgentOS planning set.
> **Companion docs:** `_research/MANUS_TEARDOWN.md` (client teardown), `_research/BUILD_BLUEPRINT.md` (product blueprint). This document refines and commits the stack decisions sketched in the blueprint into buildable form.
> **Product name handling:** "AgentOS" is a placeholder. The brand string lives in exactly one place (`packages/brand`) and propagates everywhere via a constant + build-time substitution. See §34.6. Treat every literal "AgentOS" below as `BRAND.appName`.

---

## Table of Contents

- [6. Recommended Technology Stack (Decision + Why + Tradeoffs)](#6-recommended-technology-stack)
  - [6.0 Decision principles](#60-decision-principles)
  - [6.1 Monorepo & build orchestration](#61-monorepo--build-orchestration)
  - [6.2 Language](#62-language)
  - [6.3 Frontend framework](#63-frontend-framework)
  - [6.4 UI / design system](#64-ui--design-system)
  - [6.5 Client state management](#65-client-state-management)
  - [6.6 Backend API framework](#66-backend-api-framework)
  - [6.7 Database](#67-database)
  - [6.8 ORM / data-access](#68-orm--data-access)
  - [6.9 Vector search](#69-vector-search)
  - [6.10 Queue / background jobs](#610-queue--background-jobs)
  - [6.11 Realtime transport](#611-realtime-transport)
  - [6.12 Browser automation](#612-browser-automation)
  - [6.13 Desktop shell — Electron vs Tauri (THE verdict)](#613-desktop-shell--electron-vs-tauri)
  - [6.14 Local operator sidecar language](#614-local-operator-sidecar-language)
  - [6.15 Sandbox isolation](#615-sandbox-isolation)
  - [6.16 File / object storage](#616-file--object-storage)
  - [6.17 Validation & shared contracts](#617-validation--shared-contracts)
  - [6.18 Auth approach](#618-auth-approach)
  - [6.19 LLM provider abstraction](#619-llm-provider-abstraction)
  - [6.20 Secret management & encryption](#620-secret-management--encryption)
  - [6.21 Testing stack](#621-testing-stack)
  - [6.22 Containerization & local dev](#622-containerization--local-dev)
  - [6.23 Observability](#623-observability)
  - [6.24 Stack summary table](#624-stack-summary-table)
- [7. System Architecture & Service Topology](#7-system-architecture--service-topology)
  - [7.1 Service inventory](#71-service-inventory)
  - [7.2 Architecture diagram](#72-architecture-diagram)
  - [7.3 Communication matrix](#73-communication-matrix)
  - [7.4 End-to-end task data flow](#74-end-to-end-task-data-flow)
  - [7.5 Local-first vs cloud-first execution paths](#75-local-first-vs-cloud-first-execution-paths)
  - [7.6 Wire contracts](#76-wire-contracts)
  - [7.7 Trust boundaries & data classification](#77-trust-boundaries--data-classification)
  - [7.8 Failure, backpressure & scaling](#78-failure-backpressure--scaling)
- [34. Folder / File Structure & Rename Strategy](#34-folderfile-structure--rename-strategy)
  - [34.1 Monorepo layout](#341-monorepo-layout)
  - [34.2 apps/*](#342-apps)
  - [34.3 services/*](#343-services)
  - [34.4 packages/*](#344-packages)
  - [34.5 infra, tooling, root](#345-infra-tooling-root)
  - [34.6 Centralized rename strategy](#346-centralized-rename-strategy)
- [Test scenarios & acceptance criteria (this doc's scope)](#test-scenarios--acceptance-criteria)
- [6-line stack summary + Electron-vs-Tauri verdict](#6-line-summary)

---

# 6. Recommended Technology Stack

## 6.0 Decision principles

Every decision below is filtered through five constraints derived from the brief and the teardown:

1. **The brain is the product (~90% server-side).** Optimize the stack for a robust, observable, horizontally-scalable agent runtime — not for client cleverness. The client is a thin renderer + local bridge.
2. **Security-first, secrets never in frontend.** The API key for the LLM, sidecar tokens, and OAuth secrets must be encrypted at rest and physically unable to reach the renderer bundle. This rules out any "bake config into static blob" pattern (a named Manus weakness).
3. **One UI, two shells.** The same Next.js app renders on the web and inside the desktop shell. We pay a small "static-export friendliness" tax to avoid maintaining two frontends.
4. **Typed contracts end-to-end.** A single source of truth for the client↔server wire protocol and the tool ABI, shared as a package, validated at every boundary with Zod.
5. **Local-first is a first-class path, not a bolt-on.** The desktop sidecar must be able to execute file/shell tools against the user's real disk under per-action approval, with the cloud as supervisor — never strictly in the tool-call data path for local work.

Each subsection states **DECISION**, **WHY**, **TRADEOFFS**, and where useful **REJECTED ALTERNATIVES** and **MVP phase tag** (MVP = Phases 0–3 per the blueprint; Later = Phases 4–6).

---

## 6.1 Monorepo & build orchestration

**DECISION: pnpm workspaces + Turborepo.** Tag: **MVP (Phase 0).**

**WHY**
- We ship multiple deployables (web, desktop, API, worker, agent engine, realtime gateway) and many shared packages (protocol, tool ABI, UI, brand, config). A monorepo lets the wire contracts (`packages/protocol`) and the tool ABI (`packages/tool-abi`) be a single compiled source of truth imported by both client and server — exactly the "define contracts up front" mandate from the blueprint.
- **pnpm** uses a content-addressed store + symlinked `node_modules`, giving correct, non-flattened dependency resolution (critical when Electron, Playwright, and NestJS each pin native/peer deps) and the fastest cold installs of the three managers. Its strict isolation catches phantom-dependency bugs before they reach CI.
- **Turborepo** gives content-hash task caching + a task dependency graph (`build` depends on upstream `build`, `test` on `build`, etc.) with remote cache sharing in CI. It is config-light (a single `turbo.json`) and does not impose a bundler, so each app keeps its native toolchain (Next for web, electron-builder/Tauri for desktop, `tsc`/SWC for services).

**TRADEOFFS**
- Turborepo only orchestrates and caches; it is not a bundler — we still own each app's build config. Acceptable: we *want* native per-app builds.
- pnpm's symlinked layout occasionally trips tools that assume a flat `node_modules` (some Electron packagers, some Playwright postinstall steps). Mitigation: `node-linker=hoisted` *only* for the desktop app workspace if a packager misbehaves; documented escape hatch, not the default.

**REJECTED ALTERNATIVES**
- **Nx:** more powerful generators/plugins but heavier mental model and more opinionated project graph; we don't need its code-gen breadth and prefer Turborepo's smaller surface.
- **Bun workspaces / npm workspaces:** Bun's ecosystem maturity for Electron/Playmaker native modules is still risky for a production desktop app; npm workspaces lack first-class task caching.
- **Lerna:** legacy; superseded by the above.

---

## 6.2 Language

**DECISION: TypeScript everywhere in JS land (strict mode), Rust for the sidecar (see §6.14).** Tag: **MVP (Phase 0).**

**WHY**
- One language across web, desktop renderer, API, worker, and agent engine means the `packages/protocol` and `packages/tool-abi` types are *literally the same types* on both sides of every wire — no codegen drift between a Go server and a TS client. This is the single biggest lever for reliability in a streaming, tool-calling system.
- `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` catches the entire class of "undefined tool result" / "missing event field" bugs that plague agent loops.
- Compilation: **SWC** (via Next, and via `@swc/core` for services) for dev speed; **`tsc --noEmit`** in CI as the type gate (SWC transpiles but does not type-check).

**TRADEOFFS**
- TypeScript's runtime is still JS — CPU-bound work (embedding math, large file diffing) is slower than native. Mitigation: heavy compute (embeddings, sandbox supervision, file ops) is offloaded to Postgres/pgvector, the sandbox, or the Rust sidecar; the Node services stay I/O-bound (orchestration, streaming).

---

## 6.3 Frontend framework

**DECISION: Next.js (App Router) in `output: 'export'` (static) mode, React 19.** Tag: **MVP (Phase 0).**

**WHY**
- "One UI, two shells" requires a build that runs identically in a browser and inside the desktop shell. A **static export** (`output: 'export'`) produces a pure client-rendered SPA bundle with **no Node runtime at load**, which is precisely how the desktop serves the renderer over a privileged `app://` protocol (no localhost HTTP server, no SSR process to manage, no `file://` traversal). The teardown confirms Manus does exactly this and it is the right call.
- App Router gives file-system routing, layouts, React Server Components *at build time*, streaming-friendly Suspense boundaries (used heavily by the two-pane "Computer panel" rendering streamed tool events), and React 19 features (`use`, Actions, `useOptimistic`) that simplify socket-driven optimistic UI.
- Choosing Next over plain React/Vite buys us the routing, code-splitting, image/asset pipeline, and a well-trodden static-export path *without* committing to a custom router or SSR server we don't want.

**TRADEOFFS**
- Static export forbids Next server features (SSR, route handlers, middleware, ISR). That is a *feature* for us: all dynamic behavior belongs to the backend API, not the frontend. The web deployment is a CDN-served static bundle + the separate backend — clean separation, no Next server to scale.
- Some App Router conveniences assume a server. We consciously avoid them; the lint config bans `next/headers`, route handlers, and server actions to keep web and desktop bundles identical.

**REJECTED ALTERNATIVES**
- **Plain React + Vite:** lighter, but we'd reimplement routing, code-splitting conventions, and the static-build ergonomics Next gives free; and we'd diverge from the proven Manus shape.
- **Next.js with a running Node server (SSR):** can't run inside the desktop shell without bundling a Node server into Electron/Tauri — exactly the complexity we avoid. Also doubles the attack surface.
- **Remix / TanStack Start:** server-centric; same SSR-in-desktop problem.

---

## 6.4 UI / design system

**DECISION: Tailwind CSS + shadcn/ui (Radix UI primitives), CSS-variable design tokens.** Tag: **MVP (Phase 0).**

**WHY**
- **shadcn/ui** is copy-in, not a dependency: we *own* the component source in `packages/ui`, so we can harden, theme, and rename freely with no upstream lock-in — essential for an "original, fully-owned design system" (the brief forbids copied UI). It's built on **Radix** primitives (accessible, unstyled, keyboard-correct) and styled with **Tailwind**.
- A **CSS-variable token system** (HSL custom properties for color, spacing, radius) gives runtime theming (light/dark/high-contrast) broadcast across desktop windows — the same token approach Manus used, but on a leaner stack than Ant Design.
- Smaller bundle and sharper control than a heavyweight component kit; tree-shakeable; no theme-engine runtime.

**TRADEOFFS**
- shadcn/ui is "bring your own components" — we maintain the component code (updates are manual re-copies). Acceptable and intended: ownership is the point. We pin a `packages/ui/CHANGELOG` and a sync script noting upstream revisions.
- Tailwind's utility classes can bloat markup; mitigated with component extraction in `packages/ui` and `cva` (class-variance-authority) for variant APIs.

**REJECTED ALTERNATIVES**
- **Ant Design / MUI:** heavy, opinionated, harder to make look original; larger bundle (Manus's antd weight is a called-out weakness).
- **Chakra / Mantine:** runtime CSS-in-JS cost; less control than owning the source.

---

## 6.5 Client state management

**DECISION: Zustand (local/UI + socket stream state) + TanStack Query (server cache).** Tag: **MVP (Phase 0).**

**WHY**
- Agent UIs are **socket-driven append-only streams** (plan steps, `tool_call`/`tool_result`/`message` events). **Zustand** is ideal: a tiny, unopinionated store where the socket layer pushes events into normalized slices with minimal boilerplate and no action/reducer ceremony. Selectors keep the high-frequency "Computer panel" re-renders surgical.
- **TanStack Query** owns everything request/response: session lists, file listings, billing, connectors — with caching, dedup, background refetch, optimistic mutations, and retry. It is the right tool for REST-shaped server state; Zustand is the wrong tool for it.
- Clean division: **Query = server truth fetched over REST; Zustand = ephemeral + streamed state over WebSocket.** No overlap, no Redux boilerplate.

**TRADEOFFS**
- Two libraries instead of one "do-everything" store. Acceptable — each is small and they have non-overlapping jobs; the boundary (REST→Query, WS→Zustand) is a simple, teachable rule.

**REJECTED ALTERNATIVES**
- **Redux Toolkit (what Manus uses):** more boilerplate; RTK Query is fine but heavier than TanStack Query for our shape; the streaming slices are cleaner in Zustand. A deliberate place to beat the incumbent.

---

## 6.6 Backend API framework

**DECISION: NestJS (on the Fastify adapter) for the API + realtime gateway + worker host.** Tag: **MVP (Phase 1).**

**WHY**
- The backend is large and long-lived: auth, sessions, tools, billing, connectors, the agent engine, the realtime gateway, queue producers/consumers. **NestJS** brings **dependency injection, modules, guards, interceptors, and a first-class WebSocket gateway + queue (BullMQ) integration** — exactly the structure that keeps a sprawling agent platform maintainable, with consistent cross-cutting concerns (auth guard, risk-gate interceptor, audit interceptor, tenancy scoping) applied uniformly.
- Nest's **`@nestjs/websockets` gateway** maps directly onto our Socket.IO needs (namespaces for `chat`/`device`, typed events), and **`@nestjs/bullmq`** wires the queue without glue.
- Running Nest on the **Fastify adapter** (not Express) gives us Fastify's throughput and schema-based serialization while keeping Nest's structure — best of both.

**TRADEOFFS**
- More structure/ceremony than raw Fastify (decorators, modules, providers). For a platform of this size that's a net win; for a tiny service it would be overkill — but we don't have tiny services.
- DI + decorators add a slight cold-start and learning cost. Acceptable for long-running server processes.

**REJECTED ALTERNATIVES**
- **Bare Fastify:** fastest and leanest, but we'd reinvent DI, module boundaries, guards/interceptors, and the WS/queue wiring — at this scope that reinvention costs more than Nest's overhead. We keep Fastify *under* Nest to get its speed.
- **Express:** slower, unstructured, dated middleware model.
- **tRPC alone:** great for typed RPC, but we need REST for third-party/webhook/OAuth callbacks and a robust WS layer; tRPC can be layered *inside* Nest later for internal typed calls if desired (Later).

---

## 6.7 Database

**DECISION: PostgreSQL 16 (single primary, the system of record).** Tag: **MVP (Phase 1).**

**WHY**
- One mature, ACID, relational engine covers the bulk of our needs: users/workspaces/tenancy, sessions, the **append-only event log** (the replayable stream), tasks/plans/steps, tool invocations, audit log, permissions/scopes, billing/usage metering, connectors. Strong constraints and transactions are exactly right for an auditable, money-touching system.
- Postgres extends to cover adjacent needs we'd otherwise add infra for: **pgvector** for embeddings (§6.9), `JSONB` for flexible event/tool payloads, `LISTEN/NOTIFY` and logical replication if needed, partial/GIN indexes for the event stream and audit queries, row-level security as a tenancy backstop.
- Append-only event tables partitioned by time/session give cheap replay and retention.

**TRADEOFFS**
- A single primary is a scaling ceiling eventually. Mitigation path (Later): read replicas for replay/analytics, table partitioning for the event/audit logs, and moving hot ephemeral counters (rate limits, presence) to Redis (already in the stack).
- High-write event streams can pressure a single Postgres. Mitigation: events are batched/buffered through the realtime gateway and written in bulk; partition + index discipline; optionally tier cold events to object storage (Later).

**REJECTED ALTERNATIVES**
- **MongoDB:** weaker for the relational, constraint-heavy, money-touching core; we'd lose transactional guarantees we want for billing/audit.
- **MySQL:** viable, but Postgres's `JSONB`, pgvector, and extension ecosystem are decisively better for this workload.
- **SQLite:** great for the *desktop local store* (and we use it there — see §6.16), wrong for the multi-tenant server.

---

## 6.8 ORM / data-access

**DECISION: Prisma (primary ORM) with raw SQL escape hatch for vector/analytic queries.** Tag: **MVP (Phase 1).**

**WHY**
- **Prisma** gives a typed schema (`schema.prisma`) that generates a fully-typed client — the data layer's types line up with our TS-everywhere principle, and migrations are first-class and reviewable (`prisma migrate`). For a team moving fast on a large schema (sessions, events, tools, audit, billing), Prisma's ergonomics and migration safety reduce data-layer bugs.
- pgvector is supported via Prisma's `Unsupported("vector")` column type + raw queries (`$queryRaw`), so embeddings live in the same schema and same migrations.
- Prisma's generated client is the safest default for the 90% of CRUD; the 10% of hot/complex queries (vector KNN, event-stream windowing, usage aggregation) use **`$queryRaw` tagged-template SQL** or **Kysely** (typed query builder) under the same connection.

**TRADEOFFS**
- Prisma's query engine adds a binary and some overhead vs hand-rolled SQL; complex joins can generate suboptimal SQL. Mitigation: the documented raw-SQL/Kysely escape hatch for the handful of hot paths; we don't fight the ORM on those.
- Prisma migrations and a long-lived connection pool need care under serverless — irrelevant here since our backend is long-running containers, not serverless.

**REJECTED ALTERNATIVES**
- **Drizzle:** excellent, SQL-first, lighter — strong contender. Rejected as *primary* only because Prisma's migration tooling and schema ergonomics are more turnkey for a large team and schema; Drizzle/Kysely remain available for hot queries. (If migration friction with pgvector ever bites, Drizzle is the pre-approved fallback.)
- **TypeORM:** historically buggy migrations and decorator-entity friction.
- **Raw SQL only:** loses type-safety and migration ergonomics across a big schema.

---

## 6.9 Vector search

**DECISION: pgvector inside the primary PostgreSQL (HNSW index).** Tag: **MVP for memory retrieval (Phase 1 minimal), expands Phase 5.**

**WHY**
- Memory / knowledge / playbook retrieval (RAG) needs embedding similarity search. **pgvector** keeps embeddings *in the same database as their owning rows* — one datastore, one backup, one transaction, one tenancy/RLS boundary. No second system to operate, secure, and keep consistent at our scale.
- **HNSW** indexes give fast approximate KNN; filtering by `workspace_id`/`user_id` in the same `WHERE` keeps retrieval tenant-scoped and avoids leaking private data across tenants — directly serving the "avoid sending unnecessary private data to the model" mandate.
- Embedding-and-retrieve volume at launch is modest; a dedicated vector DB is premature infrastructure.

**TRADEOFFS**
- At very large scale (tens of millions of vectors, high QPS), a purpose-built vector engine outperforms pgvector. We're nowhere near that at launch. Migration path (Later): if vector workload outgrows Postgres, abstract retrieval behind a `MemoryStore` interface (already planned in `packages/tool-abi`) and swap in **Qdrant** or **pgvector on a dedicated read replica** without touching call sites.

**REJECTED ALTERNATIVES**
- **Qdrant / Weaviate / Milvus:** more capable at scale but add a whole stateful service to run, secure, back up, and keep tenancy-consistent — unjustified for launch. Kept as a documented escape hatch behind the `MemoryStore` interface.
- **Pinecone (managed):** sends private embeddings to a third party — conflicts with the privacy/local-first posture and "no unnecessary private data" rule.

---

## 6.10 Queue / background jobs

**DECISION: BullMQ on Redis 7.** Tag: **MVP (Phase 1).**

**WHY**
- Agent runs are long, multi-step, retryable, cancellable, and must survive worker restarts. **BullMQ** gives durable jobs, retries with backoff, rate limiting, repeatable/cron jobs (for **Scheduled Tasks**), priorities, flow/parent-child jobs (for **Wide Research** map-reduce fan-out later), and graceful concurrency control — all on Redis we already run for realtime adapters and caching.
- First-class NestJS integration (`@nestjs/bullmq`) and a mature dashboard (`bull-board`) for ops visibility.
- Repeatable jobs cover the Scheduled-Tasks surface (cron-driven runs) with no extra scheduler.

**TRADEOFFS**
- Redis is in-memory; durability depends on AOF/RDB persistence configuration and is weaker than a disk-first broker. Mitigation: the **system of record is Postgres** (every job's authoritative state — task, plan, steps, events — is persisted relationally); Redis/BullMQ is the *execution coordinator*, so a Redis loss degrades to "reschedule from Postgres state," not data loss. Configure AOF + replica for the queue Redis.
- One more stateful service. But we need Redis anyway for the Socket.IO adapter, rate limiting, presence, and prompt-cache metadata — so BullMQ is "free" infra reuse.

**REJECTED ALTERNATIVES**
- **Temporal:** superb durable-workflow engine and a real candidate for the agent loop's durability — but a heavy operational dependency (its own cluster + DB) and a steep model shift. Deferred consideration: if agent-run durability/replay outgrows BullMQ + our Postgres event log, Temporal is the pre-vetted upgrade for the engine specifically (Later).
- **RabbitMQ / SQS:** more broker to run (Rabbit) or cloud-lock-in + weaker job semantics (SQS) vs BullMQ's batteries-included job features.

---

## 6.11 Realtime transport

**DECISION: Socket.IO v4 with a Redis adapter, typed event contracts.** Tag: **MVP (Phase 1).**

**WHY**
- The product is a live stream of agent events to one or many clients (web tab, desktop window, shared replay viewers). **Socket.IO** gives auto-reconnect, rooms/namespaces, and multi-node fan-out via the **Redis adapter** out of the box — and the teardown shows the proven Manus model uses exactly this (namespaces `chat` and `device`, token in the `auth` handshake, custom staged backoff). We adopt the working parts and harden the rest.
- **Namespaces:** `/chat` (agent stream, notifications, STT) and `/device` (desktop sidecar control plane — declarative `device_config` in, `device_status` out). Rooms keyed by `sessionId` give precise fan-out and replay-viewer joins.
- **Typed contracts:** `packages/protocol` defines a `ServerToClientEvents` / `ClientToServerEvents` map consumed by both the Nest gateway and the client — no stringly-typed events.
- **Auth in the handshake `auth` object, never the query string;** tokens redacted in logs (a teardown-validated pattern).

**TRADEOFFS**
- Socket.IO has protocol overhead vs raw `ws` and a client lib requirement. Worth it: reconnection, rooms, multiplexing, and the Redis fan-out adapter are exactly our needs and would otherwise be hand-rolled. The sidecar uses a Socket.IO client too, matching the server's namespace model.
- Long-lived sockets need sticky sessions or a shared adapter behind a load balancer. Solved by the Redis adapter (no stickiness required for fan-out) + LB websocket affinity where needed.

**REJECTED ALTERNATIVES**
- **Raw `ws`:** lighter wire, but we'd reimplement reconnect, rooms, namespaces, and multi-node fan-out.
- **Server-Sent Events:** unidirectional; we need client→server control (stop, approve, takeover) on the same channel.

---

## 6.12 Browser automation

**DECISION: Playwright (Chromium primary) as the browser-tool engine, run inside the sandbox.** Tag: **MVP-light (Phase 1 headless), expands Phase 4–5.**

**WHY**
- Browser-using tools (navigate, read page, fill forms, screenshot, download) need a robust, modern automation library. **Playwright** has the best auto-waiting, multi-context isolation, network interception, tracing, and headless+headful parity, and it drives the same Chromium we expose to the user for **takeover/VNC**. It runs cleanly inside the cloud sandbox container.
- One Playwright context per session = clean isolation, per-session cookies/storage, and a trace artifact for the audit log.
- Network interception lets us enforce egress policy and redact sensitive request/response data before logging.

**TRADEOFFS**
- Playwright bundles browser binaries (~hundreds of MB) — fine inside the server-side sandbox image, *not* shipped in the thin desktop bundle. (This reinforces the desktop-shell decision in §6.13: the desktop does **not** run Playwright; the sandbox/sidecar do.)
- Headful + VNC for takeover needs a display server (Xvfb) in the sandbox image. Standard, well-trodden.

**REJECTED ALTERNATIVES**
- **Puppeteer:** Chromium-only, weaker auto-wait and multi-browser story.
- **Selenium:** heavier, flakier, dated API.

**HARD-RULE NOTE:** the browser tool must **refuse CAPTCHA/2FA bypass** by policy (a non-negotiable). The tool layer flags such pages and escalates to a user-approval/takeover, never automated solving.

---

## 6.13 Desktop shell — Electron vs Tauri

### VERDICT: **Electron.** Tag: **MVP shell scaffold (Phase 0), packaging (Phase 6).**

This is the headline desktop decision. We evaluate against the factors the brief calls out: **Node/Playwright integration, local-operator sidecar, packaging/auto-update, bundle size, security model, ecosystem, and the prior research (Manus uses Electron + `app://` + per-request CSP nonce).**

| Factor | Electron | Tauri | Weight & call |
|---|---|---|---|
| **Sidecar spawn/supervise** | Node `child_process` in main: spawn the native sidecar, PID lockfile, SIGTERM→SIGKILL / `taskkill /T /F`, `PARENT_PID` env, orphan reaping. First-class, battle-tested (the exact Manus pattern). | Rust `std::process` / `tauri-plugin-shell` can spawn a bundled sidecar too — capable, but the orchestration code, reconnect/epoch queue, and IPC glue would be re-authored in Rust with a smaller body of reference code. | **High → Electron.** Our most security-critical native component (the operator sidecar) has a *proven, directly portable* Electron supervision blueprint in the teardown. |
| **`app://` privileged protocol + per-request CSP nonce** | `protocol.handle('app', …)` with `{ secure, standard, supportFetchAPI, corsEnabled, allowServiceWorkers, stream, codeCache }` + injected nonce — the exact, documented Manus approach we can adopt and harden. | Tauri serves assets via its own `tauri://`/custom protocol and has a strong default CSP, but the precise per-request-nonce + service-worker + stream behavior would be re-derived. | **High → Electron.** Reference implementation exists; lower risk. |
| **Auto-update** | `electron-updater` + `electron-builder`: mature NSIS (self-update feed) **and** MSIX (Store) dual-target, staged rollout, code-signing pipeline — the proven path. | Tauri updater is good and improving, signs updates by default, smaller artifacts — but a smaller ecosystem of edge-case tooling (Store packaging, enterprise MSI nuance). | **Medium-High → Electron.** Dual NSIS+MSIX with a known-good pipeline is a launch requirement (Phase 6). |
| **Bundle / install size** | Large (ships Chromium + Node, ~100–150 MB+ installed). | **Much smaller** (uses the OS WebView; single-digit to low-tens of MB). | **Tauri wins, but low weight for us.** Our renderer is a heavy SPA either way; the brief explicitly de-prioritizes bundle size unless it's a *headline feature* — it isn't. |
| **Security model** | `sandbox:true` renderer, `contextIsolation:true`, `nodeIntegration:false`, **named typed IPC allowlist (no raw `invoke` passthrough)**, scoped CORS, full CSP. Strong *if* we fix the exact weaknesses the teardown flags (Manus shipped `sandbox:false`, a generic `api.invoke` passthrough, and a global `<all_urls>` CORS strip — we will not). | Strong-by-default: Rust core, no Node in the renderer, capability/permission allowlist for commands, smaller native attack surface. Genuinely the safer *default*. | **Tauri wins on defaults; Electron is equally safe when hardened.** We have an explicit, itemized hardening checklist from the teardown, so Electron's weaker defaults are a known, closed gap rather than an open risk. |
| **Web ⇆ desktop renderer parity (Next static export)** | Renders the same Next static export over `app://`; mature, well-documented. | Also renders a static SPA in the WebView — but **WebView engine differs per-OS** (WebView2/Chromium on Windows, WKWebView on macOS, WebKitGTK on Linux), so we'd test/qualify the SPA against *three* engines. | **High → Electron.** A single bundled Chromium means **web and desktop render in the same engine**, eliminating a whole class of cross-engine rendering/Playwright-parity bugs. For a product whose UX *is* a live rendered agent stream, engine uniformity is worth the bytes. |
| **Node/Playwright in the shell** | Node available in main (we keep Playwright *out* of the desktop bundle — it lives in the sandbox — but Node ergonomics help for local file dialogs, the sync localStorage shim, sidecar IPC). | No Node; would shell out to the sidecar for anything Node-ish. | **Medium → Electron**, mostly for sidecar/IPC ergonomics. Note: neither shell runs Playwright; that's server-side. |
| **Ecosystem / hiring / reference** | Vast; the teardown gives us a near-complete, directly reusable module map (`WindowManager`, `StepTimerHelper` backoff curve, presenter/quickAsk windows, single-instance, deep-link). | Smaller but healthy and growing; less turnkey reference for our exact multi-window + sidecar pattern. | **Medium-High → Electron.** We can move fastest by adapting a proven shape, then harden. |

**DECISION RATIONALE (synthesis).** The two factors that dominate for *this* product are (1) **the operator sidecar is our highest-risk, highest-value native component**, and we have a proven, directly portable Electron supervision + reconnection + reconciliation blueprint for it; and (2) **engine uniformity** — bundling one Chromium so web and desktop render identically removes an entire QA axis for a UI that is fundamentally a live-rendered stream. Tauri's real wins (bundle size, safer defaults) are explicitly low-priority per the brief (size isn't a headline feature) and *neutralized* by our itemized hardening checklist (the teardown already enumerates Electron's exact weak spots and their fixes). Tauri would trade a known, closed risk for a smaller-but-less-charted path on our two most important axes.

**TRADEOFFS we accept by choosing Electron**
- **~100 MB+ installs** vs Tauri's tens of MB. Accepted; not a headline feature.
- **Weaker security defaults** — *only if left default.* We commit to the hardening checklist below as non-negotiable acceptance criteria.
- **Higher memory/CPU baseline** (full Chromium per window). Mitigated by window reuse, `backgroundThrottling` tuning, and few concurrent native windows.

**Electron hardening checklist (acceptance criteria — fixes every teardown-flagged weakness):**
1. `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` on **every** window (Manus shipped `sandbox:false` — we don't).
2. **Named, typed, allowlisted IPC only** — no generic `invoke(channel, …)` passthrough. Each exposed method has a Zod-validated payload (closes the "generic `api.invoke`" weakness).
3. **Scoped CORS** to our origins only — never a global `<all_urls>` `access-control-*` strip (the teardown's "single most dangerous thing").
4. **Full CSP**: `default-src`, `connect-src`, `script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'` — not just `script-src`.
5. **`app://` privileged protocol** for assets (no `file://`, no localhost HTTP); per-request CSP nonce.
6. **PKCE deep-link auth** (`agentos://?code=` exchanged over HTTPS), not a plaintext token in the URL.
7. **Sidecar integrity**: codesign-verify + hash-pin before spawn; refuse unverified binaries; **PID lockfile** (not kill-by-name sweeps).
8. **`setWindowOpenHandler` denies all `window.open`;** untrusted `will-navigate` cancelled and opened in the external browser; `TRUSTED_ORIGINS` allowlist.
9. **No secrets/dev endpoints in the bundle** — server-driven flags; the LLM API key never reaches the renderer.

> **Tauri reconsideration trigger (documented):** if, post-launch, install size or memory becomes a *marketed* differentiator, or if a second (Linux-heavy) audience makes per-OS WebView acceptable, revisit Tauri for a v2 shell behind the same `packages/desktop-ipc` contract — the renderer (Next static export) is shell-agnostic, so a shell swap is contained.

---

## 6.14 Local operator sidecar language

**DECISION: Rust (single static binary), Socket.IO client to the cloud over WSS.** Tag: **MVP (Phase 3).**

**WHY**
- The sidecar reads/writes the user's real files and (when approved) runs shell commands — the highest-risk component. **Rust** gives memory safety, a single self-contained static binary (no runtime to ship), strong cross-compilation (Win/macOS/Linux, x64/arm64), and excellent crates for FS sandboxing, process control, and code-signing verification.
- A single static binary is trivially **codesign-verified + hash-pinned** before the desktop shell spawns it (a teardown-mandated control), and trivially shipped in `resources/bin`.
- Rust's strictness pays off precisely where bugs are catastrophic (path traversal, privilege escalation, command injection).

**TRADEOFFS**
- Rust has a steeper learning curve and slower iteration than Go. Accepted because the security stakes justify it and the surface is small (file ops, shell exec under approval, the `device_config` reconciler, WS client).
- Smaller pool of Rust devs than Go. Mitigated by the contained scope and the strong reference design (the Manus `myComputer` reconciliation model, reimplemented natively).

**REJECTED ALTERNATIVES**
- **Go (Manus's likely choice):** faster to write, great concurrency, single binary too — a legitimate alternative and our fallback if Rust velocity disappoints. Rust edges it on memory-safety guarantees for a filesystem-touching, token-bearing binary.
- **Node sidecar:** would ship a runtime, larger and harder to integrity-pin; rejected.

---

## 6.15 Sandbox isolation

**DECISION: Container-per-session (Docker + gVisor) at launch; Firecracker microVMs as a density/isolation upgrade later.** Tag: **MVP cloud path (Phase 1 = plain container; gVisor hardening Phase 3–4); microVM Later.**

**WHY**
- Cloud execution of untrusted, agent-driven shell/code/browser must be isolated per session. **Container-per-session** is the fastest path to a working sandbox (Docker image with terminal, file tools, Playwright/Chromium, Xvfb for VNC). **gVisor** (runsc) adds a user-space kernel that dramatically shrinks the host-kernel attack surface without VM weight.
- This mirrors the proven Manus `manus.computer` shape and keeps cloud cost manageable (containers pack denser than VMs).

**TRADEOFFS**
- gVisor adds syscall-emulation overhead and some compatibility edge cases. Acceptable for our tool workloads; benchmark before committing image base.
- Containers share the host kernel (even with gVisor's mitigation). For higher multi-tenant isolation/density, **Firecracker microVMs** are the upgrade — deferred until multi-tenant density or a stronger isolation guarantee demands it, behind a `SandboxProvider` interface so the swap is contained.

---

## 6.16 File / object storage

**DECISION: S3/R2-compatible object storage abstraction behind a `BlobStore` interface; local-first uses the OS filesystem (via the sidecar) + a desktop SQLite store.** Tag: **MVP (Phase 1 cloud blobs; Phase 3 local-first).**

**WHY**
- Artifacts (reports, slides, generated sites, uploads, browser traces) need durable, presigned-URL storage. An **S3-compatible API** (AWS S3, **Cloudflare R2**, or **MinIO** for self-host/dev) behind a single `BlobStore` interface (`putPresigned`, `getPresigned`, `delete`, `head`) means we run **MinIO in Docker Compose locally** and swap to R2/S3 in prod with zero call-site changes — and self-hosters can point at their own MinIO. R2 specifically avoids egress fees, attractive for artifact-heavy downloads.
- **Local-first** (the headline differentiator): for desktop local-mode, artifacts and file ops live on the **user's real filesystem** through the Rust sidecar under per-action approval — never round-tripped to the cloud unless the user opts in. A small **SQLite** DB in the desktop `userData` dir holds the local index, the synchronous-localStorage shim replacement, device id, and the per-tool permission/audit ledger.
- Presigned uploads/downloads keep large blobs off the API process entirely.

**TRADEOFFS**
- Two storage modalities (cloud object store vs local FS) behind one logical `BlobStore`/`FileTool` contract add interface complexity. Justified: local-first privacy is a core differentiator, and the abstraction keeps tool code identical across modes.
- SQLite on desktop is single-writer; fine for a single-user local index.

**REJECTED ALTERNATIVES**
- **Postgres BYTEA / large objects:** wrong tool for big binaries; bloats the DB and backups.
- **Vendor-locked S3-only:** rejected in favor of the S3-compatible *abstraction* (R2/MinIO portability + self-host).

---

## 6.17 Validation & shared contracts

**DECISION: Zod as the single validation + contract authoring layer, shared in `packages/protocol` and `packages/tool-abi`.** Tag: **MVP (Phase 0).**

**WHY**
- Every boundary — HTTP request bodies, WebSocket events, tool inputs/outputs, the LLM tool-call arguments, IPC payloads, env/config — is validated with **Zod**, and the *same* Zod schemas are the source of both runtime validation and inferred TypeScript types (`z.infer`). One schema = one type = one validator, across client, server, sidecar-facing contracts, and the tool ABI.
- Tool schemas authored in Zod convert to **JSON Schema** (via `zod-to-json-schema`) for the LLM's tool/function-calling definitions — so the tool ABI the model sees and the runtime validation are generated from one source, eliminating drift between "what the model was told" and "what we accept."
- Env/config validated at boot with Zod → fail-fast on misconfiguration.

**TRADEOFFS**
- Runtime validation has a small CPU cost on hot paths. Negligible vs the safety; hot inner loops can skip re-validation of already-trusted internal data.

**REJECTED ALTERNATIVES**
- **class-validator (Nest-native):** decorator-based, doesn't infer types as cleanly, not as portable to the client/sidecar contracts. We use Zod *through* Nest via a Zod validation pipe instead.
- **io-ts / Yup / Valibot:** Zod has the strongest ecosystem (JSON-Schema conversion, OpenAPI, form libs) for our needs; Valibot's smaller bundle isn't worth fragmenting on.

---

## 6.18 Auth approach

**DECISION: First-party auth — OAuth 2.0 **Authorization Code + PKCE** for desktop deep-link login, secure HTTP-only cookie sessions for web, short-lived access tokens + rotating refresh for service/socket auth.** Tag: **MVP (Phase 2).**

**WHY**
- **Web:** standard login → server sets an **HTTP-only, Secure, SameSite cookie** session (CSRF-protected). The browser never sees a bearer token in JS — closes the XSS-token-theft vector.
- **Desktop:** browser-based login redirects to **`agentos://?code=…`**; the shell exchanges the one-time **code over HTTPS** (with PKCE `code_verifier`) for tokens — fixing the teardown's flagged plaintext-token-in-deep-link interception risk. A `nonce`/state guards CSRF.
- **Sockets & sidecar:** short-lived access token passed in the Socket.IO `auth` handshake (never query string), device-bound via persisted `deviceId`; refresh handled out-of-band. Tokens redacted in all logs.
- First-party (no Auth0/Clerk/Firebase) keeps identity, token lifecycle, and the deep-link handshake fully owned — matching the "we own it" posture and avoiding a third-party identity SDK in the bundle.

**TRADEOFFS**
- Owning auth means owning token issuance, rotation, revocation, and refresh correctly — more responsibility than a managed provider. Justified by security ownership and the desktop deep-link requirement that managed providers handle awkwardly. We isolate it in an `auth` Nest module with exhaustive tests (see acceptance criteria).
- PKCE + deep-link + multi-surface sessions are more moving parts than a single bearer token. The teardown shows the simpler path's exact failure mode; we pay the complexity to close it.

**REJECTED ALTERNATIVES**
- **Plaintext token in deep-link (Manus's approach):** explicitly rejected — interceptable by any local app registered for the scheme.
- **Auth0/Clerk:** third-party SDK in the bundle, less control over the desktop deep-link/PKCE flow, recurring cost, privacy surface.

---

## 6.19 LLM provider abstraction

**DECISION: A thin `LlmProvider` interface with an Anthropic-first implementation; default model **`claude-opus-4-8`** via the Anthropic API. Key stored server-side, encrypted at rest, never in the frontend.** Tag: **MVP (Phase 1).**

**WHY**
- The brief mandates default Claude Opus (exact id `claude-opus-4-8`) with a **clean provider abstraction** for future providers, and BYO-model. A narrow `LlmProvider` interface (`complete`, `stream`, `countTokens`, `tools`, `cache`) lets us code the agent loop against the abstraction while the Anthropic implementation handles streaming, tool-calling, and **prompt caching**.
- **Cost & context control** are first-class: the provider records token usage per call → metered into Postgres per task/workspace/user/month; the engine applies context management (chunking, summarization, memory retrieval, prompt caching, cache-aware message construction) and **pre-estimates cost before expensive tasks**.
- **Key security:** the Anthropic key is entered in settings, **encrypted at rest** (envelope encryption — see §6.20), decrypted only in the backend/engine process at call time, and **never serialized to any client bundle or wire payload**. BYO-key is per-workspace, same encryption path.

**TRADEOFFS**
- An abstraction over a single provider risks leaking provider-specific concepts (Anthropic's content blocks, cache control). Mitigation: model the interface on the *superset* we need (streamed content parts, tool-use blocks, cache hints) so a second provider adapts to it rather than the reverse. Don't over-generalize before the second provider exists (YAGNI) — keep the interface honest to current needs with clearly marked extension points.

> Authoritative model id and pricing/caching parameters are pinned in the dedicated LLM/provider planning doc; this doc commits only the *architecture* (server-side, encrypted, abstracted, metered).

---

## 6.20 Secret management & encryption

**DECISION: Envelope encryption for at-rest secrets — a KMS/master key wraps per-secret data keys (AES-256-GCM); dev uses a local master key, prod uses cloud KMS. Secrets live only in the backend trust zone.** Tag: **MVP (Phase 1).**

**WHY**
- The LLM API key, OAuth client secrets, connector tokens, and sidecar-issued tokens are **critical-classified**. Envelope encryption (master key in KMS, per-row data keys, AES-256-GCM with auth tags) means a DB dump alone never yields plaintext secrets, and key rotation re-wraps data keys without re-encrypting all data.
- Secrets are decrypted **only** inside the API/engine process boundary, never sent to the renderer, never logged, and masked in all surfaces (the "sensitive data masked" rule). Config is Zod-validated at boot.

**TRADEOFFS**
- KMS dependency in prod (operational + cost). Justified for critical secrets; dev/self-host falls back to a file-based master key with a documented threat-model caveat.

---

## 6.21 Testing stack

**DECISION:** **Vitest** (unit + integration for all TS), **Playwright Test** (web + desktop E2E), **Supertest-style API integration** against an ephemeral Postgres/Redis via **Testcontainers**, **Rust `cargo test`** for the sidecar, and **contract tests** on `packages/protocol`/`packages/tool-abi`. Tag: **MVP (Phase 0 harness; per-module thereafter).**

**WHY**
- **Vitest** — fast, ESM-native, Vite-powered, Jest-compatible API; one runner across packages and services. Coverage via `v8`.
- **Playwright Test** — drives both the **web** app and the **Electron** app (`_electron` API launches the packaged shell), so the same E2E suite verifies "give a task → watch the Computer panel → get a result" on both surfaces. (Reuses the Playwright we already standardize on for the browser tool.)
- **Testcontainers** — spins ephemeral Postgres + Redis + MinIO for API/integration tests, so data-layer and queue behavior are tested against real engines, not mocks.
- **Contract tests** on the shared protocol/tool-ABI packages guarantee client/server/sidecar stay wire-compatible — the highest-value tests in a streaming, tool-calling system.
- **Rust sidecar** — `cargo test` for path-traversal refusal, approval-gating, reconnect/reconcile logic.
- The brief's hard rule: **no module is "done" without passing tests.** This stack makes that enforceable in CI (Turborepo `test` task gating).

**TRADEOFFS**
- Testcontainers needs Docker in CI (slower, heavier runners). Worth it for fidelity; unit tests stay container-free and fast for the inner loop.
- Electron E2E is slower/flakier than web E2E. Mitigation: keep the desktop E2E suite focused on shell-specific behavior (deep-link auth, IPC allowlist, sidecar spawn, window model) and run the bulk of UI E2E on web (same renderer).

**REJECTED ALTERNATIVES**
- **Jest:** slower, more config for ESM/TS; Vitest is the modern default with a compatible API.
- **Cypress:** good DX but weaker multi-tab/desktop/Electron and trace story than Playwright; we already standardize on Playwright.

---

## 6.22 Containerization & local dev

**DECISION: Docker + Docker Compose for the full local stack and prod service images; one `compose.yaml` brings up Postgres+pgvector, Redis, MinIO, the API, worker, realtime gateway, and a sandbox-runner.** Tag: **MVP (Phase 0).**

**WHY**
- A single `docker compose up` must produce a working backend (DB, queue, object store, API, worker, gateway) so any contributor and CI get an identical environment — directly serving the brief's "production-grade, no demo" bar and the "Testcontainers in CI" approach (same images).
- Each service ships as a slim multi-stage image; the **sandbox** image is separate (Chromium/Xvfb/tooling) and pulled per-session by the sandbox provider.
- Compose for dev/CI; the orchestration target for prod (Kubernetes/Nomad) is a later infra decision behind the same images — not required for MVP.

**TRADEOFFS**
- Compose isn't a production orchestrator (no autoscaling/self-healing). Fine for MVP/single-host and CI; prod orchestration is a deliberately deferred infra choice using the same images.

---

## 6.23 Observability

**DECISION: One first-party telemetry/audit pipeline (structured logs → Postgres audit log + OpenTelemetry traces) + Sentry for errors only.** Tag: **MVP (Phase 1 logs/audit; tracing Phase 2+).**

**WHY**
- The brief mandates logging every important action and a full audit trail with risk levels and approvals — that audit log is a **product feature**, persisted in Postgres (append-only, queryable, per-session replayable), not just ops telemetry.
- **OpenTelemetry** traces span the request → queue → engine → tool → sandbox path for debugging long agent runs; **Sentry** captures crashes/exceptions (errors only). We deliberately **avoid the vendor sprawl** the teardown criticized (Amplitude+Segment+Thumbmark+AppsFlyer) — one first-party pipeline + Sentry, with **no device fingerprinting** by default (privacy posture).
- Tokens/secrets/PII are redacted at the logging boundary (a teardown-validated pattern).

**TRADEOFFS**
- Building a first-party metrics/audit pipeline is more work than dropping in a SaaS SDK. Justified by privacy posture, compliance surface, and the fact that the audit log is a core feature anyway.

---

## 6.24 Stack summary table

| Concern | Decision | Phase |
|---|---|---|
| Monorepo | **pnpm + Turborepo** | MVP P0 |
| Language | **TypeScript (strict)** + Rust (sidecar) | MVP P0 |
| Frontend | **Next.js App Router, static export, React 19** | MVP P0 |
| UI | **Tailwind + shadcn/ui (Radix), CSS-var tokens** | MVP P0 |
| Client state | **Zustand (stream/UI) + TanStack Query (server)** | MVP P0 |
| Backend | **NestJS on Fastify adapter** | MVP P1 |
| DB | **PostgreSQL 16** (system of record) | MVP P1 |
| ORM | **Prisma** + raw SQL/Kysely escape hatch | MVP P1 |
| Vector | **pgvector (HNSW) in Postgres** | MVP P1 / P5 |
| Queue | **BullMQ on Redis 7** | MVP P1 |
| Realtime | **Socket.IO v4 + Redis adapter, typed events** | MVP P1 |
| Browser automation | **Playwright (Chromium), in sandbox** | MVP P1 / P4–5 |
| **Desktop shell** | **Electron** (hardened) — verdict below | MVP P0 / P6 |
| Sidecar | **Rust** static binary, codesigned + hash-pinned | MVP P3 |
| Sandbox | **Container-per-session (Docker+gVisor)**; Firecracker later | MVP P1 / Later |
| Object storage | **S3/R2/MinIO behind `BlobStore`**; local FS for local-first | MVP P1 / P3 |
| Validation/contracts | **Zod** (shared protocol + tool ABI) | MVP P0 |
| Auth | **First-party OAuth + PKCE (desktop), cookie sessions (web)** | MVP P2 |
| LLM | **`claude-opus-4-8`** via Anthropic, behind `LlmProvider`; key encrypted server-side | MVP P1 |
| Secrets | **Envelope encryption (KMS + AES-256-GCM)** | MVP P1 |
| Testing | **Vitest + Playwright Test + Testcontainers + cargo test + contract tests** | MVP P0+ |
| Containers | **Docker + Compose** | MVP P0 |
| Observability | **First-party audit/logs + OTel + Sentry (errors only)** | MVP P1+ |

---

# 7. System Architecture & Service Topology

## 7.1 Service inventory

Each service is independently deployable, communicates over the channels noted, and is owned by a workspace package (see §34).

1. **Web App (`apps/web`)** — Next.js static-export SPA served from a CDN. Renders the two-pane agent workspace (conversation/plan left, live Computer panel right). Talks to the backend over **REST** (TanStack Query) and **WebSocket** (Socket.IO `/chat`). Holds **no secrets**; auth via HTTP-only cookie. *(Thin renderer.)*

2. **Desktop App (`apps/desktop`)** — Electron shell hosting the *same* renderer over `app://` + CSP nonce. Adds: PKCE deep-link auth (`agentos://`), window model (main / quickAsk / child / presenter), tray + global hotkeys, native file dialogs, and **supervision of the local operator sidecar**. Named/typed IPC allowlist only. *(Thin renderer + local supervisor.)*

3. **Backend API (`services/api`)** — NestJS/Fastify. The front door: auth, workspaces/tenancy, sessions, tasks, files/artifacts (presigned URLs), connectors/MCP registry, billing/usage, settings (encrypted secrets), and the **risk-gate + approval** endpoints. Validates everything with Zod. Produces jobs onto BullMQ; reads/writes Postgres; brokers secrets (decrypt only server-side).

4. **Realtime Gateway (`services/gateway`)** — NestJS WebSocket gateway (Socket.IO + Redis adapter). Two namespaces: **`/chat`** (streams agent events to web/desktop clients and replay viewers; carries stop/approve/takeover from client→server) and **`/device`** (desktop sidecar control plane: inbound `device_config`, outbound `device_status`). Fans out engine events to session rooms. *(Can be co-deployed with API behind one Nest app at small scale, split out under load.)*

5. **Worker / Queue Consumers (`services/worker`)** — BullMQ workers that own long-running agent runs and side tasks (artifact generation, deploy pipeline, scheduled-task triggers, Wide Research fan-out). Hosts the **Agent Engine** runtime. Survives restarts (state in Postgres).

6. **Agent Engine (`packages/agent-engine`, run inside the worker)** — the brain: plan → act → observe → replan over the typed **tool catalog**, streaming `plan`/`tool_call`/`tool_result`/`message` events to the gateway. Applies context management, prompt caching, summarization, memory retrieval, step budgets, kill switch, and the **risk classifier** that gates high/critical actions to approval. Calls the LLM via `LlmProvider`.

7. **Tool Layer (`packages/tool-abi` + executors)** — each tool is a Zod-typed schema with a **risk tag** (low/medium/high/critical) and an executor that runs in the **sandbox** (cloud) or via the **sidecar** (local). Shared contract so client rendering and execution agree.

8. **Browser Automation Service (in-sandbox)** — Playwright/Chromium inside the session sandbox; exposes navigate/read/fill/screenshot/download as tools; provides headful + VNC for **takeover**. Refuses CAPTCHA/2FA bypass.

9. **Cloud Sandbox Pool (`services/sandbox-orchestrator` + runner image)** — provisions container-per-session (Docker + gVisor) exposing terminal, file editor, headless browser; idle-reaps; enforces resource limits. Behind a `SandboxProvider` interface (Firecracker upgrade path).

10. **Local Operator Service / Sidecar (`apps/sidecar`, Rust)** — native per-shared-folder binary. Dials the cloud session WS (or executes locally in local-first mode), reads/writes the user's real files, runs shell **only under per-action approval**, streams a local activity/audit log, enforces read-only vs read-write scopes and OS-level jailing. Codesign-verified + hash-pinned by the desktop shell before spawn; orphan-safe via PID lockfile + `PARENT_PID`.

11. **PostgreSQL** — system of record (users, workspaces, sessions, append-only event log, tasks/plans/steps, tool invocations, audit log, permissions/scopes, billing/usage, connectors, memory + **pgvector** embeddings).

12. **Redis** — Socket.IO fan-out adapter, BullMQ broker, rate limits, presence, prompt-cache metadata, ephemeral counters.

13. **Object Storage (S3/R2/MinIO)** — artifacts, uploads, browser traces; presigned upload/download; behind `BlobStore`.

14. **Vector Store** — pgvector *inside* Postgres (no separate service at launch).

---

## 7.2 Architecture diagram

```
                                 WEB (browser)                         DESKTOP (Electron, hardened)
                          ┌───────────────────────────┐        ┌─────────────────────────────────────────────┐
                          │  apps/web  (Next static    │        │  apps/desktop  (Electron main)               │
                          │  export SPA, same renderer)│        │   • app:// asset proto + per-req CSP nonce   │
                          │   • TanStack Query (REST)  │        │   • agentos:// PKCE deep-link auth            │
                          │   • Zustand (WS stream)    │        │   • named/typed IPC allowlist (no passthru)  │
                          │   • HTTP-only cookie auth  │        │   • WindowManager: main/quickAsk/child/present│
                          └───────┬───────────┬────────┘        │   • tray + global hotkeys                     │
                                  │REST        │WSS              │   ┌────────────────────────────────────────┐ │
                                  │(cookie)    │(/chat,auth      │   │ renderer = SAME Next SPA over app://     │ │
                                  │            │ handshake)      │   └────────────────────────────────────────┘ │
                                  │            │                 │   ┌────────────────────────────────────────┐ │
                                  │            │                 │   │ Sidecar Supervisor (Node, main process)  │ │
                                  │            │                 │   │  • codesign-verify + hash-pin binary     │ │
                                  │            │                 │   │  • spawn/supervise, PID lockfile         │ │
                                  │            │                 │   │  • applies device_config / emits status  │ │
                                  │            │                 │   └───────────────┬────────────────────────┘ │
                                  │            │                 └───────────────────┼──────────────────────────┘
                                  │            │                                     │ spawn/supervise
                                  │            │                                     ▼
                                  │            │                          ┌──────────────────────────┐
                                  │            │                          │ apps/sidecar (Rust bin)  │
                                  │            │                          │  • per-shared-folder     │
                                  │            │                          │  • read-only/RW scopes   │
                                  │            │                          │  • per-action approval   │
                                  │            │                          │  • local activity/audit  │
                                  │            │                          └─────┬──────────┬─────────┘
                                  │            │                                │ local-first│ cloud-session WS
                                  │            │                  reads/writes  ▼            ▼ (dials sandbox directly)
                                  │            │                          ┌───────────┐  (to Sandbox, see below)
                                  │            │                          │ USER DISK │
                                  │            │                          │ <folder>  │
                                  │            │                          └───────────┘
   ┌──────────────────────────────▼────────────▼─────────────────────────────────────────────────────────────┐
   │                                            CLOUD BACKEND (server trust zone — holds all secrets)           │
   │                                                                                                            │
   │   ┌────────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────────────┐ │
   │   │ services/api (Nest/    │  REST  │ services/gateway          │  WS    │ services/worker              │ │
   │   │ Fastify)               │◄──────►│ (Socket.IO + Redis adapt) │◄──────►│  hosts Agent Engine          │ │
   │   │ • auth/PKCE/sessions   │        │  • /chat  (client stream) │ events │  (plan→act→observe→replan)   │ │
   │   │ • tasks/files/billing  │        │  • /device(sidecar plane) │        │  • risk classifier + approval│ │
   │   │ • risk-gate + approval │        └─────────┬─────────────────┘        │  • context mgmt / cache      │ │
   │   │ • secret broker(decrypt│                  │ enqueue / progress       │  • LlmProvider (Anthropic)   │ │
   │   │   server-side only)    │──enqueue jobs───►│ (BullMQ)                  │      │  tool calls           │ │
   │   └───────┬────────────────┘                  ▼                          └──────┼───────────┬───────────┘ │
   │           │                          ┌──────────────────┐                       │           │             │
   │           │                          │ Redis 7          │                       │           │             │
   │           │                          │ • BullMQ broker  │                       │           │             │
   │           │                          │ • SIO adapter    │                       ▼           ▼             │
   │           ▼                          │ • cache/presence │             ┌──────────────────────────────┐    │
   │   ┌──────────────────┐               └──────────────────┘             │ services/sandbox-orchestrator│    │
   │   │ PostgreSQL 16    │                                                │  container-per-session       │    │
   │   │ • system of      │◄───────────── reads/writes ────────────────────│  (Docker + gVisor)           │    │
   │   │   record         │                                                │   ┌────────────────────────┐ │    │
   │   │ • event log      │                                                │   │ SESSION SANDBOX        │ │    │
   │   │ • audit log      │                                                │   │ • terminal / files     │ │    │
   │   │ • pgvector       │                                                │   │ • Playwright/Chromium  │ │    │
   │   │ • billing/usage  │                                                │   │ • VNC (takeover)       │ │    │
   │   └──────────────────┘                                                │   └───────────▲────────────┘ │    │
   │           ▲                                                           └───────────────┼──────────────┘    │
   │           │ presigned put/get                                                         │ sidecar dials      │
   │   ┌──────────────────┐                                                                 │ session WS         │
   │   │ Object Storage   │                                          (cloud tool path) ◄────┘ directly           │
   │   │ S3 / R2 / MinIO  │                                                                                      │
   │   │ (BlobStore)      │                                          External: Anthropic API (claude-opus-4-8)   │
   │   └──────────────────┘                                          via LlmProvider — key decrypted in-process  │
   └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Reading the diagram:**
- **Clients are thin.** Both shells render the same SPA; the desktop adds native supervision of the Rust sidecar. No client holds the LLM key or any secret.
- **The gateway is the single realtime spine** with two namespaces (`/chat` for users, `/device` for sidecars), fanned out across nodes by the Redis adapter.
- **The worker hosts the engine**, which calls the LLM (key decrypted only in-process), invokes tools, and streams events back through the gateway to the session room.
- **Cloud tool path:** engine → sandbox-orchestrator → session sandbox (terminal/files/browser). **Local tool path:** engine emits a `device_config`; the desktop sidecar performs file/shell work on the user's disk under approval, streaming status back over `/device`.
- **Postgres is the source of truth;** Redis coordinates; object storage holds blobs.

---

## 7.3 Communication matrix

| From → To | Channel | Payload / purpose |
|---|---|---|
| Web/Desktop renderer → API | **REST/HTTPS** (cookie or bearer) | create session, list/fetch, settings, billing, presigned URLs, **approve/deny** an action, **stop** |
| Renderer ↔ Gateway | **WebSocket (Socket.IO `/chat`)**, token in `auth` handshake | stream of `plan`/`tool_call`/`tool_result`/`message`/`approval_request`/`cost_estimate`; client→server `stop`, `approve`, `deny`, `takeover` |
| API → Worker | **BullMQ (Redis)** | enqueue agent run / artifact / deploy / scheduled job; job carries `sessionId`, task, tenancy |
| Worker/Engine → Gateway | **Internal (Redis pub/sub via SIO adapter)** | publish engine events to the session room |
| Engine → Sandbox | **WS / orchestrator API** | run terminal/file/browser tools in the session container |
| Sidecar Supervisor (desktop) ↔ Gateway | **WebSocket (Socket.IO `/device`)** | inbound `device_config` (desired state), outbound `device_status` (actual), debounced + on-change |
| Sidecar (Rust) ↔ Sandbox (cloud mode) | **WS** | direct file/shell tool execution against user disk; desktop app **not** in this data path |
| Engine → Anthropic | **HTTPS (Anthropic SDK)** | LLM completion/stream/tool-calling; key decrypted in-process only |
| API/Worker ↔ Postgres | **TCP (Prisma)** | system-of-record reads/writes, event/audit append, pgvector KNN |
| Services ↔ Object storage | **HTTPS (S3 API)** + presigned URLs to clients | artifact/upload/trace blobs |
| Desktop main ↔ renderer | **Named typed IPC (allowlisted, Zod-validated)** | file dialogs, window controls, deep-link results, sidecar status — **no generic passthrough** |

---

## 7.4 End-to-end task data flow

**Scenario:** A signed-in user types *"Research the top 3 EV chargers under $500, compare them, and save a report to my Desktop"* in the desktop app (local-first enabled).

1. **Submit (renderer → API, REST).** The renderer POSTs `createTask` (cookie/bearer auth). API validates with Zod, creates a `Session` + `Task` row in Postgres (status `PENDING`), writes an initial event, and **enqueues** an agent-run job on BullMQ. Returns `sessionId`.
2. **Subscribe (renderer ↔ Gateway, WS).** The renderer joins the `/chat` room for `sessionId` (token in the handshake `auth`). UI shows the empty two-pane workspace, ready to stream.
3. **Pick up (Worker).** A BullMQ worker claims the job, loads task + workspace context from Postgres, and starts the **Agent Engine** for the session.
4. **Plan (Engine → LLM).** The engine builds a cache-friendly prompt (system + tool ABI as JSON Schema + retrieved memory), calls `LlmProvider.stream` (`claude-opus-4-8`). The model returns a **plan** (decomposed steps). The engine emits a `plan` event → gateway → renderer (left pane renders the step list). Token usage is metered to Postgres.
5. **Cost pre-check (risky/expensive).** Before a multi-step run, the engine emits a `cost_estimate`; if it exceeds the workspace threshold, it emits an `approval_request` and **pauses** until the user approves over `/chat` (or REST).
6. **Act — web search (cloud tool).** Step 1 is a `web_search`/browser tool (risk: low). The engine asks the **sandbox-orchestrator** to run Playwright in the session container; results stream back; the engine emits `tool_call` + `tool_result` events (right "Computer panel" shows the browser activity). Sensitive request data is redacted before logging.
7. **Observe / replan.** The engine feeds tool results back to the model, which refines the comparison; intermediate `message` events stream to the left pane.
8. **Act — write file (LOCAL tool, approval-gated).** The final step writes `report.md` to the user's **Desktop** — a **filesystem write outside any pre-approved scope = risk `high`**. The engine's risk classifier emits an **`approval_request`** ("Agent wants to write `~/Desktop/report.md` — allow?"). The run **pauses**.
9. **Local execution path.** On approval, the engine updates the session's `device_config` (adds the target folder scope). The gateway pushes `device_config` to the desktop **sidecar supervisor** over `/device`; the supervisor (binary already hash-pinned) ensures the **Rust sidecar** is running for that folder; the sidecar writes the file **on the user's real disk**, under read-write scope, and streams a local audit entry + `device_status` back. The desktop app is the *supervisor*, not in the file-write data path.
10. **Verify.** The engine re-reads the artifact (via the sidecar/`read` tool) to confirm it exists and is well-formed; emits a `tool_result` (verified) and a final `message`.
11. **Deliver & persist.** The engine emits a `final_output` event with a link/preview; the renderer shows the deliverable. Every event was appended to the Postgres **event log** (replayable) and the **audit log** (with risk levels + the approval decision). Task status → `COMPLETED`. Usage/cost finalized per task/workspace/user/month.
12. **Stop semantics (any time).** A client `stop` over `/chat` (or REST) sets a kill flag the engine checks between steps and that aborts in-flight tool calls and sidecar ops (epoch-guarded), then marks the task `STOPPED` — satisfying "user can stop any action instantly."

**Cloud-only variant:** if local-first is off (or on web), step 8's write targets the **session sandbox filesystem** and the artifact is uploaded to **object storage** with a presigned download — no sidecar involved.

---

## 7.5 Local-first vs cloud-first execution paths

| Aspect | **Local-first (desktop)** | **Cloud (web or desktop opt-in)** |
|---|---|---|
| File/shell execution | Rust **sidecar** on the user's real disk, per-action approval, RO/RW scopes, OS jail | Inside the **session sandbox** container |
| Data residency | Stays on the user's machine; only what the model needs is sent | In cloud sandbox + object storage |
| Approval | Local approval daemon + cloud risk-gate (both) | Cloud risk-gate + approval over `/chat` |
| Browser tool | Cloud sandbox Playwright (or local "My Browser" delegation, Later) | Cloud sandbox Playwright |
| Kill switch | Losing `/device` supervision stops all sidecars; client `stop` aborts | Client `stop` aborts; sandbox torn down |
| Privacy posture | **Headline differentiator** — no forced cloud round-trip for local files | Standard cloud agent |

Both paths share **one tool ABI** and **one event stream**; the only difference is *where* a tool's executor runs, decided by session mode + per-tool capability + approval.

---

## 7.6 Wire contracts

Authored once in `packages/protocol` (events) and `packages/tool-abi` (tools), consumed by client, gateway, engine, and (contract-mirrored) the sidecar. Illustrative **sketches** (not implementation):

```typescript
// packages/protocol — client/server socket event contracts (Zod-backed)
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface ServerToClientEvents {
  plan:             (e: { sessionId: string; steps: PlanStep[] }) => void;
  message:          (e: { sessionId: string; role: 'assistant'; text: string; partial: boolean }) => void;
  tool_call:        (e: { sessionId: string; callId: string; tool: string; args: unknown; risk: RiskLevel }) => void;
  tool_result:      (e: { sessionId: string; callId: string; ok: boolean; output: unknown; redacted?: boolean }) => void;
  approval_request: (e: { sessionId: string; approvalId: string; action: string; risk: RiskLevel; detail: string }) => void;
  cost_estimate:    (e: { sessionId: string; estUsd: number; estTokens: number; overThreshold: boolean }) => void;
  status:           (e: { sessionId: string; status: TaskStatus }) => void;
  final_output:     (e: { sessionId: string; artifacts: ArtifactRef[]; summary: string }) => void;
}

interface ClientToServerEvents {
  subscribe: (e: { sessionId: string }) => void;
  stop:      (e: { sessionId: string }) => void;                              // instant stop
  approve:   (e: { sessionId: string; approvalId: string; scope?: ScopeGrant }) => void;
  deny:      (e: { sessionId: string; approvalId: string }) => void;
  takeover:  (e: { sessionId: string }) => void;                             // grab the browser
}

// /device namespace — desktop sidecar control plane (declarative reconcile)
interface DeviceConfig {  // cloud → desktop (desired state)
  deviceId: string; configVersion: number;
  sessions: { sessionId: string; folderPath: string; sandboxWsUrl: string }[];
  folders?: { path: string; name: string; mode: 'ro' | 'rw'; allowShell: boolean }[];
}
interface DeviceStatus {  // desktop → cloud (actual state)
  deviceId: string; deviceName: string; appliedConfigVersion: number;
  sessions: { sessionId: string; status: 'idle'|'connecting'|'connected'|'error'; folderPath: string }[];
  folders: { path: string; mode: 'ro'|'rw'; allowShell: boolean }[]; terminalAvailable: boolean;
}

// packages/tool-abi — every tool is typed + risk-tagged; one source feeds the LLM JSON Schema and runtime validation
interface ToolDef<I, O> {
  name: string;
  description: string;
  input: ZodSchema<I>;
  output: ZodSchema<O>;
  risk: RiskLevel;                 // gate high/critical to approval
  surface: 'cloud' | 'local' | 'either';
  execute(input: I, ctx: ToolContext): Promise<O>;
}
```

These sketches commit the *contracts* MVP-P0; concrete tool definitions and the full event taxonomy are owned by the agent/tooling planning docs.

---

## 7.7 Trust boundaries & data classification

- **Renderer (untrusted for secrets).** Holds session/UI state only. Never receives the LLM key, OAuth secrets, or sidecar tokens. IPC is a named, Zod-validated allowlist.
- **Backend trust zone (API/gateway/worker/engine).** The *only* place secrets are decrypted (envelope encryption, §6.20). Enforces tenancy (workspace scoping + RLS backstop), the risk-gate, and audit logging.
- **Sandbox (untrusted code execution).** Runs agent-driven shell/code/browser under gVisor; egress-controlled; no access to backend secrets beyond the per-session scoped credentials it's handed.
- **Sidecar (high-risk, local).** Token-bearing, filesystem-touching; mitigated by codesign+hash-pin, PID lockfile, RO/RW scopes, OS jail, per-action approval, and "disconnect = kill switch."
- **Data classes:** `critical` (LLM/OAuth keys, sidecar tokens) — envelope-encrypted, never logged, masked; `sensitive` (user files, prompts, tool I/O) — minimized to the model, redacted in logs; `operational` (events, metrics) — first-party pipeline, no third-party fingerprinting.

---

## 7.8 Failure, backpressure & scaling

- **Engine loops/stalls:** step budgets, wall-clock + token budgets, loop detection, and a hard kill switch (client `stop` + supervisor disconnect). Jobs are idempotent and resumable from the Postgres event log.
- **Backpressure:** high-frequency `tool_result`/`message` partials are buffered/coalesced in the gateway before Postgres bulk-write; the Redis adapter fans out without per-event DB round-trips.
- **Reconnect:** clients and sidecar use a staged backoff curve (`[1,2,5,10,20,30,60,120,180,240,300]s`) with an epoch-guarded serialized op queue so a stale timer can't resurrect a killed sidecar.
- **Scaling:** API/gateway/worker scale horizontally (stateless + Redis adapter/broker); Postgres scales via read replicas + event/audit partitioning; sandbox pool scales by node + idle-reaping; pgvector → Qdrant escape hatch behind `MemoryStore`; BullMQ → Temporal escape hatch for engine durability.

---

# 34. Folder / File Structure & Rename Strategy

## 34.1 Monorepo layout

```
agentos/                                  # repo root (folder name is cosmetic; see §34.6)
├─ apps/                                  # user-facing deployables (thin clients + native binaries)
│  ├─ web/                                # Next.js static-export SPA (web surface)
│  ├─ desktop/                            # Electron shell (hosts the SAME renderer over app://)
│  └─ sidecar/                            # Rust local operator binary (per shared folder)
│
├─ services/                              # server-side deployables (the brain + plumbing)
│  ├─ api/                                # NestJS/Fastify front door (REST)
│  ├─ gateway/                            # NestJS Socket.IO gateway (/chat + /device)
│  ├─ worker/                             # BullMQ consumers; hosts the agent engine
│  └─ sandbox-orchestrator/              # provisions container-per-session sandboxes
│
├─ packages/                              # shared libraries (the contracts + the moat's reusable core)
│  ├─ brand/                              # ⭐ single source of the product name/identity (rename here)
│  ├─ config/                             # Zod-validated env/config loader (fail-fast)
│  ├─ protocol/                           # client↔server socket event contracts (Zod + inferred types)
│  ├─ tool-abi/                           # typed, risk-tagged tool definitions (one source → LLM JSON Schema + runtime)
│  ├─ agent-engine/                       # plan→act→observe→replan loop, risk classifier, context mgmt
│  ├─ llm/                                # LlmProvider interface + Anthropic adapter (claude-opus-4-8)
│  ├─ db/                                 # Prisma schema, migrations, generated client, repositories
│  ├─ blob-store/                         # BlobStore interface + S3/R2/MinIO + local-FS adapters
│  ├─ memory/                             # MemoryStore interface + pgvector adapter (Qdrant escape hatch)
│  ├─ queue/                              # BullMQ job/queue definitions + typed producers/consumers
│  ├─ ui/                                 # shadcn/Radix components, design tokens (owned source)
│  ├─ desktop-ipc/                        # shared, Zod-validated IPC contract (main ⇆ renderer)
│  ├─ auth/                               # PKCE/session/token logic shared across api + desktop
│  ├─ crypto/                             # envelope encryption helpers (KMS + AES-256-GCM)
│  ├─ logger/                             # structured logging + redaction (tokens/PII)
│  └─ test-utils/                         # Testcontainers helpers, fixtures, contract-test harness
│
├─ infra/                                 # ops & local stack
│  ├─ compose.yaml                        # full local stack (pg+pgvector, redis, minio, api, worker, gateway)
│  ├─ docker/                             # per-service Dockerfiles + sandbox runner image
│  └─ migrations/                         # (if not colocated in packages/db)
│
├─ tooling/                               # repo tooling
│  ├─ eslint-config/  tsconfig/  prettier/
│  └─ scripts/                            # rename script, codegen (zod→json-schema), release
│
├─ docs/                                  # planning + architecture docs (this file lives here)
├─ turbo.json                             # task graph + caching
├─ pnpm-workspace.yaml                    # workspace globs (apps/*, services/*, packages/*)
└─ package.json                           # root scripts, dev deps
```

## 34.2 apps/*
- **`apps/web`** — the SPA. Routes mirror the workspace surfaces (Home/launcher, agent workspace, Projects, Scheduled, Inbox, Library, Connectors, Share/Replay). Imports `packages/ui`, `packages/protocol`, `packages/brand`. No secrets, no Next server features.
- **`apps/desktop`** — Electron main + preload. Modules: `app://` protocol handler + CSP nonce, `agentos://` PKCE deep-link, `WindowManager` (main/quickAsk/child/presenter), tray, shortcuts, **sidecar supervisor** (spawn/verify/reconcile), and the **named IPC allowlist** (imports `packages/desktop-ipc`). Renders `apps/web`'s static export.
- **`apps/sidecar`** — Rust crate. Modules: WS client (Socket.IO), `device_config` reconciler, file ops (RO/RW scoped, path-canonicalized), shell exec under approval, OS jail, local audit stream. Mirrors `packages/protocol`'s `/device` contract.

## 34.3 services/*
- **`api`** — Nest modules: `auth`, `workspaces`, `sessions`, `tasks`, `files`, `connectors`, `billing`, `settings` (encrypted secrets), `approvals`/`risk-gate`. Producers onto `packages/queue`.
- **`gateway`** — Nest WS gateway: `/chat` + `/device` namespaces, Redis adapter, auth-handshake guard, token redaction.
- **`worker`** — bootstraps BullMQ consumers and runs `packages/agent-engine`; owns long agent runs, artifact/deploy jobs, scheduled-task triggers, Wide-Research fan-out (Later).
- **`sandbox-orchestrator`** — `SandboxProvider` impl (Docker+gVisor now, Firecracker later); lifecycle, idle-reaping, resource limits, VNC/takeover wiring.

## 34.4 packages/*
Shared contracts and the reusable core. Key ones: **`brand`** (§34.6), **`protocol`**/**`tool-abi`** (the wire + tool source of truth), **`agent-engine`**, **`llm`**, **`db`**, **`blob-store`**, **`memory`**, **`queue`**, **`ui`**, **`desktop-ipc`**, **`auth`**, **`crypto`**, **`logger`**, **`config`**, **`test-utils`**. Each ships its own `vitest` suite; `protocol`/`tool-abi` additionally ship **contract tests** that both client and server import.

## 34.5 infra, tooling, root
- `infra/compose.yaml` is the one-command local stack and the source of CI's Testcontainers images.
- `tooling/scripts` holds the **rename script** and the **`zod→json-schema` codegen** that keeps the tool ABI the model sees in sync with runtime validation.
- `turbo.json` defines `build → test → lint → e2e` with caching; the `test` task **gates** merges (no module "done" without passing tests).

## 34.6 Centralized rename strategy

Renaming "AgentOS" to anything else must be a **one-file edit + one script run**, not a find-and-replace across the tree.

1. **`packages/brand` is the single source.** It exports a typed constant consumed *everywhere* a human-visible or identifier-level name appears:

```typescript
// packages/brand/src/index.ts  — the ONLY place the name is authored
export const BRAND = {
  appName:       'AgentOS',                 // display name
  appNameShort:  'AgentOS',
  appId:         'com.agentos.desktop',     // Electron appUserModelId / bundle id
  protocol:      'agentos',                 // deep-link scheme: agentos://
  assetScheme:   'app',                     // privileged asset protocol (stays 'app')
  storageDomain: 'agentos.example',         // base domain for hosted artifacts
  supportEmail:  'support@agentos.example',
  copyright:     '© AgentOS',
} as const;
export type Brand = typeof BRAND;
```

2. **No raw brand literals anywhere else.** An ESLint rule (`no-restricted-syntax`) **bans the string literal** `"AgentOS"` (and the scheme/appId literals) outside `packages/brand`. CI fails if a literal sneaks in — so the constant can't be bypassed.
3. **Build-time substitution for non-TS surfaces.** Places that can't import a TS constant — `package.json` `name`/`productName`, `electron-builder` config (`appId`, `productName`, protocol registration), `manifest`/`msix` metadata, i18n default strings, `compose.yaml` container prefixes — read from `BRAND` via a **`tooling/scripts/apply-brand` codegen step** that templates them from a single `brand.config.json` (which itself mirrors `packages/brand`). One values file → all generated manifests.
4. **Deep-link & app-id are derived, not hardcoded.** The Electron shell registers `BRAND.protocol` and sets `BRAND.appId`; the PKCE redirect uses `${BRAND.protocol}://`. Changing the scheme is a one-line `BRAND` edit + `apply-brand` run + re-sign.
5. **Rename procedure (documented in `tooling/scripts/rename.md`):**
   - Edit `packages/brand/src/index.ts` (and the mirrored `brand.config.json`).
   - Run `pnpm brand:apply` (regenerates manifests, builder config, i18n defaults, compose prefixes).
   - Run `pnpm -w build && pnpm -w test` — the ESLint brand-literal guard + contract tests confirm nothing hardcoded the old name.
   - Optionally rename the repo *folder* (cosmetic only — no code references it).

Result: the product is **trivially renameable via a single constant**, enforced by lint + codegen, with zero scattered literals.

---

# Test scenarios & acceptance criteria

These cover *this document's* scope (stack choices realized as scaffolding, topology wiring, and rename mechanics). Per-feature engine/tool tests live in their own planning docs.

### A. Monorepo & contracts (Phase 0)
- **Scenario A1 — clean bootstrap.** Fresh clone → `pnpm install` → `pnpm -w build` builds every workspace.
  **Accept:** all `apps/*`, `services/*`, `packages/*` build; `tsc --noEmit` passes with `strict`; Turborepo cache hit on a no-op rebuild.
- **Scenario A2 — contract single-source.** Change a field in `packages/protocol`.
  **Accept:** type errors surface in *both* a client and a server consumer at compile time (proves shared types); contract tests fail until both sides updated.
- **Scenario A3 — tool ABI ↔ JSON Schema parity.** Edit a Zod tool input in `packages/tool-abi`.
  **Accept:** `zod→json-schema` codegen regenerates the LLM schema; a parity test asserts runtime-validated shape equals the model-facing schema (no drift).

### B. Realtime & topology (Phase 1)
- **Scenario B1 — end-to-end stream.** Submit a task; subscribe to `/chat`.
  **Accept:** `plan` arrives before any `tool_call`; `tool_result` correlates by `callId`; `final_output` ends the stream; every event is persisted to the event log and replayable.
- **Scenario B2 — multi-node fan-out.** Run two gateway nodes behind the Redis adapter; client on node A, engine publishing via node B.
  **Accept:** client receives all events (proves Redis fan-out, no stickiness needed).
- **Scenario B3 — instant stop.** Send `stop` mid-run.
  **Accept:** in-flight tool aborts within one step boundary; task → `STOPPED`; no further events; audit records the stop.

### C. Risk-gate & approval (Phase 1–2)
- **Scenario C1 — high-risk gating.** Agent attempts a filesystem write outside any approved scope.
  **Accept:** an `approval_request` (risk `high`) is emitted and the run **pauses**; nothing executes until `approve`; `deny` aborts the step cleanly; both decisions are audited.
- **Scenario C2 — cost pre-estimate.** Trigger a task whose estimate exceeds the workspace threshold.
  **Accept:** `cost_estimate{overThreshold:true}` is emitted and the run pauses for approval before spending.

### D. Desktop shell hardening (Phase 0/6)
- **Scenario D1 — IPC allowlist.** Renderer attempts an unlisted IPC channel.
  **Accept:** rejected; only named, Zod-validated methods succeed; no generic `invoke` passthrough exists.
- **Scenario D2 — PKCE deep-link.** Complete `agentos://?code=` login.
  **Accept:** the one-time code is exchanged over HTTPS with the PKCE verifier; a plaintext token never appears in the deep-link; state/nonce mismatch is rejected.
- **Scenario D3 — engine uniformity.** Run the shared E2E UI suite on web (Chromium) and on the Electron renderer.
  **Accept:** identical results (validates the single-engine rationale for choosing Electron).
- **Scenario D4 — CSP/CORS posture.** Inspect served headers.
  **Accept:** full CSP (`default-src`/`connect-src`/`object-src 'none'`/nonce'd `script-src`); CORS scoped to our origins only (no `<all_urls>` strip).

### E. Sidecar / local-first (Phase 3)
- **Scenario E1 — integrity gate.** Tamper with the sidecar binary.
  **Accept:** codesign-verify + hash-pin check fails; the shell refuses to spawn.
- **Scenario E2 — scope enforcement.** Agent attempts a write to a read-only folder, then a path-traversal (`../`) outside the shared folder.
  **Accept:** both refused by the sidecar (canonicalized path check + RO scope); audited.
- **Scenario E3 — kill switch.** Drop the `/device` connection mid-operation.
  **Accept:** all sidecars stop; epoch guard prevents a stale timer from resurrecting them; `device_status` reflects the reset on reconnect.
- **Scenario E4 — local-first privacy.** Run a local file task with cloud disabled.
  **Accept:** file bytes never leave the machine (only model-necessary content is sent); object storage is untouched.

### F. Secrets & data (Phase 1)
- **Scenario F1 — key never in frontend.** Build the web + desktop bundles; grep the artifacts.
  **Accept:** the LLM API key (and any secret) appears in **no** client artifact; settings round-trip stores it envelope-encrypted; a DB dump yields only ciphertext.
- **Scenario F2 — log redaction.** Force tokens/PII through the logger.
  **Accept:** tokens/PII are redacted in all log sinks and in `device`/`chat` URLs.

### G. Rename mechanics (Phase 0)
- **Scenario G1 — single-constant rename.** Change `packages/brand` + `brand.config.json` to a new name; run `pnpm brand:apply && pnpm -w build && pnpm -w test`.
  **Accept:** display name, `appId`, deep-link scheme, manifests, and i18n defaults all reflect the new name; the ESLint brand-literal guard confirms no stray old-name literals; all tests pass.

### H. Local stack & CI (Phase 0)
- **Scenario H1 — one-command stack.** `docker compose up` from a clean machine.
  **Accept:** Postgres+pgvector, Redis, MinIO, API, gateway, worker come up healthy; a smoke task runs end-to-end against the local stack.
- **Scenario H2 — test gate.** Mark a module "done" with a failing test.
  **Accept:** Turborepo `test` task fails the pipeline; merge is blocked (enforces "no module done without passing tests").

---

# 6-line summary

1. **Monorepo/lang/contracts:** pnpm + Turborepo, TypeScript-strict everywhere (Rust for the sidecar), with Zod-authored shared `protocol`/`tool-abi` packages as the single client↔server↔tool source of truth.
2. **Frontend:** one Next.js App Router **static-export** SPA (React 19) rendered on both web and desktop, Tailwind + shadcn/ui (owned design tokens), Zustand for the socket stream + TanStack Query for server state.
3. **Backend:** NestJS-on-Fastify API + Socket.IO gateway (`/chat` + `/device`, Redis adapter) + BullMQ workers hosting the agent engine, on PostgreSQL 16 (Prisma) with pgvector, Redis, and an S3/R2/MinIO `BlobStore`.
4. **Agent/LLM:** `claude-opus-4-8` via Anthropic behind a clean `LlmProvider` abstraction; key encrypted at rest (envelope/KMS), decrypted only server-side, never in any client bundle; cost/token metered with context-management + prompt-caching.
5. **Execution/security:** container-per-session sandbox (Docker + gVisor; Firecracker later) for cloud tools, a hardened Rust sidecar (codesigned + hash-pinned, RO/RW scopes, per-action approval) for local-first, every action risk-tagged with approval gating and an instant kill switch.
6. **Desktop verdict — ELECTRON (hardened), not Tauri:** chosen for the proven, directly portable sidecar-supervision + `app://`/CSP-nonce blueprint, dual NSIS+MSIX auto-update, and **single-engine web/desktop render parity**; Tauri's smaller bundle and safer defaults are explicitly low-priority here and neutralized by our itemized hardening checklist — kept as a documented v2 escape hatch behind a shell-agnostic renderer.
