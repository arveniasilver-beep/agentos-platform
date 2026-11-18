# AgentOS — API Endpoint Draft: REST + WebSocket (§33)

> **Status:** Planning only. Request/response shapes are Zod-backed **sketches**, not final contracts.
> **Stack:** NestJS-on-Fastify REST (`services/api`) + Socket.IO v4 gateway (`services/gateway`, Redis adapter) — per `01-stack-and-system-architecture.md` §6.6, §6.11.
> **Validation:** every body/param/event validated with Zod (`packages/protocol`, `packages/tool-abi`) — §6.17. One schema = one type = one validator.
> **Auth surfaces:** web = HTTP-only Secure SameSite **cookie** session; desktop = **PKCE** deep-link (`agentos://?code=`) → token exchange over HTTPS; sockets/sidecar = short-lived access token in the Socket.IO `auth` **handshake** (never query string); public API = hashed API key (§6.18).
> **Risk model:** every state-changing action carries a `RiskLevel` (`low|medium|high|critical`); `high`/`critical` require an **approval** before execution; the user can **stop instantly** (§00 hard rules).
> **Masking:** sensitive values masked in responses, logs, and the wire (§7.7). Secrets are **never** returned (only `last_four`).
> **Phase tags** conform to `00-scope-and-phases.md`: **MVP** = P1–P4; **LATER** = P5–P13.
> **Versioning:** all REST under `/api/v1`. WS namespaces `/chat` and `/device` (§6.11).

---

## 0. Conventions

- **Base path:** `/api/v1`. JSON in/out (`application/json`); large blobs via **presigned URLs**, never streamed through the API.
- **Auth header / cookie:**
  - Web → `Cookie: ao_session=<httponly>` (CSRF token required on mutations via `X-CSRF-Token`).
  - Desktop/service → `Authorization: Bearer <access_token>` (short-lived; rotating refresh out-of-band).
  - Public API → `Authorization: Bearer ak_live_<id>.<secret>` (hashed-verified) — §15.
- **Tenancy:** workspace selected via path (`/workspaces/:wsId/...`) or `X-Workspace-Id`; every handler enforces membership (guard) + RLS backstop.
- **Errors:** uniform envelope `{ error: { code, message, details? } }`; codes: `unauthorized`, `forbidden`, `not_found`, `validation_failed`, `rate_limited`, `approval_required`, `budget_exceeded`, `conflict`.
- **Idempotency:** mutating POSTs accept `Idempotency-Key` header.
- **Pagination:** cursor-based `?cursor=&limit=` → `{ items, nextCursor }`.
- **Risk/permission notes** appear per-endpoint as **[risk: …]** and **[scope: …]**.
- **Audit:** every privileged mutation writes an `audit_logs` row (§00 hard rule).

### Endpoint group index
1. Auth · 2. Workspaces · 3. Projects · 4. Tasks · 5. Tools · 6. Files · 7. Artifacts · 8. Automations · 9. Integrations · 10. MCP · 11. Skills · 12. Collaboration · 13. Admin/Settings · 14. Memory/Data · 15. Public API · 16. Webhooks · 17. WebSocket (`/chat`, `/device`) · 18. Public-API auth + rate-limit design.

---

## 1. Auth — **MVP P2**

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/auth/register` | public | `{ email, password, displayName }` → `{ userId }`. Argon2id hash. **[risk: low]** |
| POST | `/api/v1/auth/login` | public | `{ email, password }` → sets `ao_session` cookie; `{ user, workspaces[] }`. CSRF token issued. |
| POST | `/api/v1/auth/logout` | cookie | clears session; audited. |
| GET | `/api/v1/auth/session` | cookie/bearer | → `{ user, activeWorkspaceId }`. |
| POST | `/api/v1/auth/refresh` | refresh token | rotates access+refresh; old refresh revoked. |
| **PKCE (desktop)** | | | |
| GET | `/api/v1/auth/pkce/authorize` | public | params `client_id, code_challenge, code_challenge_method=S256, state, redirect=agentos://` → browser login → redirects to `agentos://?code=<one-time>&state=`. **One-time code only; no token in deep-link** (§6.18). |
| POST | `/api/v1/auth/pkce/token` | public | `{ code, code_verifier, state }` → `{ accessToken, refreshToken, expiresIn }` over HTTPS. Validates `state`/nonce; single-use code. **[risk: high — token issuance, audited]** |
| POST | `/api/v1/auth/pkce/revoke` | bearer | revoke a device's tokens (device-bound `deviceId`). |

**Test/acceptance:** PKCE one-time code exchanged over HTTPS; plaintext token never in the deep-link; `state`/nonce mismatch rejected (§D2). Web token never readable by renderer JS (HTTP-only cookie).

---

## 2. Workspaces — **MVP P1**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/workspaces` | session | list memberships → `{ items:[{ id,name,slug,role }] }`. |
| POST | `/api/v1/workspaces` | session | `{ name }` → creates workspace; caller = `owner`. **[risk: low]** |
| GET | `/api/v1/workspaces/:wsId` | member | → workspace + settings (budget caps, cost threshold, risk policy). |
| PATCH | `/api/v1/workspaces/:wsId` | admin+ | update name/budget/risk policy. **[scope: workspace.admin] [risk: medium]** |
| DELETE | `/api/v1/workspaces/:wsId` | owner | soft-delete. **[risk: high — approval-gated in UI]** |
| GET | `/api/v1/workspaces/:wsId/members` | member | list members + roles. |
| POST | `/api/v1/workspaces/:wsId/members` | admin+ | `{ email, role }` invite. **[scope: members.write]** |
| PATCH | `/api/v1/workspaces/:wsId/members/:userId` | admin+ | change role. |
| DELETE | `/api/v1/workspaces/:wsId/members/:userId` | admin+ | remove member. |

---

## 3. Projects — **MVP-lite P1** (depth LATER P7)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/workspaces/:wsId/projects` | member | list. |
| POST | `/api/v1/workspaces/:wsId/projects` | member | `{ name, description?, budgetCapUsd? }`. |
| GET | `/api/v1/projects/:projectId` | member | project + files + instructions. |
| PATCH | `/api/v1/projects/:projectId` | member | update; budget/permission profile. |
| DELETE | `/api/v1/projects/:projectId` | admin+ | archive. |
| GET | `/api/v1/projects/:projectId/files` | member | linked files. |
| POST | `/api/v1/projects/:projectId/files` | member | `{ fileId }` attach. |
| DELETE | `/api/v1/projects/:projectId/files/:fileId` | member | detach. |
| **LATER P7** | | | |
| GET/POST/PATCH/DELETE | `/api/v1/projects/:projectId/instructions` | member | standing instructions (injected into prompts). |
| GET/POST/DELETE | `/api/v1/projects/:projectId/members` | admin+ | project-level membership. |

---

## 4. Tasks — **MVP P2** (the core loop)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/workspaces/:wsId/tasks` | member | **Create task.** `{ prompt, projectId?, mode?: 'cloud'\|'local_first', budgets?: { step?, token?, costUsd? } }` → `{ taskId, status:'pending' }`. Enqueues agent-run job; returns `sessionId` (= taskId) to subscribe on `/chat`. **[risk: low to create; per-step risk gated at runtime]** |
| GET | `/api/v1/tasks/:taskId` | member | task + plan + status + budgets + cost so far. |
| GET | `/api/v1/tasks/:taskId/steps` | member | step list with status/risk/attempts. |
| GET | `/api/v1/tasks/:taskId/logs` | member | paginated event stream (replay source); masked. `?cursor=&limit=`. |
| GET | `/api/v1/tasks/:taskId/tool-calls` | member | tool-call records (masked args/output). |
| POST | `/api/v1/tasks/:taskId/stop` | member | **Instant stop.** Sets kill flag + bumps epoch; aborts in-flight tool/sidecar ops; → `STOPPED`. **[risk: low — always allowed; satisfies §00 kill switch]** |
| POST | `/api/v1/tasks/:taskId/pause` · `/resume` | member | pause/resume between steps. |
| POST | `/api/v1/tasks/:taskId/replan` | member | force a replan from current state. **[risk: medium]** |
| GET | `/api/v1/tasks/:taskId/cost-estimate` | member | pre-flight `{ estTokens, estUsd, overThreshold }`. |
| **Approvals (risk-gate)** — **MVP P2** | | | |
| GET | `/api/v1/tasks/:taskId/approvals` | member | pending/decided approvals. |
| POST | `/api/v1/approvals/:approvalId/approve` | member | `{ scopeGrant? }` → unblocks the gated step (e.g. grants a folder rw scope). **[risk: mirrors the gated action; decision audited]** |
| POST | `/api/v1/approvals/:approvalId/deny` | member | aborts the step cleanly; audited. |
| GET | `/api/v1/tasks/:taskId/replay` | member | replay manifest (ordered event stream) for the Replay viewer. **MVP-lite P3.** |

**Risk/permission notes:** task creation is low-risk; the **engine** classifies each step at runtime and emits `approval_request` for `high`/`critical` (e.g. filesystem write outside an approved scope, destructive shell command, external send). The REST approve/deny endpoints mirror the `/chat` `approve`/`deny` events — both paths converge on the same `approvals` row.

**Test/acceptance:** `plan` precedes any `tool_call`; high-risk step pauses until `approve`; `stop` halts within one step boundary; cost over threshold pauses for approval (§B1/B3/C1/C2).

---

## 5. Tools — **MVP P2** (registry is read-only reflection of `packages/tool-abi`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/tools` | member | list registered tools → `{ items:[{ name, description, risk, surface, inputSchema(JSON Schema), permissionScope }] }`. Source of truth = `tool-abi`; JSON Schema generated via `zod→json-schema`. |
| GET | `/api/v1/tools/:name` | member | single tool definition. |
| GET | `/api/v1/workspaces/:wsId/tool-permissions` | member | per-tool revocable permission scopes for the workspace. |
| PATCH | `/api/v1/workspaces/:wsId/tool-permissions/:name` | admin+ | grant/revoke/allow-with-approval per tool. **[scope: tools.admin] [risk: high — changes agent capability]** |

> Tools are **not** invoked via REST by clients — only the engine executes them (in sandbox or via sidecar). These endpoints expose the catalog + per-tool permissions for the UI and risk-gate.

---

## 6. Files — **MVP P2**

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/workspaces/:wsId/files/presign-upload` | member | `{ name, mimeType, sizeBytes }` → `{ fileId, uploadUrl, headers }`. Client PUTs bytes directly to object storage (presigned). **Blobs never traverse the API.** |
| POST | `/api/v1/files/:fileId/finalize` | member | confirm upload; server `head`s the blob, records `sha256`. |
| GET | `/api/v1/files/:fileId` | member | metadata. |
| GET | `/api/v1/files/:fileId/presign-download` | member | → time-boxed `downloadUrl`. **[risk: low; local-first files return a sidecar-mediated handle, not a cloud URL]** |
| GET | `/api/v1/workspaces/:wsId/files` | member | list/search (`?q=`). |
| DELETE | `/api/v1/files/:fileId` | member | soft-delete; blob GC async. |
| POST | `/api/v1/files/:fileId/chunk` | member (engine) | trigger chunk+embed for RAG (context mgmt). Writes `file_chunks` (+pgvector). **MVP P2.** |

---

## 7. Artifacts — **MVP-lite P2**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/workspaces/:wsId/artifacts` | member | Library list (`?kind=`). |
| GET | `/api/v1/artifacts/:artifactId` | member | artifact + version list. |
| GET | `/api/v1/artifacts/:artifactId/versions` | member | versions. |
| GET | `/api/v1/artifacts/:artifactId/versions/:version/download` | member | presigned download of a specific version. |
| POST | `/api/v1/artifacts/:artifactId/versions` | member (engine) | add a new version `{ blobKey, sha256, notes? }`. |
| **LATER (public share)** | | | |
| POST | `/api/v1/artifacts/:artifactId/share` | member | `{ public:true }` → `{ shareSlug }`. **[risk: high — exposes content; masking applied to replay]** |
| GET | `/api/v1/share/:shareSlug` | public | masked public replay/preview (LATER P7). |

---

## 8. Automations — **LATER P6**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET/POST | `/api/v1/workspaces/:wsId/automations` | member | list/create `{ name, triggerType, cronExpr?, promptTemplate, approvalPolicy?, dryRun? }`. |
| GET/PATCH/DELETE | `/api/v1/automations/:id` | member | manage; disabling stops future runs immediately. **[risk: medium]** |
| POST | `/api/v1/automations/:id/dry-run` | member | preview planned actions without executing. |
| POST | `/api/v1/automations/:id/run` | member | trigger now (manual). |
| GET | `/api/v1/automations/:id/runs` | member | run history → `automation_runs`. |

---

## 9. Integrations (connectors) — **LATER P7** (OAuth P10)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/workspaces/:wsId/integrations` | member | list connected. |
| POST | `/api/v1/workspaces/:wsId/integrations/:kind/connect` | admin+ | starts OAuth in a **sandboxed child window**; server brokers the callback. Tokens stored in `secrets` (server-side). **[risk: high — grants external access] [scope: integrations.write]** |
| GET | `/api/v1/integrations/oauth/callback` | public (signed state) | OAuth redirect target; exchanges code server-side; never exposes token to renderer. |
| DELETE | `/api/v1/integrations/:id` | admin+ | revoke; token wiped from `secrets`. |

---

## 10. MCP — **LATER P10**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET/POST | `/api/v1/workspaces/:wsId/mcp` | admin+ | list/install MCP server `{ name, transport, endpoint?\|command?, permissionScopes }`. Runs **sandboxed**; tools surface through `/tools` with risk tags. **[risk: critical — adds executable tools] [scope: mcp.admin]** |
| PATCH/DELETE | `/api/v1/mcp/:id` | admin+ | enable/disable/uninstall; per-server scopes + risk overrides. |
| GET | `/api/v1/mcp/:id/tools` | member | tools exposed by this connector. |

---

## 11. Skills — **LATER P7**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET/POST | `/api/v1/workspaces/:wsId/skills` | member | list/create parameterized task graphs `{ name, graph, parameters, visibility }`. |
| GET/PATCH/DELETE | `/api/v1/skills/:id` | member | manage; versioned. |
| POST | `/api/v1/skills/:id/run` | member | `{ params }` → creates a task from the skill graph. **[risk: inherits graph step risks]** |

---

## 12. Collaboration — **LATER P7**

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/tasks/:taskId/collab/start` | member | open a shared session → `{ sessionId }`. |
| POST | `/api/v1/collab/:sessionId/invite` | host | `{ userId, role }` permission-scoped. |
| POST | `/api/v1/collab/:sessionId/end` | host | end session. |
| GET | `/api/v1/collab/:sessionId` | collaborator | session + collaborators + presence. |
| *(presence/comments stream over `/chat` collaboration events)* | | | |

---

## 13. Admin / Settings — **MVP (settings P1) / Admin console LATER P7**

| Method | Path | Auth | Notes |
|---|---|---|---|
| **Settings (MVP P1)** | | | |
| GET | `/api/v1/workspaces/:wsId/settings` | admin+ | non-secret settings; secrets show only `{ type, label, lastFour }`. |
| PUT | `/api/v1/workspaces/:wsId/settings/llm-key` | admin+ | `{ provider:'anthropic', apiKey }` → stored **envelope-encrypted** in `secrets`; **never echoed back**. **[risk: critical — secret material] [scope: settings.secrets]** |
| DELETE | `/api/v1/workspaces/:wsId/settings/llm-key` | admin+ | remove key. |
| PUT | `/api/v1/workspaces/:wsId/settings/budgets` | admin+ | `{ budgetCapUsd, costThresholdUsd }`. |
| GET | `/api/v1/workspaces/:wsId/usage` | member | usage/cost rollups per task/user/month (from `usage_records`/`cost_records`). **MVP P2.** |
| **Admin console (LATER P7)** | | | |
| GET | `/api/v1/admin/workspaces/:wsId/audit` | admin+ | query audit log (`?action=&from=&to=`). **[scope: admin.audit]** |
| POST | `/api/v1/admin/workspaces/:wsId/audit/export` | admin+ | tamper-evident export (hash chain). |
| GET/PATCH | `/api/v1/admin/workspaces/:wsId/roles` | owner | RBAC role management. |
| GET/PATCH | `/api/v1/admin/workspaces/:wsId/policy` | owner | budget/risk policy. |
| GET | `/api/v1/admin/workspaces/:wsId/notifications` | member | inbox (approvals, results, questions). **MVP-lite P3 (approvals).** |

---

## 14. Memory & Data providers — **LATER P7/P10**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET/POST/DELETE | `/api/v1/workspaces/:wsId/memory` | member | memory items `{ kind, content, shareToModel }`. Privacy control on what reaches the model. **[risk: medium — affects prompts]** |
| POST | `/api/v1/workspaces/:wsId/memory/search` | member (engine) | vector KNN over `vector_documents` (tenant-scoped). |
| GET/POST/DELETE | `/api/v1/workspaces/:wsId/data-providers` | admin+ | external read-scoped data sources; credentials in `secrets`. **[risk: high]** |

---

## 15. Public API — **LATER P10**

> Same REST surface (subset) authenticated by **API key** instead of cookie/PKCE. Scoped, rate-limited, webhook-backed.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/keys` | admin+ (console) | issue key `{ scopes[], expiresAt? }` → returns plaintext **once** (`ak_live_<id>.<secret>`); stored **hashed**. **[risk: critical]** |
| GET/DELETE | `/api/v1/keys/:id` | admin+ | list/revoke (sets `revokedAt`). |
| POST | `/api/v1/pub/tasks` | api key (`tasks:write`) | create a task programmatically; webhook on completion. |
| GET | `/api/v1/pub/tasks/:id` | api key (`tasks:read`) | task status/result. |
| GET | `/api/v1/pub/files/:id/download` | api key (`files:read`) | presigned download. |
| POST | `/api/v1/pub/webhooks` | api key | register `{ url, events[], secret }` for delivery. |

### 15.1 Public-API key auth + rate-limit design
- **Format:** `ak_live_<publicId>.<secret>`. Server looks up `publicId` (indexed), verifies `secret` against `hashedKey` (argon2/sha256 constant-time). Plaintext shown only at creation; never stored.
- **Scopes:** least-privilege strings (`tasks:read`, `tasks:write`, `files:read`, `artifacts:read`, `webhooks:write`); enforced by a guard per route. A `critical` action via public API is **always** approval-gated (no auto-authorize of high/critical).
- **Rate limits:** token-bucket in **Redis** keyed by `(apiKeyId, route-class)`. Tiers: `standard` (e.g. 60 req/min, 1k/day), `elevated`, `enterprise`. Burst + sustained limits; `429` with `Retry-After` + `X-RateLimit-{Limit,Remaining,Reset}` headers. Task-creation routes additionally gated by workspace **budget cap** (`budget_exceeded` error).
- **Abuse controls:** per-key + per-workspace caps; webhook URLs validated (no SSRF to internal ranges); idempotency keys honored; all calls audited with `actorType='api_key'`.

---

## 16. Webhooks — **LATER P10** (inbound triggers + outbound delivery)

| Direction | Path / event | Auth | Notes |
|---|---|---|---|
| Inbound | `POST /api/v1/hooks/:workflowTriggerId` | HMAC signature (`X-AO-Signature`, secret in `secrets`) | event → task (sender allowlist; approval-before-execute). Maps to `workflow_triggers`. **[risk: high — external task creation]** |
| Inbound | `POST /api/v1/hooks/mail/:address` | inbound-mail provider HMAC | mail-to-task (allowlisted senders). **LATER P8.** |
| Outbound | delivery to registered `{ url }` | HMAC-signed payload | `task.completed`, `task.failed`, `approval.requested`, `artifact.created`. Signed with the registration `secret`; retried with backoff; delivery logged. |

---

## 17. WebSocket / Socket.IO — **MVP P1**

Two namespaces (§6.11). Token in the **handshake `auth` object** (never query string); redacted in logs. Rooms keyed by `sessionId` (= `taskId`) for precise fan-out + replay-viewer joins. Typed contracts from `packages/protocol`.

### 17.1 `/chat` namespace (user ↔ agent stream)

**Server → Client events** (live task progress, browser live-view, approval prompts):
```typescript
interface ServerToClientEvents {
  plan:             (e: { sessionId; steps: PlanStep[] }) => void;                 // left pane step list
  message:          (e: { sessionId; role:'assistant'; text; partial: boolean }) => void;
  tool_call:        (e: { sessionId; callId; tool; args: unknown; risk: RiskLevel }) => void;
  tool_result:      (e: { sessionId; callId; ok: boolean; output: unknown; redacted?: boolean }) => void;
  browser_frame:    (e: { sessionId; browserSessionId; url; screenshotKey?; domDigest? }) => void; // live-view (Computer panel)
  terminal_chunk:   (e: { sessionId; stream:'stdout'|'stderr'; data: string }) => void;            // live terminal
  file_event:       (e: { sessionId; op:'read'|'write'|'list'; path; bytes? }) => void;            // live file activity
  approval_request: (e: { sessionId; approvalId; action; risk: RiskLevel; detail }) => void;       // approval prompt
  cost_estimate:    (e: { sessionId; estUsd: number; estTokens: number; overThreshold: boolean }) => void;
  usage_update:     (e: { sessionId; cumUsd: number; cumTokens: number }) => void;                 // live cost readout
  status:           (e: { sessionId; status: TaskStatus }) => void;
  final_output:     (e: { sessionId; artifacts: ArtifactRef[]; summary: string }) => void;
  error:            (e: { sessionId; code; message }) => void;
  presence:         (e: { sessionId; collaborators: { userId; presence }[] }) => void;             // collab (LATER P7)
}
```

**Client → Server events** (control plane):
```typescript
interface ClientToServerEvents {
  subscribe: (e: { sessionId }) => void;                                  // join task room (replay viewers too)
  unsubscribe: (e: { sessionId }) => void;
  stop:      (e: { sessionId }) => void;                                  // INSTANT STOP (kill switch)
  approve:   (e: { sessionId; approvalId; scope?: ScopeGrant }) => void;  // unblock gated step
  deny:      (e: { sessionId; approvalId }) => void;
  takeover:  (e: { sessionId }) => void;                                  // grab the browser (LATER P5)
  release:   (e: { sessionId }) => void;                                  // return browser control (LATER P5)
  comment:   (e: { sessionId; text }) => void;                           // collab (LATER P7)
}
```
- **Live-view:** `browser_frame` + `terminal_chunk` + `file_event` drive the right-pane "Computer panel". High-frequency partials are coalesced in the gateway before persistence (§7.8).
- **Approval prompts:** `approval_request` blocks the run; client responds with `approve`/`deny` (or via REST §4). Both converge on the `approvals` row.

### 17.2 `/device` namespace (desktop sidecar control plane) — **MVP P3/P4**

Declarative reconcile loop (§7.6). Token in handshake; device-bound `deviceId`.
```typescript
// cloud → desktop (desired state)
interface DeviceConfig {
  deviceId; configVersion: number;
  sessions: { sessionId; folderPath; sandboxWsUrl }[];
  folders?: { path; name; mode:'ro'|'rw'; allowShell: boolean }[];
}
// desktop → cloud (actual state)
interface DeviceStatus {
  deviceId; deviceName; appliedConfigVersion: number;
  sessions: { sessionId; status:'idle'|'connecting'|'connected'|'error'; folderPath }[];
  folders: { path; mode:'ro'|'rw'; allowShell: boolean }[]; terminalAvailable: boolean;
}
interface DeviceEvents {
  'device:config':  (c: DeviceConfig) => void;   // server → sidecar supervisor
  'device:status':  (s: DeviceStatus) => void;   // sidecar → server (debounced + on-change)
  'device:audit':   (e: { deviceId; sessionId?; op; path; mode; ts }) => void; // "what it touched"
}
```
- **Kill switch:** losing `/device` supervision stops all sidecars; an epoch-guarded serialized op queue prevents a stale timer resurrecting a killed sidecar (§7.8, §E3).
- **Scopes:** sidecar enforces `ro`/`rw` + OS jail + path canonicalization; write outside scope is refused and audited (§E2).

### 17.3 Realtime auth & reconnect
- Token in the `auth` handshake; rejected handshakes never join a room. Reconnect uses the staged backoff curve `[1,2,5,10,20,30,60,120,180,240,300]s` (§7.8).
- Multi-node fan-out via the **Redis adapter** (no sticky sessions required for delivery).

**Test/acceptance:** `plan` before any `tool_call`; `tool_result` correlates by `callId`; multi-node fan-out delivers all events; `stop` aborts within a step boundary; `device:audit` lists every local file access (§B1/B2/B3/E2).

---

## 18. Endpoint group summary

| # | Group | Phase | Auth surface |
|---|---|---|---|
| 1 | Auth (incl. PKCE) | MVP P2 | public → cookie / bearer |
| 2 | Workspaces | MVP P1 | cookie/bearer |
| 3 | Projects | MVP-lite P1 / P7 | cookie/bearer |
| 4 | Tasks (+ approvals, stop, replay) | MVP P2 | cookie/bearer |
| 5 | Tools (registry + permissions) | MVP P2 | cookie/bearer |
| 6 | Files (presigned) | MVP P2 | cookie/bearer |
| 7 | Artifacts | MVP-lite P2 / share P7 | cookie/bearer / public |
| 8 | Automations | LATER P6 | cookie/bearer |
| 9 | Integrations (OAuth) | LATER P7/P10 | cookie/bearer |
| 10 | MCP | LATER P10 | cookie/bearer |
| 11 | Skills | LATER P7 | cookie/bearer |
| 12 | Collaboration | LATER P7 | cookie/bearer |
| 13 | Admin / Settings | settings MVP P1 / admin P7 | cookie/bearer |
| 14 | Memory / Data providers | LATER P7/P10 | cookie/bearer |
| 15 | Public API | LATER P10 | API key (hashed) |
| 16 | Webhooks (in/out) | LATER P8/P10 | HMAC signature |
| 17 | WebSocket `/chat` + `/device` | MVP P1 | handshake token |

**16 REST groups + 1 WebSocket group (2 namespaces) = 17 endpoint groups.**

---

*End of API.md — risk levels, approval gates, masking, and instant-stop reflected across every state-changing surface, conforming to `00-scope-and-phases.md` and `01-stack-and-system-architecture.md`.*
