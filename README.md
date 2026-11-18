# AgentOS

> Production-grade, security-first **AI agent operating platform**. A natural-language task is
> understood, planned, decomposed, routed to tools, executed across cloud and _approved_ local
> resources, streamed live, audited, and delivered — through both a **web app** and a real
> **Windows desktop app**. Default model: **Claude Opus** (`claude-opus-4-8`) behind a clean
> provider abstraction.

`AgentOS` is a temporary name (rename in one place — see below). The original plan lives in
**[docs/PLAN.md](docs/PLAN.md)**.

---

## What's built

A working end-to-end agent platform. Every increment ships with tests and an adversarial
multi-agent code review.

**Agent core**

- LLM provider abstraction (Anthropic `claude-opus-4-8`, adaptive thinking + effort) with a
  network-free `MockProvider` for tests; token + USD cost metering.
- ReAct engine: plan → act → observe → complete, with step/cost budgets, an **instant-stop kill
  switch**, **risk-gated approvals** (`low|medium|high|critical`; high/critical pause for approval),
  and error-budget recovery. Emits a typed, seq-ordered event stream.
- **Tools** (registry, Zod-validated, per-tool timeout, risk-tagged): scoped filesystem
  (realpath-guarded, no symlink escape), **SSRF-guarded HTTP fetch** (streamed, size-capped),
  **headless browser** (Playwright: navigate/read/click/screenshot, SSRF-guarded), and an
  **isolated Docker sandbox** for code execution (no network, caps dropped, CPU/mem/PID/fsize
  limits, container-side timeout-kill, bounded output).

**Task lifecycle**

- Create → run → live event stream → durable persistence (events, tool calls, approvals) →
  usage/cost records. **BullMQ queue + in-process worker** (durable, retryable; inline fallback).
- **Socket.IO** live streaming (cookie-auth handshake + workspace-membership gate, backlog replay
  then live, stop/approve/deny control messages). Orphaned-task reaper on boot.

**Platform**

- Auth (email/password, scrypt, session cookies; desktop PKCE), **workspaces + RBAC + tenancy
  isolation**, **collaboration** (invite/role/remove with a role-superiority model), envelope-
  encrypted **secrets vault** (the Anthropic key, never exposed to the client), **hash-chained
  tamper-evident audit log**, pgvector store.
- **Automations** (cron, self-running agents), **Skills** (reusable `{{input}}` prompt recipes),
  **Projects** (group tasks), **Artifacts** (download files the agent produced),
  **Insights** (cost/token dashboard + audit viewer), **Public API** (`/v1`, API-key auth).

**Apps**

- Web SPA (Next.js static export): auth, task composer, live stream view, and panels for Settings,
  Automations, Skills, Members, API keys, Insights.
- Hardened Electron desktop shell (`app://` + per-request CSP nonce, sandboxed renderer, typed IPC
  allowlist) loading the same web export, wired to the API over CSP-allowed http+ws.

**Hardening**

- helmet security headers, request body-size limit, production CORS allowlist, auth rate limiting
  (tighter on login) + public-API throttle, SSRF guards, sandbox resource caps.

---

## Prerequisites

- **Node.js ≥ 20** (developed on 24) · **pnpm 11** (`npm install -g pnpm`)
- **Docker** (for the local Postgres/Redis/MinIO stack, and for the agent code sandbox)

## Setup

```bash
pnpm install
docker compose -f infra/compose.yaml up -d        # Postgres :5432, Redis :6380, MinIO :9000/9001
pnpm --filter @agentos/db exec prisma migrate deploy
```

## Run it

```bash
# API (mock LLM — no key needed; add EXECUTION_MODE=queue for the durable worker)
API_PORT=4000 LLM_MODE=mock \
  DATABASE_URL=postgresql://agentos:agentos@localhost:5432/agentos \
  node services/api/dist/main.js            # build first: pnpm --filter @agentos/api build

# Web
pnpm --filter @agentos/web build && npx serve apps/web/out -l 3000   # http://localhost:3000

# Desktop (build the web export + shell, then launch Electron)
pnpm --filter @agentos/web build && pnpm --filter @agentos/desktop build && pnpm --filter @agentos/desktop start

# Package a Windows installer (build web + bundle the shell + NSIS installer)
pnpm package:desktop      # -> apps/desktop/release/AgentOS Setup <version>.exe
```

The desktop is a thin client: it bundles the web UI (served over `app://`) and talks to a running
API at `AGENTOS_API_ORIGIN` (default `http://localhost:4000`). Packaging is unsigned by default —
configure code signing for distribution. On Windows, `electron-builder` extracts a signing
toolchain that contains symlinks; if the build fails with _"a required privilege is not held"_,
enable **Developer Mode** (or run the terminal as Administrator) once, or build in CI.

To use the **real** model: start the API without `LLM_MODE=mock`, then enter your Anthropic key in
the web UI under **Settings** (stored envelope-encrypted, never returned to the client).

### Public API

```bash
# Mint a key in the UI (API keys panel), then:
curl -X POST http://localhost:4000/v1/tasks \
  -H "Authorization: Bearer aos_..." -H "content-type: application/json" \
  -d '{"title":"Summarize","prompt":"Summarize the latest AI news."}'
curl http://localhost:4000/v1/tasks -H "Authorization: Bearer aos_..."
```

## Key environment variables (server)

| Var                                                                   | Default              | Purpose                                               |
| --------------------------------------------------------------------- | -------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                                                        | —                    | Postgres connection                                   |
| `REDIS_URL`                                                           | —                    | Redis (required for `queue` mode + automations)       |
| `LLM_MODE`                                                            | `live`               | `mock` runs a scripted provider (no key)              |
| `EXECUTION_MODE`                                                      | `inline`             | `queue` runs tasks via BullMQ worker                  |
| `MASTER_ENCRYPTION_KEY`                                               | dev key              | base64 32-byte master key (required in production)    |
| `ENABLE_BROWSER_TOOLS`                                                | `true`               | Playwright browser tools (lazy launch)                |
| `ENABLE_SANDBOX` / `SANDBOX_IMAGE`                                    | `false` / `alpine:3` | Docker code-execution sandbox                         |
| `CORS_ORIGINS`                                                        | reflect (dev)        | comma-separated allowlist; **required in production** |
| `AUTH_RATE_LIMIT` / `AUTH_LOGIN_RATE_LIMIT` / `PUBLIC_API_RATE_LIMIT` | 100 / 10 / 120       | per-IP throttles                                      |
| `REAP_STALE_TASKS_ON_BOOT`                                            | `true`               | fail orphaned running tasks on boot (single-replica)  |

## Common commands (repo root)

```bash
pnpm build · pnpm test · pnpm typecheck · pnpm lint · pnpm scan:secrets · pnpm ci
```

Live-dependency integration tests + e2e are gated on Postgres/Redis/Chromium/Docker being present
and skip cleanly otherwise. CI provisions Postgres + Redis, installs Chromium, and runs the HTTP
e2e suite (auth, workspaces, secrets, tasks, streaming, automations, artifacts, skills, public API)
against a queue-mode server.

## Monorepo layout

```
apps/        web (Next.js SPA)  ·  desktop (hardened Electron)
services/    api (NestJS on Fastify: auth, workspaces, tasks, queue, events, automations,
             skills, artifacts, usage, api-keys, secrets, audit)
packages/    brand · protocol · tool-abi · config · crypto · auth · db (Prisma) · llm ·
             agent-engine · tools
infra/       docker compose (Postgres+pgvector, Redis, MinIO)
docs/        plan, architecture, DB & API references, feature matrix
```

## Renaming the product

The product name lives in **one** place:

1. Edit `packages/brand/src/index.ts` (the `BRAND` constant).
2. `pnpm --filter @agentos/brand build && pnpm brand:apply`.
3. `pnpm build && pnpm test` — the ESLint brand-literal guard + rename-guard test confirm nothing
   hard-coded the old name.

## Security posture

- Secrets are **server-only**; `pnpm scan:secrets` fails the build if any reach a client bundle.
  The LLM API key is **envelope-encrypted** (AES-256-GCM) and never returned over HTTP.
- Multi-tenant isolation is enforced on every workspace-scoped route (RBAC guard + tenancy checks);
  member management uses role superiority (a non-owner can only manage/assign roles below their own).
- Every agent action carries a **risk level**; high/critical require approval. Tools are SSRF- and
  sandbox-hardened. The audit log is hash-chained and tamper-evident.
- The desktop renderer is sandboxed with a typed IPC allowlist and a per-request CSP nonce.

### Deferred (tracked)

Postgres row-level security (defense-in-depth behind the tested app-level tenancy), cross-process
stop/approval signaling (multi-replica; single-replica is unaffected), MCP connectors (pending SDK
stabilization), per-key API quotas, and `web_search`/knowledge-RAG (need an external search /
embeddings provider).
