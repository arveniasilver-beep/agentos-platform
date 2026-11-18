# AgentOS — Integrations, MCP, Public API, No-Code Workflows & Website Builder

> **Status:** Planning only. No production code in this document — TypeScript appears solely as interface *sketches* to pin contracts.
> **Scope of this doc (owned sections):** §26 (MCP Connector Registry), §27 (No-Code Automation / Webhook Workflows + Automations & Scheduled Tasks), §28 (Website/App Builder), plus the **API & Integration Center** and the **AgentOS Public API**.
> **Conforms to:** `docs/00-scope-and-phases.md` (scope, phases, MVP/Later split) and `docs/01-stack-and-system-architecture.md` (stack, topology, wire contracts, folder layout, rename strategy). This document does **not** contradict those; where a phase tag is given it matches Appendix A of the scope doc.
> **Companion docs:** `_research/MANUS_TEARDOWN.md`, `_research/BUILD_BLUEPRINT.md`.
> **Brand handling:** Every literal product name, scheme, domain, and app-id below is `BRAND.*` from `packages/brand` (see stack doc §34.6). Treat `agentos`, `agentos.example`, `com.agentos.*` as derived constants, never hardcoded. Webhook/callback URLs, OAuth `redirect_uri`s, and deep-links are all built from `BRAND`.

---

## 0. Where this fits — phase map (authoritative, matches scope doc Appendix A)

| Area (this doc) | Scope-doc module | Phase | MVP? |
|---|---|---|---|
| **API & Integration Center** (custom REST, webhook out, first-party connectors) | 17 Connectors / 27 webhooks / 29 Public API | **P10** (connectors land with MCP/public API) | ⬜ Later |
| **First-party connectors** (Gmail, Google Calendar, Google Drive, Slack, Notion, GitHub) | 17 Connectors | **P10** | ⬜ Later |
| **MCP Connector Registry** | 26 MCP | **P10** | ⬜ Later |
| **No-Code Automation / Webhook Workflows** | 13 Automation / 20 Mail-to-task / 27 webhooks | **P6** (engine) → **P8** (mail/ingest) | ⬜ Later |
| **Automations & Scheduled Tasks** (cron/event triggers) | 13 Automation | **P6** | ⬜ Later |
| **Website/App Builder** | 27 Website builder | **P9** (generate) / **P10** (deploy+GitHub sync+domains) | ⬜ Later |
| **AgentOS Public API** (REST + webhooks + OAuth apps) | 28/29 Public API | **P10** | ⬜ Later |

> **Cross-cutting reuse:** all of the above inherit, not re-invent, the platform's existing primitives — `RiskLevel` + risk-gate + approval (P2), `ToolDef`/`tool-abi` (P2), the Postgres **audit log** and **append-only event log** (P1), **envelope encryption** for secrets (P1, `packages/crypto`), the **Socket.IO** event stream (P1), **BullMQ** queue (P1), and **Zod** validation at every boundary (P0). This doc specifies the *new* surfaces and *new* tables/contracts only; it wires them to the existing machinery.

**Reading guide — every area below is structured as:** purpose → data model (Prisma-shaped + TS sketch) → flows/state machines → settings panel & UX → security (scopes, rate limits, secrets, risk) → test scenarios → acceptance criteria → MVP/Later tags.

---

## 1. Shared foundations for all integration surfaces

These primitives are defined **once** here and reused by connectors, MCP, public API, workflows, and the website builder. They live in new packages that sit alongside the existing ones.

### 1.1 New packages & services (added to the monorepo from §34)

```
packages/
├─ integrations/         # Integration + Connector domain: REST/webhook/OAuth/api-key abstractions, provider adapters
│  ├─ core/              # Integration interface, ConnectionTest, scope model, secret-ref resolution
│  ├─ oauth/             # OAuth2 Auth-Code+PKCE broker (server-side), token refresh/rotation/revoke
│  ├─ providers/         # gmail/, gcal/, gdrive/, slack/, notion/, github/  (one adapter each)
│  └─ rest/              # generic custom-REST connection executor (templated requests, auth injection)
├─ mcp/                  # MCP client, transport (stdio/http+SSE/streamable-http), tool discovery, health, security scan
├─ workflows/            # no-code workflow graph model, trigger/condition/action nodes, compiler → runnable plan
├─ public-api/           # public REST contract (Zod), API-key model, scope checks, rate-limit policy, request-log shapes
└─ sitebuilder/          # website builder spec model, generator orchestration, deploy/domain/env contracts

services/
├─ api/  (extend)        # new Nest modules: integrations, connectors, mcp-registry, automations, workflows, public-api, sitebuilder
├─ worker/ (extend)      # new BullMQ consumers: oauth-refresh, automation-runner, workflow-runner, webhook-dispatch, sitebuilder-deploy
└─ webhook-ingress/      # NEW thin service: public inbound webhook receiver (HMAC-verified) → enqueues trigger events
```

> `webhook-ingress` is a deliberately small, separately-deployable front door (like `gateway`) so untrusted inbound POSTs never hit the main API trust zone directly; it verifies signatures, rate-limits per source, and enqueues a normalized `TriggerEvent` onto BullMQ.

### 1.2 Secret storage (reused, not new)

All third-party credentials — OAuth access/refresh tokens, API keys, webhook signing secrets, MCP server credentials, GitHub PATs, deploy provider tokens — are stored via the **existing envelope-encryption path** (`packages/crypto`, §6.20). The DB holds a `SecretRef` (a pointer + wrapped data key), never plaintext. **No integration credential is ever serialized to the frontend or any wire payload to the client.** The frontend sees only `{ hasSecret: true, last4?: string, maskedHint?: string }`.

```typescript
// packages/crypto — already exists; integrations consume it
interface SecretRef { id: string; alg: 'aes-256-gcm'; keyId: string; /* ciphertext + iv + tag stored in secrets table */ }
interface SecretBroker {
  put(workspaceId: string, classification: 'critical' | 'sensitive', plaintext: string): Promise<SecretRef>;
  get(ref: SecretRef): Promise<string>;          // server-only; decrypt in-process at use time
  rotate(ref: SecretRef): Promise<SecretRef>;
  destroy(ref: SecretRef): Promise<void>;         // crypto-shred for revoke/delete
}
```

### 1.3 Risk model for integrations (reused `RiskLevel`)

Every integration action maps to the platform `RiskLevel = 'low' | 'medium' | 'high' | 'critical'`. Default classification table (per-action overridable by workspace policy):

| Action class | Examples | Default risk |
|---|---|---|
| Read, scoped | Gmail list/read message, Drive list, GitHub read repo, Notion read page, Calendar list | **low** |
| Write, reversible | Create draft, add calendar event, create Notion page, GitHub create branch/comment | **medium** |
| Write, externally-visible / hard-to-undo | Send email, post Slack message, GitHub merge/push to default branch, Drive delete | **high** |
| Destructive / bulk / financial / credential-touching | Bulk delete, revoke others' access, deploy to production domain, rotate org secrets, Stripe charge | **critical** |

`high`/`critical` actions **always** raise an `approval_request` event (existing contract) before execution. The same gate applies whether the action originates from an interactive task, an automation, a workflow, or a public-API-created task.

### 1.4 Audit & logs (reused append-only tables)

Every integration call writes an `AuditLog` row (existing table) and, for connectors/MCP/public-API, an additional **per-surface log** row (`IntegrationLog`, `McpAuditLog`, `ApiRequestLog`) for the user-facing "Logs" tab. Sensitive request/response bodies pass through `packages/logger` redaction before persistence. Logs are queryable per workspace, per integration, per time window, and per risk level.

---

## 2. API & Integration Center

**Purpose.** A single workspace surface to connect AgentOS to external systems via four mechanisms — **custom REST connection**, **outbound webhook**, **MCP server** (detailed in §3), and **first-party connectors** (Gmail / Google Calendar / Google Drive / Slack / Notion / GitHub). Each connection exposes tools to the agent (via `tool-abi`), has a settings panel, a connection test, scopes, revoke/delete, logs, rate limits, error handling, and risk-gated approval.

**Phase: P10 (Later).** *(Connectors are scoped-doc module 17, scheduled P10.)*

### 2.1 Core `Integration` model

```typescript
// packages/integrations/core
type IntegrationKind = 'rest' | 'webhook_out' | 'mcp' | 'connector';
type IntegrationStatus = 'draft' | 'connected' | 'degraded' | 'error' | 'revoked' | 'expired';
type AuthKind = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2' | 'hmac' | 'custom_header';

interface Integration {
  id: string;
  workspaceId: string;
  kind: IntegrationKind;
  providerId: string;                 // 'gmail' | 'slack' | 'custom-rest:acme' | 'mcp:<serverId>' ...
  displayName: string;
  status: IntegrationStatus;
  auth: AuthConfig;                    // see below; secrets are SecretRefs, never plaintext
  scopes: GrantedScope[];             // permission scopes actually granted/selected
  rateLimit: RateLimitPolicy;
  riskDefault: RiskLevel;             // baseline; per-tool risk can be higher
  config: Record<string, unknown>;    // provider-specific (base URL, account email, repo allowlist…)
  health: { lastCheckedAt?: string; ok: boolean; detail?: string };
  createdBy: string; createdAt: string; updatedAt: string;
  revokedAt?: string;
}

interface AuthConfig {
  kind: AuthKind;
  secretRefs: { access?: SecretRef; refresh?: SecretRef; apiKey?: SecretRef; signing?: SecretRef };
  oauth?: { authServerId: string; tokenExpiresAt?: string; scope: string[]; pkce: true };
  apiKeyPlacement?: { in: 'header' | 'query'; name: string; prefix?: string };  // e.g. header "Authorization", prefix "Bearer "
}

interface GrantedScope { id: string; label: string; risk: RiskLevel; enabled: boolean; description: string }

interface RateLimitPolicy {
  perMinute?: number; perHour?: number; perDay?: number;
  concurrency?: number;
  strategy: 'token_bucket' | 'fixed_window';
  onLimit: 'queue' | 'reject' | 'backoff';   // backoff respects provider Retry-After
}
```

### 2.2 Custom REST connection

A no-code way to register an arbitrary third-party REST API so its endpoints become agent tools.

**Definition (user-authored in the settings panel, Zod-validated):**

```typescript
interface RestConnection {
  integrationId: string;
  baseUrl: string;                         // validated https; SSRF allowlist enforced (see 2.7)
  auth: AuthConfig;                        // api_key | bearer | basic | oauth2 | custom_header | none
  defaultHeaders?: Record<string, string>;
  endpoints: RestEndpoint[];               // each becomes a ToolDef
  egressAllowlist: string[];               // hostnames the agent may call through this connection
}
interface RestEndpoint {
  id: string;
  toolName: string;                        // surfaced to the agent as a tool
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  pathTemplate: string;                    // "/v1/users/{userId}"  (params Zod-typed)
  inputSchema: ZodSchemaJson;              // authored in UI → stored as JSON Schema, mirrored to Zod
  outputPick?: string;                     // JSONPath to extract the useful result
  risk: RiskLevel;                         // user sets; GET defaults low, mutating defaults >= medium
  rateLimit?: RateLimitPolicy;
}
```

**Flow (agent calls a custom-REST tool):** engine selects `toolName` → `packages/integrations/rest` resolves the `RestEndpoint`, validates args against the schema, injects auth from `SecretBroker` **in-process**, applies egress allowlist + SSRF guard, executes through the rate-limiter, redacts + logs request/response, returns `outputPick`ed result. `high`/`critical` endpoints gate on approval first.

### 2.3 Outbound webhook (send to external tools)

Lets the agent / automation / workflow POST a normalized payload to an external endpoint (Zapier/Make/n8n/Slack incoming-webhook/custom).

```typescript
interface OutboundWebhook {
  integrationId: string;
  url: string;                             // https only, SSRF-guarded
  method: 'POST' | 'PUT';
  headers?: Record<string, string>;
  signing?: { algo: 'hmac-sha256'; secretRef: SecretRef; headerName: string };  // we sign so receiver can verify
  payloadTemplate: JsonTemplate;           // {{event.*}} / {{task.*}} interpolation
  retry: { maxAttempts: number; backoff: 'exponential'; baseMs: number };
  risk: RiskLevel;                         // default medium (external side-effect)
}
```

Dispatch runs on the `webhook-dispatch` BullMQ consumer with retry+backoff and a dead-letter record; every send is logged with response status. Compatible by design with Zapier/Make/n8n "Catch Hook" — payload is flat JSON + a stable `event_type`, `idempotency_key`, and `signature` header (see §4.6).

### 2.4 First-party connector ARCHITECTURES

All six share one OAuth broker, one token store, one health model, one scope screen, and one tool-exposure pipeline. Per the blueprint, OAuth runs in a **dedicated sandboxed child window** (desktop) or a **popup with a server-rendered callback** (web) — never by navigating the main window into a third-party site.

Common per-connector contract:

```typescript
interface ConnectorAdapter {
  providerId: string;
  authServer: OAuthServerConfig;           // authz/token endpoints, default+optional scopes
  listScopes(): ConnectorScope[];          // shown on the permission screen with risk tags
  buildTools(integration: Integration): ToolDef<any, any>[];   // → tool-abi
  testConnection(integration: Integration): Promise<ConnectionTestResult>;
  refreshToken(integration: Integration): Promise<void>;       // called by oauth-refresh worker
  revoke(integration: Integration): Promise<void>;             // calls provider revoke endpoint + crypto-shred
  mapError(providerError: unknown): NormalizedIntegrationError;
}
interface ConnectionTestResult { ok: boolean; identity?: string; scopesVerified: string[]; detail?: string; latencyMs: number }
```

#### 2.4.1 Gmail
- **Auth:** Google OAuth2 (Auth-Code + PKCE), offline access for refresh token.
- **Scopes (risk-tagged):** `gmail.readonly` (low) · `gmail.send` (high) · `gmail.modify`/labels (medium) · `gmail.compose` drafts (medium).
- **Tools:** `gmail.search`, `gmail.read_message`, `gmail.list_threads`, `gmail.create_draft` (medium), `gmail.send` (high — always approval), `gmail.add_label` (medium).
- **Rate limits:** respect Gmail per-user quota units; local token-bucket sized below Google's; `onLimit: backoff` honoring `Retry-After`.
- **Risky actions:** `send`, bulk label/delete → approval; recipient list + subject shown in the approval prompt (body masked unless expanded).
- **Trigger source:** `new-email` workflow trigger uses Gmail `users.watch` → Pub/Sub push **or** polling fallback (see §4.2).

#### 2.4.2 Google Calendar
- **Scopes:** `calendar.readonly` (low) · `calendar.events` write (medium) · delete events (high).
- **Tools:** `gcal.list_events`, `gcal.create_event` (medium), `gcal.update_event` (medium), `gcal.delete_event` (high), `gcal.find_free_slots`.
- **Trigger source:** `calendar` trigger (event starting in N minutes / new event / changed event) via watch channels or polling.

#### 2.4.3 Google Drive
- **Scopes:** `drive.readonly` (low) · `drive.file` (app-created files, medium) · full `drive` (high — broad access, flagged on the permission screen).
- **Tools:** `gdrive.search`, `gdrive.read_file`, `gdrive.create_file` (medium), `gdrive.update_file` (medium), `gdrive.delete_file` (high), `gdrive.share` (high — changes access).
- **Trigger source:** `folder-file` trigger (new/changed file in a watched folder) via Drive changes API watch or polling.
- **Privacy:** file bytes streamed to the sandbox/sidecar; only model-necessary excerpts sent to the LLM (reuses the "minimize private data" mandate).

#### 2.4.4 Slack
- **Auth:** Slack OAuth2 (bot + optional user token).
- **Scopes:** `channels:read`/`users:read` (low) · `chat:write` (high — posts visibly) · `files:read` (low) · `files:write` (medium).
- **Tools:** `slack.list_channels`, `slack.read_messages`, `slack.post_message` (high — approval, channel shown), `slack.upload_file` (medium), `slack.add_reaction` (low).
- **Trigger source:** Slack Events API (`event_callback`) → `webhook-ingress` → `api-event`/custom trigger; also Slack slash-command → create task.
- **Rate limits:** Slack Tier 1–4 method limits; per-method token buckets; `onLimit: backoff`.

#### 2.4.5 Notion
- **Auth:** Notion OAuth2 (internal/public integration token).
- **Scopes:** Notion grants by page/database *selection* at consent; we record the granted object set; read (low) vs insert/update (medium) vs delete/archive (high).
- **Tools:** `notion.search`, `notion.read_page`, `notion.query_database`, `notion.create_page` (medium), `notion.update_page` (medium), `notion.append_block` (medium), `notion.archive_page` (high).
- **Trigger source:** Notion has no native push → **polling** for new/changed database rows (configurable interval; cursor stored).

#### 2.4.6 GitHub
- **Auth:** GitHub App (preferred — fine-grained, installation tokens) with OAuth user-token fallback; per-repo allowlist.
- **Scopes:** contents read (low) · issues/PR comment write (medium) · contents write / create PR (medium) · push to default branch / merge (high) · admin/workflow/secrets (critical).
- **Tools:** `github.read_file`, `github.search_code`, `github.list_issues`, `github.create_issue` (medium), `github.comment` (medium), `github.create_branch` (medium), `github.open_pr` (medium), `github.push` (high), `github.merge_pr` (high), `github.create_release` (high). Used by the **Website Builder** two-way sync (§5.6).
- **Trigger source:** GitHub webhooks (`push`, `issues`, `pull_request`, `release`) → `webhook-ingress` (HMAC-verified with the App secret) → workflow `api-event` trigger.
- **Rate limits:** GitHub primary + secondary limits; read remaining from `X-RateLimit-*`; `onLimit: backoff`.

### 2.5 OAuth architecture (shared broker)

State machine (per integration):

```
NONE ──connect()──▶ AUTH_PENDING ──(user consents, redirect with code)──▶ EXCHANGING
EXCHANGING ──(PKCE code+verifier → tokens over HTTPS, server-side)──▶ CONNECTED
CONNECTED ──(access token near expiry)──▶ REFRESHING ──ok──▶ CONNECTED
REFRESHING ──refresh fails / revoked upstream──▶ EXPIRED ──user re-consents──▶ AUTH_PENDING
CONNECTED/EXPIRED ──revoke()──▶ REVOKED (provider revoke called + secrets crypto-shredded + tools removed)
```

Key decisions (all conform to stack doc §6.18):
- **Auth-Code + PKCE**, `code_verifier` generated server-side, never in the renderer.
- **`state`/`nonce`** CSRF guard; one-time, short-TTL, bound to `workspaceId` + `userId`.
- **`redirect_uri`** is a server endpoint `https://api.${BRAND.storageDomain}/integrations/oauth/callback` (web) or the desktop child-window callback that posts the code to the same server endpoint. The **main window never navigates to the provider**.
- **Token exchange & refresh happen only in `services/api`/`worker`**; tokens stored as `SecretRef`s; refresh proactively scheduled by the `oauth-refresh` BullMQ repeatable job before `tokenExpiresAt`.
- **Per-workspace** isolation; one workspace's tokens are never readable by another (RLS backstop + scope check).

### 2.6 API-key architecture (for inbound: see §6; here for outbound third-party keys)

When a third-party uses static API keys (custom REST, some connectors), the key is captured in the settings panel, immediately `SecretBroker.put(..., 'critical', key)`, and the plaintext is dropped. Placement (`header`/`query`, name, prefix) is stored in `AuthConfig.apiKeyPlacement`. The UI only ever shows `••••last4`. Rotation = capture new key → `rotate` → old secret shredded.

### 2.7 Connection test, error handling, SSRF guard

- **Connection test** (`testConnection`): calls a cheap provider read (e.g. Gmail `getProfile`, GitHub `/user`, Slack `auth.test`) → returns identity + verified scopes + latency. Surfaced as a "Test connection" button; result cached on `Integration.health`.
- **Normalized errors:** every adapter maps provider errors to `NormalizedIntegrationError { code: 'auth_expired'|'rate_limited'|'forbidden_scope'|'not_found'|'provider_down'|'invalid_request'; retryable: boolean; retryAfterMs?: number; userActionRequired?: 'reconnect'|'grant_scope' }`. The engine uses `retryable`/`retryAfterMs` for backoff; `auth_expired` flips status to `EXPIRED` and prompts reconnect.
- **SSRF guard (custom REST + outbound webhook):** resolve target host; **deny** RFC-1918/loopback/link-local/metadata IPs (`169.254.169.254`, `::1`, `10/8`, `192.168/16`, `172.16/12`), deny non-https unless workspace explicitly allows http for a named host, enforce `egressAllowlist`, cap redirects and re-validate each hop.

### 2.8 Settings panel & UX (per integration)

Tabs: **Overview** (status, identity, health, test button) · **Permissions/Scopes** (toggle granted scopes with risk badges; disabling a scope removes the corresponding tools) · **Tools** (which `tool-abi` tools this exposes, with per-tool risk + enable toggle) · **Rate limits** (policy editor) · **Logs** (filterable `IntegrationLog`) · **Danger** (revoke / delete with crypto-shred + confirm).

### 2.9 Data model (Prisma-shaped)

```
Integration(id, workspaceId FK, kind, providerId, displayName, status, riskDefault,
            authKind, config JSONB, health JSONB, createdBy, createdAt, updatedAt, revokedAt)
IntegrationSecret(id, integrationId FK, role['access'|'refresh'|'apiKey'|'signing'], secretRefId FK)
IntegrationScope(id, integrationId FK, scopeId, label, risk, enabled, description)
RestEndpoint(id, integrationId FK, toolName, method, pathTemplate, inputSchema JSONB, outputPick, risk, rateLimit JSONB)
OutboundWebhook(id, integrationId FK, url, method, headers JSONB, signingSecretRefId, payloadTemplate JSONB, retry JSONB, risk)
IntegrationLog(id, integrationId FK, ts, action, risk, ok, httpStatus, latencyMs, requestRedacted JSONB,
               responseRedacted JSONB, error JSONB, taskId?, automationId?, approvalId?)
@@index(workspaceId), @@index(integrationId, ts)
```

### 2.10 Test scenarios — Integration Center

- **INT-1 OAuth connect (Gmail):** complete consent → status `CONNECTED`, identity = the Google account, refresh token stored encrypted. **Accept:** no token ever appears in any client payload or URL the renderer can read; `testConnection` returns `ok` with verified scopes.
- **INT-2 Token refresh:** advance clock past `tokenExpiresAt`. **Accept:** `oauth-refresh` job refreshes before expiry; an in-flight tool call succeeds without user action; failure flips status to `EXPIRED` and emits a reconnect prompt.
- **INT-3 Revoke & delete:** revoke a connector. **Accept:** provider revoke endpoint called; secrets crypto-shredded (DB holds no recoverable ciphertext); all exposed tools disappear from the registry; audit row written.
- **INT-4 Custom REST tool:** register a GET endpoint, run it from a task. **Accept:** args validated; auth injected server-side; `outputPick` applied; request/response redacted in `IntegrationLog`.
- **INT-5 Risky write gating:** agent calls `gmail.send`. **Accept:** `approval_request{risk:'high'}` emitted with recipients/subject; nothing sends until `approve`; `deny` aborts cleanly; both audited.
- **INT-6 Rate limit:** exceed a connector's per-minute policy. **Accept:** `onLimit` behavior applied (queue/backoff honoring `Retry-After`); no provider 429 storm; events show throttling.
- **INT-7 SSRF block:** custom REST/outbound webhook targeting `169.254.169.254` or `10.0.0.5`. **Accept:** request refused pre-flight; audited as `forbidden`.
- **INT-8 Error normalization:** provider returns 403 insufficient scope. **Accept:** mapped to `forbidden_scope` with `userActionRequired:'grant_scope'`; UI prompts to enable the scope.

### 2.11 Acceptance criteria — Integration Center
- [ ] All six first-party connectors connect via Auth-Code+PKCE in a **sandboxed child window/popup**; the main window never navigates to the provider.
- [ ] No third-party credential (token/key/secret) is ever present in the web or desktop bundle, in any WS/REST payload to the client, or in any log (CI bundle/log scans pass).
- [ ] Every connector exposes its tools through `tool-abi` with correct per-tool risk; `high`/`critical` tools gate on approval before execution.
- [ ] `testConnection`, revoke (with provider-side revoke + crypto-shred), scope toggling, rate-limit policy, and a filterable Logs tab work for every integration.
- [ ] SSRF guard and egress allowlist enforced on custom REST and outbound webhooks; injection of internal hosts is refused and audited.
- [ ] Token refresh is proactive and silent; refresh failure degrades gracefully to a reconnect prompt without losing the integration config.

---

## 3. MCP Connector Registry

**Purpose.** Let workspaces install and manage **Model Context Protocol** servers (built-in catalog + custom), discover their tools, gate them by permission and risk, health-check them, and run them under the same audit/rate-limit/approval machinery as native tools. Conforms to "open MCP/tool layer, sandboxed MCP exec, per-server permission scopes" (scope doc C18).

**Phase: P10 (Later).** *(Scope-doc module 26.)*

### 3.1 `McpConnector` model

```typescript
type McpTransport = 'stdio' | 'http_sse' | 'streamable_http';
type McpConnectorStatus = 'installed' | 'connecting' | 'ready' | 'degraded' | 'error' | 'disabled' | 'quarantined';
type McpAuthKind = 'none' | 'api_key' | 'oauth2';

interface McpConnector {
  id: string;
  workspaceId: string;
  source: 'builtin' | 'custom';
  name: string;
  description: string;
  transport: McpTransport;
  endpoint: McpEndpoint;                  // command+args (stdio) or URL (http)
  auth: { kind: McpAuthKind; secretRefs?: { apiKey?: SecretRef; oauth?: SecretRef } };
  status: McpConnectorStatus;
  trust: McpTrust;                         // security-scan result + verification
  tools: McpToolRef[];                     // discovered; each risk-tagged + per-tool enable
  dataBoundary: DataAccessBoundary;        // what this server may see (see 3.6)
  rateLimit: RateLimitPolicy;
  health: { lastPingAt?: string; ok: boolean; latencyMs?: number; consecutiveFailures: number };
  installedBy: string; createdAt: string; updatedAt: string;
}
interface McpEndpoint {
  // stdio (desktop/local only, sandboxed):
  command?: string; args?: string[]; cwd?: string; env?: Record<string, SecretRef | string>;
  // http:
  url?: string; headers?: Record<string, string>;
}
interface McpToolRef {
  name: string; title?: string; inputSchema: ZodSchemaJson;
  risk: RiskLevel;                         // assigned at discovery (heuristic + admin override)
  enabled: boolean;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}
interface McpTrust {
  verified: boolean; pinnedHash?: string; signaturePresent?: boolean;
  scan: McpScanResult;                     // see 3.7
  publisher?: string; firstSeenAt: string;
}
interface DataAccessBoundary {
  workspaceScoped: true;                   // never cross-workspace
  allowFileAccess: boolean; allowNetwork: boolean;
  allowedHosts?: string[];                 // egress allowlist for http-calling MCP tools
  redactSecrets: true;
  maxPayloadBytes: number;
}
```

### 3.2 Built-in connector list

A curated catalog (`source:'builtin'`) shipped in `packages/mcp/catalog` — e.g. filesystem (scoped), fetch/HTTP, web-search, git, Postgres (read-only), time/calendar utilities. Each catalog entry pre-declares transport, recommended scopes, default risk per tool, and a **pinned hash/signature** so install is one click with known-good trust metadata. Backed by a registry index (the deferred `mcp-registry` MCP server in this environment exposes `list_connectors`/`search_mcp_registry`/`suggest_connectors`, mirroring the same catalog shape).

### 3.3 Add custom MCP server (flow + state machine)

```
ADD (user provides transport+endpoint+auth)
  ▶ VALIDATE (Zod: url/command shape; deny obviously dangerous commands; require https for http transport)
  ▶ SECURITY_SCAN (static + handshake scan, §3.7) ──fail──▶ QUARANTINED (install blocked, report shown)
  ▶ CONNECT (MCP initialize handshake; capability negotiation)
  ▶ DISCOVER (tools/list, resources/list, prompts/list)
  ▶ PERMISSION_REVIEW (user sees every tool + assigned risk + data boundary; enables subset)  ← approval gate
  ▶ READY (enabled tools registered into tool-abi for this workspace)
```

- **stdio** servers run **only on desktop/local**, spawned **inside the sandbox** (or under the Rust sidecar's process jail with no ambient filesystem access beyond `dataBoundary`). Never spawned with workspace secrets in argv.
- **http** servers must be https; OAuth/api-key via `SecretBroker`.

### 3.4 OAuth / api-key MCP connectors
Reuse §2.5 OAuth broker and §2.6 api-key handling verbatim — an MCP server requiring auth is just an `Integration`-adjacent credential holder; tokens are `SecretRef`s injected at call time, never exposed.

### 3.5 Permission screen
After discovery, the user is shown a table: tool name · description · annotations (`readOnly`/`destructive`/`openWorld`) · **assigned risk** (editable up, not silently down) · data-access this tool implies · enable toggle. **No tool is callable until explicitly enabled here.** This screen *is* the approval gate for installation.

### 3.6 Tool discovery & retrieval when there are many tools
- **Discovery:** `tools/list` (+ `resources/list`, `prompts/list`) at connect and on `list_changed` notifications.
- **Retrieval at scale (RAG over tools):** when total enabled tools across connectors exceed a threshold (e.g. > 60), the engine does **not** dump every schema into the prompt. Instead `packages/memory` embeds each tool's `name+description+annotations`; at planning time the engine retrieves the top-K relevant tools for the current step (tenant-scoped pgvector KNN), plus always-available core tools. This bounds token cost and keeps the model focused — directly reusing the existing `MemoryStore`/pgvector primitive.

### 3.7 MCP server security scan
Run at install and on each version/hash change; result stored in `McpTrust.scan`:

```typescript
interface McpScanResult {
  passed: boolean;
  checks: {
    transportSafe: boolean;             // https for http; no shell-meta in stdio command
    noPromptInjectionMarkers: boolean;  // scan tool descriptions for instruction-injection / "ignore previous" patterns
    schemaSane: boolean;                // input schemas parse, no absurd/unbounded shapes
    pinnedHashMatches?: boolean;        // for builtin/custom with a known hash
    noExcessiveScopeRequest: boolean;   // flags servers requesting filesystem+network+secrets at once
    signatureValid?: boolean;
  };
  warnings: string[];                   // surfaced to the user
  riskCeiling: RiskLevel;               // scan can cap max allowed risk until reviewed
}
```
A failed scan → `QUARANTINED` (install blocked, report shown). Tool **descriptions** are treated as untrusted content: they are sandboxed/escaped in prompts and scanned for injection ("tool-poisoning") markers; the platform never lets a tool description silently expand its own permissions.

### 3.8 Health check, rate limit, audit, data boundaries
- **Health:** periodic lightweight ping (`tools/list` or a no-op) on a BullMQ repeatable job; `consecutiveFailures >= N` → `degraded` then `error`; auto-retry with backoff; tools hidden while not `ready`.
- **Rate limit:** per-connector `RateLimitPolicy` (token bucket); per-tool override; `onLimit: queue|backoff|reject`.
- **Audit:** every MCP tool invocation → `McpAuditLog(connectorId, tool, risk, argsRedacted, ok, latencyMs, taskId, approvalId)`; `high`/`critical` gated on approval first.
- **Data boundaries:** enforced by `DataAccessBoundary` — workspace-scoped always; file/network access only if granted; egress allowlist for http tools; payloads capped; secrets redacted before they can reach the server.

### 3.9 Data model (Prisma-shaped)
```
McpConnector(id, workspaceId FK, source, name, transport, endpoint JSONB, authKind, status,
             trust JSONB, dataBoundary JSONB, rateLimit JSONB, health JSONB, installedBy, createdAt, updatedAt)
McpConnectorSecret(id, connectorId FK, role, secretRefId FK)
McpTool(id, connectorId FK, name, title, inputSchema JSONB, risk, enabled, annotations JSONB)
McpAuditLog(id, connectorId FK, ts, tool, risk, ok, latencyMs, argsRedacted JSONB, resultRedacted JSONB, taskId?, approvalId?)
@@index(workspaceId), @@index(connectorId, ts)
```

### 3.10 Test scenarios — MCP
- **MCP-1 Install builtin:** one-click install a catalog server. **Accept:** pinned-hash verified, handshake + discovery succeed, tools appear in permission screen disabled-by-default.
- **MCP-2 Add custom http server:** valid https endpoint. **Accept:** scan passes, tools discovered, permission review required before any tool is callable.
- **MCP-3 Quarantine:** add a server whose tool description contains injection markers / requests file+network+secrets. **Accept:** scan flags it, status `QUARANTINED`, install blocked, report shown.
- **MCP-4 Tool retrieval at scale:** enable 100+ tools. **Accept:** planner retrieves top-K relevant tools per step (pgvector), prompt token count stays bounded; an irrelevant tool is not injected.
- **MCP-5 stdio sandbox:** stdio server attempts filesystem access outside its `dataBoundary`. **Accept:** refused by the sandbox/sidecar jail; audited.
- **MCP-6 Health degrade:** kill a connector mid-session. **Accept:** health flips to `degraded`→`error`, its tools are hidden, in-flight call fails gracefully with a normalized error; auto-reconnect with backoff.
- **MCP-7 Risk gating:** an MCP tool annotated `destructiveHint` is called. **Accept:** treated `>= high`, approval required.
- **MCP-8 Data boundary:** http MCP tool tries to call a host outside `allowedHosts`. **Accept:** egress blocked + audited.

### 3.11 Acceptance criteria — MCP
- [ ] Built-in catalog installs with verified pinned hash; custom servers require a passing security scan before reaching `READY`.
- [ ] Every discovered tool is risk-tagged, disabled by default, and requires explicit per-tool enable on the permission screen.
- [ ] Tool descriptions are treated as untrusted (injection-scanned, sandboxed in prompts); a tool cannot expand its own permissions.
- [ ] At scale (>60 tools) the engine retrieves a bounded top-K relevant tool set instead of dumping all schemas; token cost stays bounded (asserted).
- [ ] stdio servers run sandboxed with no filesystem/network access beyond their `dataBoundary`; egress allowlist enforced for http tools.
- [ ] Health checks, rate limits, per-call audit, and `high`/`critical` approval gating all function; disabling a connector instantly removes its tools.

---

## 4. No-Code Automation / Webhook Workflows + Automations & Scheduled Tasks

**Purpose.** Let users build, without code, **trigger → condition → action** workflows and **scheduled automations** that drive AgentOS tasks and external side-effects. Triggers: webhook, new-email, form-submit, calendar, folder-file, api-event. Plus schedule kinds: one-time/daily/weekly/monthly/cron/manual, with pause/resume/edit/delete, run history, notifications, retries, and conditionals. Zapier/Make/n8n-compatible webhook shapes.

**Phase: Automations engine P6; mail/folder/calendar ingestion triggers P8 (depend on connectors P10 for the richer sources). MVP-lite manual/cron automations can ride on the BullMQ repeatable-job primitive already present in P1, but the *product surface* is Later.**

### 4.1 `Automation` and `WorkflowTrigger` models

```typescript
type TriggerKind = 'webhook' | 'new-email' | 'form-submit' | 'calendar' | 'folder-file' | 'api-event' | 'schedule' | 'manual';
type ScheduleKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'cron' | 'manual';

interface WorkflowTrigger {
  id: string;
  kind: TriggerKind;
  // schedule:
  schedule?: { kind: ScheduleKind; cron?: string; at?: string; timezone: string };
  // webhook (inbound):
  webhook?: { slug: string; signing?: { algo: 'hmac-sha256'; secretRef: SecretRef }; ipAllowlist?: string[] };
  // event-source bindings (use a connected Integration as the source):
  source?: { integrationId: string; resource?: string; filter?: Record<string, unknown> };  // e.g. Gmail label, Drive folder, Notion db, calendar id
  // form-submit:
  form?: { formId: string };
  dedupeKey?: string;                      // idempotency across deliveries
}

interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;                        // pause/resume
  trigger: WorkflowTrigger;
  workflow: WorkflowGraph;                 // the no-code step graph (see 4.4)
  approvalPolicy: 'inherit' | 'always_high_critical' | 'manual_review_all' | 'auto_low_only';
  budget: { maxUsdPerRun?: number; maxRunsPerDay?: number };  // cost guardrails (reuses metering)
  retry: { maxAttempts: number; backoff: 'exponential' | 'fixed'; baseMs: number };
  notify: NotifyPolicy;                    // on success/failure → email/slack/webhook/inbox
  lastRun?: AutomationRunSummary;
  createdBy: string; createdAt: string; updatedAt: string;
}
interface NotifyPolicy { onSuccess: NotifyTarget[]; onFailure: NotifyTarget[] }
type NotifyTarget = { kind: 'inbox' | 'email' | 'slack' | 'webhook'; ref?: string };
```

### 4.2 Trigger sources & how each fires

| Trigger | Source mechanism | Notes |
|---|---|---|
| `webhook` | Inbound POST to `webhook-ingress` at `https://hooks.${BRAND.storageDomain}/w/{slug}` | HMAC-verified (if signing set) + IP allowlist + per-slug rate limit → enqueue `TriggerEvent`. Zapier/Make/n8n can hit this directly. |
| `new-email` | Gmail `users.watch`→Pub/Sub push, or polling fallback | Requires Gmail connector (P10). Sender allowlist + filter. |
| `form-submit` | AgentOS-hosted form posts to ingress, or external form → webhook | Uses the same ingress path. |
| `calendar` | Calendar watch channel / polling | Requires Calendar connector. "event starts in N min" computed by a scheduled scan. |
| `folder-file` | Drive changes watch / polling; **or local folder watch via Rust sidecar** | Local folder watch reuses the desktop sidecar (read-only by default). |
| `api-event` | Provider webhook (GitHub/Slack/Notion) → ingress | Normalized to a common `TriggerEvent`. |
| `schedule` | BullMQ repeatable job (cron) | Covers once/daily/weekly/monthly/cron. |
| `manual` | User clicks "Run now" / Public API `runAutomation` | Always available for testing. |

All triggers normalize to:
```typescript
interface TriggerEvent {
  automationId: string; workspaceId: string;
  kind: TriggerKind; receivedAt: string;
  idempotencyKey: string;                  // dedupe re-deliveries
  payload: Record<string, unknown>;        // raw-but-redacted source data, available as {{trigger.*}}
  source?: { integrationId?: string; signatureValid?: boolean };
}
```

### 4.3 Trigger + condition + action logic; conditional automations
A workflow is a directed graph of nodes. Conditions are no-code predicates over `{{trigger.*}}` / prior node outputs.

```typescript
type NodeType = 'trigger' | 'condition' | 'action' | 'agent_task' | 'delay' | 'branch' | 'loop' | 'webhook_out' | 'notify';
interface WorkflowNode {
  id: string; type: NodeType; next?: string[];      // graph edges
  // condition:
  condition?: { all?: Predicate[]; any?: Predicate[] };   // AND / OR groups
  // action / tool:
  action?: { toolName: string; args: JsonTemplate };      // any tool-abi tool (connector/MCP/native), risk-gated
  // agent_task: hand a natural-language goal to the agent engine
  agentTask?: { goal: string; inputs: JsonTemplate };
  // control:
  branch?: { cases: { when: Predicate; goto: string }[]; elseGoto?: string };
  loop?: { overPath: string; as: string; body: string };  // iterate a collection
  delay?: { ms: number };
  webhookOut?: { integrationId: string };                 // §2.3 outbound webhook
}
interface Predicate { left: string; op: 'eq'|'neq'|'contains'|'gt'|'lt'|'exists'|'matches'; right?: unknown }
interface WorkflowGraph { entry: string; nodes: Record<string, WorkflowNode> }
```

### 4.4 Multi-step workflow builder (no-code UI)
- **Canvas:** drag-drop node palette (Trigger, Condition, Action/Tool, Agent Task, Branch, Loop, Delay, Send Webhook, Notify). Edges define order; branches fork.
- **Data mapping:** a `{{ }}` picker exposes `trigger.payload.*` and each upstream node's typed output; mappings are validated against the target tool's Zod input.
- **Tool picker:** any enabled tool from native/connector/MCP registry; each shows its risk badge; choosing a `high`/`critical` tool forces `approvalPolicy` acknowledgment.
- **Dry-run preview:** compiles the graph and shows the planned actions (and their risk levels) **without executing** — reuses the scope-doc Phase-6 dry-run requirement.
- **Validation:** unreachable nodes, missing required mappings, and type mismatches are surfaced before save.

### 4.5 Execution: state machine & runner
The `workflow-runner` (BullMQ consumer) compiles `WorkflowGraph` → a step plan and executes node-by-node; `agent_task` nodes spawn a normal AgentOS task (same engine, same audit, same risk-gate). Per-run state machine:

```
QUEUED ─▶ RUNNING ─(node)*─▶ {WAITING_APPROVAL ⇄ RUNNING} ─▶ SUCCEEDED
RUNNING ─(node throws, retryable)─▶ RETRYING ─(maxAttempts)─▶ FAILED
RUNNING ─(stop / disable)─▶ STOPPED
WAITING_APPROVAL ─(deny)─▶ STOPPED
```
Each run writes an `AutomationRun` row + per-node `AutomationRunStep` rows (status, risk, in/out redacted, duration). `high`/`critical` actions raise `approval_request` and pause the run (delivered to the **Inbox** + push/webhook per `notify`).

### 4.6 Send webhook to external tools (Zapier/Make/n8n-compatible)
Outbound `webhook_out` nodes (and the §2.3 OutboundWebhook) emit a stable envelope so external no-code tools can "Catch Hook" without custom parsing:
```json
{
  "event_type": "automation.node.completed",
  "agentos_version": "1",
  "idempotency_key": "uuid",
  "occurred_at": "ISO-8601",
  "workspace_id": "...",
  "automation_id": "...",
  "data": { "...": "node output (redacted of secrets)" }
}
```
Header `X-AgentOS-Signature: sha256=<hmac>` (computed with the integration's signing secret) lets receivers verify authenticity. Inbound triggers expect the same `X-AgentOS-Signature` scheme symmetrically.

### 4.7 Automations & Scheduled Tasks surface (pause/resume/history/retry/notify)
- **Schedule kinds:** once / daily / weekly / monthly / cron / manual — all compiled to a BullMQ **repeatable job** (cron or one-shot delayed job) keyed by `automationId`; timezone-aware.
- **Pause/resume/edit/delete:** toggling `enabled` removes/re-adds the repeatable job; editing re-registers; deleting tears down the job + future runs immediately (matches scope-doc P6 acceptance).
- **Last-run report + success/failure history:** `AutomationRun` table powers a runs list (status, duration, cost, error, link to the produced task/artifacts) and a "last run" summary on the card.
- **Notifications:** `NotifyPolicy` → Inbox always; optionally email/Slack/outbound-webhook on success/failure.
- **Retry failed:** `retry` policy auto-retries retryable failures; a manual "Retry run" re-enqueues from the failed node where safe (idempotency-keyed).
- **Conditional automations:** `condition`/`branch` nodes (§4.3) gate whether the workflow proceeds.

### 4.8 Data model (Prisma-shaped)
```
Automation(id, workspaceId FK, name, enabled, trigger JSONB, workflow JSONB, approvalPolicy,
           budget JSONB, retry JSONB, notify JSONB, createdBy, createdAt, updatedAt)
WebhookEndpoint(id, automationId FK, slug UNIQUE, signingSecretRefId?, ipAllowlist JSONB, perMinuteLimit)
AutomationRun(id, automationId FK, status, trigger TriggerEvent JSONB, startedAt, endedAt,
              costUsd, error JSONB, producedTaskId?)
AutomationRunStep(id, runId FK, nodeId, type, status, risk, inputRedacted JSONB, outputRedacted JSONB,
                  approvalId?, startedAt, endedAt)
@@index(workspaceId), @@index(automationId, startedAt), @@unique(slug)
```

### 4.9 Test scenarios — Automations/Workflows
- **WF-1 Cron fires:** daily automation at a set time. **Accept:** fires on schedule (tz-correct), creates a task inheriting approval + budget; visible in run history.
- **WF-2 Webhook trigger:** POST signed payload to `/w/{slug}`. **Accept:** HMAC verified, bad signature rejected (401), dedupe by `idempotency_key`, `TriggerEvent` enqueued, workflow runs.
- **WF-3 Condition branch:** payload fails the condition. **Accept:** workflow short-circuits down the `else` path; no action executes; audited.
- **WF-4 Dry-run:** preview a multi-step workflow. **Accept:** lists planned actions + risk levels, executes nothing, no side-effects.
- **WF-5 Risky action in workflow:** a node calls `slack.post_message` (high). **Accept:** run pauses at `WAITING_APPROVAL`; Inbox + notification fire; approve resumes, deny stops.
- **WF-6 Pause/delete:** disable then delete an automation. **Accept:** future scheduled runs stop immediately; repeatable job removed; in-flight run honored or stopped per policy.
- **WF-7 Retry:** force a transient failure on an action node. **Accept:** auto-retry with backoff up to `maxAttempts`; manual "Retry run" resumes from the failed node idempotently.
- **WF-8 Outbound webhook compat:** point a `webhook_out` node at an n8n "Catch Hook". **Accept:** flat JSON envelope + `X-AgentOS-Signature` received and verifiable.
- **WF-9 Budget guard:** a run exceeds `maxUsdPerRun`. **Accept:** run halts with a budget error before overspend; surfaced in history.

### 4.10 Acceptance criteria — Automations/Workflows
- [ ] All six trigger kinds (+ schedule + manual) fire correctly; inbound webhooks are HMAC-verified, IP-allowlisted, rate-limited, and idempotent.
- [ ] No-code builder validates mappings/types/reachability before save; dry-run previews actions+risk with zero side-effects.
- [ ] Every action inherits the platform risk-gate; `high`/`critical` pause the run for approval; cost budgets are enforced per run/day.
- [ ] Pause/resume/edit/delete take effect immediately on the repeatable-job schedule; run history shows status/cost/error/produced-task with notifications on success/failure.
- [ ] Outbound webhooks emit a stable, signed, Zapier/Make/n8n-compatible envelope; inbound and outbound share one signature scheme.
- [ ] Retry policy + manual retry resume idempotently; no duplicate side-effects on re-delivery.

---

## 5. Website / App Builder

**Purpose.** Turn a natural-language brief into a working web app — frontend, backend, DB schema, auth, file storage, forms, admin, REST API — with preview, NL edits, view/copy/download code, GitHub export + two-way sync, custom domain + SSL, env var management, third-party REST integration, and optional Stripe/analytics modules.

**Phase split (explicit, since this is large): Generation MVP = P9** (NL → code → preview → download/edit). **Deploy + custom domain/SSL + GitHub two-way sync + env management = P10.** Stripe/analytics modules = P10+ optional. Everything below is **Later**; this section commits the *architecture* so the build is unambiguous.

### 5.1 `SiteProject` model

```typescript
type SiteStatus = 'draft' | 'generating' | 'previewing' | 'building' | 'deployed' | 'error';
type SiteStack = 'next-static' | 'next-node' | 'remix' | 'express-api' | 'static';

interface SiteProject {
  id: string;
  workspaceId: string;
  name: string;
  status: SiteStatus;
  brief: string;                           // original NL brief
  spec: SiteSpec;                          // derived, inspectable build spec (see 5.2)
  stack: SiteStack;
  repo?: { provider: 'github'; integrationId: string; owner: string; name: string; defaultBranch: string; lastSyncSha?: string };
  deploy?: DeployConfig;
  envVars: EnvVarRef[];                     // values are SecretRefs (encrypted)
  modules: { stripe?: boolean; analytics?: boolean };
  previewUrl?: string; publishedUrl?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

interface SiteSpec {
  pages: { route: string; purpose: string; components: string[] }[];
  dataModels: { name: string; fields: { name: string; type: string; required: boolean }[] }[];   // → DB schema
  auth: { kind: 'none' | 'email-password' | 'oauth'; roles?: string[] };
  storage: { kind: 'none' | 'blob'; buckets?: string[] };
  forms: { name: string; fields: string[]; onSubmit: 'store' | 'email' | 'webhook' }[];
  api: { route: string; method: string; description: string }[];                // generated REST API
  admin: { enabled: boolean; resources: string[] };
  integrations: { restConnectionId?: string }[];                                // §2.2 reuse
}
interface DeployConfig {
  target: 'agentos-static' | 'agentos-node' | 'external';                       // object-store static or container
  customDomain?: { domain: string; status: 'pending' | 'verifying' | 'active' | 'error'; cnameTarget: string };
  ssl?: { provider: 'acme'; status: 'pending' | 'issued' | 'error' };
  buildCmd?: string; outputDir?: string;
}
interface EnvVarRef { key: string; secretRef: SecretRef; scope: 'build' | 'runtime' | 'both' }
```

### 5.2 Generation flow (NL → app)
```
BRIEF ─▶ SPEC (LLM derives SiteSpec; user reviews/edits the spec — inspectable, not a black box)
      ─▶ SCAFFOLD (generator emits files into the session sandbox: frontend + backend + db schema + auth + forms + admin + REST API)
      ─▶ INSTALL+BUILD (in sandbox) ─▶ PREVIEW (ephemeral preview URL)
      ─▶ (NL edits loop: "make the header sticky" → targeted code edits → rebuild → preview)
```
The generator is an **agent task using existing tools** (code-exec, file write in sandbox) — not a separate engine. Output is real, runnable code (no placeholders), validated by an automated build + smoke test before "preview" is offered (hard rule: nothing "done" without passing). Generated stack defaults to the platform's own stack family for consistency (`next-static`/`express-api`) but is recorded in `SiteSpec`.

### 5.3 Preview, view/copy/download code, NL edits
- **Preview:** built artifact served from an ephemeral sandbox URL (or object-store static preview); per-site access control (unguessable token or workspace-auth).
- **View/copy/download:** full source tree browsable in the UI; copy file or **download .zip** of the whole project from object storage (presigned).
- **NL edits:** each edit is a scoped agent task that diffs against the current tree, applies a minimal change set, rebuilds, and re-previews; every edit is a versioned artifact (existing artifact store) so users can roll back.

### 5.4 Generated backend / DB / auth / storage / forms / admin / REST API
- **DB schema:** `SiteSpec.dataModels` → migrations for the generated app's own database (separate from the AgentOS system DB).
- **Auth:** scaffolded email-password or OAuth per spec, with secure session handling patterns baked in (no secrets in the generated frontend, mirroring our own rules).
- **Storage:** generated apps get a `BlobStore`-style adapter for uploads.
- **Forms:** each form wired to store / email / webhook per `onSubmit`.
- **Admin:** optional CRUD admin over the data models.
- **REST API:** generated endpoints from `SiteSpec.api`, documented (OpenAPI emitted alongside).

### 5.5 GitHub export + two-way sync architecture
Reuses the GitHub connector (§2.4.6, P10).
- **Export (push):** create repo (or use existing) → commit the generated tree → push to a branch → open PR or push to default per setting. Records `lastSyncSha`.
- **Pull:** fetch remote changes; if the user edited code on GitHub, pull into the sandbox working tree.
- **Two-way sync state machine:**
```
IN_SYNC ─(local NL edit)─▶ LOCAL_AHEAD ─push─▶ IN_SYNC
IN_SYNC ─(remote push detected via webhook)─▶ REMOTE_AHEAD ─pull─▶ IN_SYNC
LOCAL_AHEAD + REMOTE_AHEAD ─▶ CONFLICT ─(3-way merge; unresolved → user prompt + PR)─▶ IN_SYNC
```
- **Conflict handling:** attempt automatic 3-way merge; on conflict, open a PR with conflict markers and ask the user (never force-push silently — `push to default branch` is a `high` risk action requiring approval).

### 5.6 Custom domain + SSL architecture
- **Custom domain:** user adds `app.example.com`; we return a **CNAME target** (`<site>.${BRAND.storageDomain}`); a verification job polls DNS until the CNAME resolves → `active`.
- **SSL:** ACME (Let's Encrypt) issuance once DNS verifies; auto-renewal job; `ssl.status` tracked.
- **Deployment guide:** generated per-project (env vars to set, CNAME record, build command) and shown in the UI + downloadable.

### 5.7 Env var management
Env vars stored as `EnvVarRef` → `SecretRef` (encrypted). Scoped `build` / `runtime` / `both`. Never shown in plaintext after entry (only `••••last4`). Injected into the build/runtime environment server-side; **never** baked into a generated client bundle (the build pipeline scans the output and fails if a `runtime` secret leaks into client assets — same posture as our own §6.13 hardening).

### 5.8 Optional modules
- **Stripe:** scaffolds checkout/products/webhook-handler; Stripe keys via `EnvVarRef`; charge endpoints are `critical` risk and gate on approval when invoked by the agent. (Financial actions never auto-execute.)
- **Analytics:** scaffolds a privacy-respecting first-party analytics snippet (no third-party fingerprinting by default, matching platform telemetry posture).

### 5.9 Data model (Prisma-shaped)
```
SiteProject(id, workspaceId FK, name, status, brief, spec JSONB, stack, repo JSONB, deploy JSONB,
            modules JSONB, previewUrl, publishedUrl, createdBy, createdAt, updatedAt)
SiteEnvVar(id, siteId FK, key, secretRefId FK, scope)
SiteBuild(id, siteId FK, status, kind['preview'|'publish'], sha?, logRef, artifactRef, startedAt, endedAt)
SiteDomain(id, siteId FK, domain, cnameTarget, dnsStatus, sslStatus, verifiedAt?)
@@index(workspaceId)
```

### 5.10 Test scenarios — Website Builder
- **SB-1 Generate (P9):** brief → spec → scaffold → build → preview. **Accept:** generated app builds clean and passes a smoke test before preview; no TODO/placeholder in core paths.
- **SB-2 NL edit (P9):** "add a contact form that emails me." **Accept:** minimal diff applied, rebuild succeeds, preview reflects change, edit is a rollback-able versioned artifact.
- **SB-3 Download (P9):** download project zip. **Accept:** presigned zip contains the full runnable source.
- **SB-4 GitHub export (P10):** push to a repo. **Accept:** repo created/updated, branch+PR per setting, `lastSyncSha` recorded; push to default branch required approval (high risk).
- **SB-5 Two-way sync (P10):** edit on GitHub, then locally. **Accept:** remote-ahead pulled; concurrent edits → conflict → PR + user prompt; no silent force-push.
- **SB-6 Custom domain + SSL (P10):** add a domain. **Accept:** CNAME instructions returned; on DNS verify, status `active`, ACME cert `issued`, https serves.
- **SB-7 Env leak guard (P10):** mark a runtime secret, build. **Accept:** build fails if the secret appears in client assets; secret never shown plaintext after entry.
- **SB-8 Stripe module (P10+):** scaffold checkout. **Accept:** keys stored encrypted; agent-invoked charge endpoint is `critical` and gates on approval.

### 5.11 Acceptance criteria — Website Builder
- [ ] **P9:** NL brief produces an inspectable `SiteSpec` then real, buildable code (frontend+backend+db+auth+storage+forms+admin+REST API); preview only offered after a passing build+smoke test; view/copy/download all work.
- [ ] **P9:** NL edits apply minimal, versioned, rollback-able diffs.
- [ ] **P10:** GitHub export + two-way pull/push sync works with conflict-safe merges; push to default branch is approval-gated.
- [ ] **P10:** Custom domain returns correct CNAME, verifies DNS, issues+auto-renews SSL; deployment guide generated.
- [ ] **P10:** Env vars stored encrypted, scoped, masked, and never leaked into client bundles (build-time scan enforces).
- [ ] No generated artifact contains placeholders/TODOs in core functionality; Stripe/analytics modules are opt-in and financial actions never auto-execute.

---

## 6. AgentOS Public API

**Purpose.** A documented, secure REST + webhook API so external developers/apps drive AgentOS programmatically. Conforms to scope-doc C29 ("scoped tokens, rate limits") and §28/29, P10.

**Phase: P10 (Later).**

### 6.1 `ApiKey` model & scopes

```typescript
type ApiScope =
  | 'tasks:read' | 'tasks:write'
  | 'files:read' | 'files:write'
  | 'automations:read' | 'automations:run' | 'automations:write'
  | 'artifacts:read'
  | 'usage:read';

interface ApiKey {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;                          // public, shown in UI (e.g. "ak_live_7f3...")
  hashedSecret: string;                    // we store only a salted hash; full key shown once at creation
  scopes: ApiScope[];                      // workspace-level permission scoping
  rateLimit: RateLimitPolicy;              // per-key
  expiresAt?: string;
  lastUsedAt?: string;
  createdBy: string; createdAt: string; revokedAt?: string;
}
```
- **Key format:** `ak_{env}_{random}`; the **full secret is shown exactly once** at creation and never retrievable again (only the hash is stored). Auth via `Authorization: Bearer ak_...`.
- **Scoping:** every endpoint declares required scopes; a key missing the scope → `403`. Keys are **workspace-bound**; cross-workspace access is impossible.

### 6.2 Endpoints (versioned `/v1`, all Zod-validated)

| Endpoint | Method | Scope | Notes |
|---|---|---|---|
| `/v1/tasks` | POST | `tasks:write` | **Create task** (NL goal + optional inputs/files); returns `taskId`, status `PENDING`. Risky tool use still gates on approval (async). |
| `/v1/tasks/{id}` | GET | `tasks:read` | **Get task status** (status, plan, cost, step progress). |
| `/v1/tasks/{id}/result` | GET | `tasks:read` | **Get task result** (final output + artifact refs) once completed. |
| `/v1/tasks/{id}/stop` | POST | `tasks:write` | Instant stop (reuses kill switch). |
| `/v1/files` | POST | `files:write` | **Upload file** → presigned PUT, returns `fileId`. |
| `/v1/artifacts/{id}` | GET | `artifacts:read` | **Download artifact** → presigned GET. |
| `/v1/automations` | POST | `automations:write` | **Create automation** (workflow graph). |
| `/v1/automations/{id}/run` | POST | `automations:run` | **Run automation** (manual trigger). |
| `/v1/automations/{id}` | DELETE | `automations:write` | Delete automation. |
| `/v1/api-keys` | POST | (admin/owner only) | **Create API key** (secret returned once). |
| `/v1/api-keys/{id}` | DELETE | (admin/owner only) | **Delete/revoke API key**. |
| `/v1/usage` | GET | `usage:read` | **Get usage logs** (tokens/cost per task/day, rate-limit headroom). |
| `/v1/webhooks` | POST | `automations:write` | Register a **webhook callback** URL + events (`task.completed`, `task.failed`, `approval.requested`, `automation.run.completed`). |

**Webhook callback (outbound from AgentOS):** on subscribed events, POST the §4.6 signed envelope to the registered URL; retries with backoff + dead-letter; `X-AgentOS-Signature` for verification; replayable from the delivery log.

### 6.3 Security
- **API keys:** salted-hash at rest, shown once, prefix-identifiable, per-key scopes + rate limit + expiry; revoke is instant (hash invalidated).
- **Rate limit:** per-key token bucket (e.g. default 60/min, 1000/day; configurable per key/tier); `429` with `Retry-After` and `X-RateLimit-Remaining`/`-Reset` headers; enforced in Redis (existing).
- **Workspace-level permissions:** every request resolves to exactly one workspace; data access is RLS-backstopped; a key can never read another workspace.
- **Audit log:** every API call → `ApiRequestLog(keyId, ts, method, path, scopeUsed, status, latencyMs, ip, requestId, bodyRedacted)`; mutating calls also write the existing `AuditLog`.
- **Invalid-request logs:** 4xx/validation failures (bad scope, malformed body, bad signature, rate-limited) are logged distinctly (`ApiRequestLog.status` + `error`) and surfaced in a "Failed requests" view for debugging — without leaking secrets.
- **Risk gate still applies:** an API-created task that triggers a `high`/`critical` tool raises an `approval_request`; the API client is notified via the subscribed webhook (`approval.requested`) and the task waits — the public API cannot bypass approval.

### 6.4 Data model (Prisma-shaped)
```
ApiKey(id, workspaceId FK, name, prefix, hashedSecret, scopes JSONB, rateLimit JSONB,
       expiresAt?, lastUsedAt?, createdBy, createdAt, revokedAt?)
ApiRequestLog(id, workspaceId FK, keyId FK, ts, method, path, scopeUsed, status, latencyMs,
              ip, requestId, bodyRedacted JSONB, error JSONB)
ApiWebhookSub(id, workspaceId FK, url, events JSONB, signingSecretRefId, active, createdAt)
ApiWebhookDelivery(id, subId FK, event, status, httpStatus, attempts, lastAttemptAt, payloadRedacted JSONB)
@@index(workspaceId), @@index(keyId, ts)
```

### 6.5 Test scenarios — Public API
- **API-1 Create+poll+result:** create task, poll status, fetch result. **Accept:** lifecycle `PENDING→RUNNING→COMPLETED`; result includes artifact refs; tokens/cost metered to the workspace.
- **API-2 Scope enforcement:** call `/v1/automations` with a `tasks:read`-only key. **Accept:** `403`; logged as invalid-request with the missing scope.
- **API-3 Key lifecycle:** create key (secret shown once), use it, delete it. **Accept:** secret not retrievable after creation; deleted key → `401` immediately.
- **API-4 Rate limit:** exceed per-key limit. **Accept:** `429` + `Retry-After` + `X-RateLimit-*` headers; Redis-enforced; logged.
- **API-5 Upload/download:** upload a file, run a task using it, download the artifact. **Accept:** presigned PUT/GET work; bytes never transit the API process.
- **API-6 Webhook callback:** subscribe to `task.completed`; complete a task. **Accept:** signed envelope POSTed to the URL; signature verifies; retried on receiver 5xx; delivery logged.
- **API-7 Approval not bypassable:** API task triggers a `high` tool. **Accept:** `approval.requested` webhook fires; task waits; no execution until approved.
- **API-8 Cross-workspace isolation:** key from workspace A requests workspace B's task. **Accept:** `404`/`403`; never leaks existence or data.
- **API-9 Invalid-request log:** send malformed body. **Accept:** validation `400` with field errors; logged distinctly without echoing secrets.

### 6.6 Acceptance criteria — Public API
- [ ] All listed endpoints exist, are versioned (`/v1`), Zod-validated, and documented (OpenAPI generated from the same Zod source — no drift).
- [ ] API keys: salted-hash at rest, shown once, prefix-identifiable, per-key scopes + rate limit + expiry, instant revoke.
- [ ] Per-key rate limiting (Redis) with standard headers; workspace-level scoping with RLS backstop; cross-workspace access impossible.
- [ ] Every call audited; invalid requests logged distinctly; no secret ever appears in logs or responses.
- [ ] Outbound webhook callbacks are signed, retried, dead-lettered, and replayable from the delivery log.
- [ ] The public API cannot bypass the risk-gate; `high`/`critical` actions still require approval, surfaced via `approval.requested` webhook.

---

## 7. Consolidated TypeScript interface index (the five required sketches)

For quick reference, the five interfaces the brief calls out, as committed above:
- **`Integration`** — §2.1 (kind/status/auth/scopes/rateLimit/risk/health; secrets as `SecretRef`).
- **`McpConnector`** — §3.1 (transport/endpoint/auth/trust/tools/dataBoundary/health).
- **`ApiKey`** — §6.1 (prefix + hashedSecret + scopes + per-key rate limit + expiry).
- **`WorkflowTrigger`** — §4.1 (kind + schedule/webhook/source/form bindings + dedupe).
- **`Automation`** — §4.1 (trigger + workflow graph + approvalPolicy + budget + retry + notify + lastRun).

All are Zod-authored in their respective new packages (`packages/integrations`, `packages/mcp`, `packages/public-api`, `packages/workflows`), inferred to TS, validated at every boundary, and risk-tagged against the platform `RiskLevel`.

---

## 8. Cross-cutting acceptance (applies to every area in this doc)
- [ ] **No secret in the frontend, ever** — every third-party token/key/signing-secret is a `SecretRef` (envelope-encrypted), decrypted only server-side, masked in UI (`••••last4`), redacted in logs; CI bundle/log scans pass.
- [ ] **Risk-gate uniformity** — connector tools, MCP tools, custom-REST endpoints, workflow actions, and API-created tasks all flow through the same `RiskLevel` classifier; `high`/`critical` require approval; user can stop instantly.
- [ ] **Audit everywhere** — every integration/MCP/workflow/API action writes an append-only audit row (+ per-surface log) with redaction; logs are filterable per workspace/integration/time/risk.
- [ ] **Rate-limited & error-normalized** — every external call respects a `RateLimitPolicy` and maps provider errors to a normalized, retry-aware shape.
- [ ] **SSRF/egress safety** — custom REST, outbound webhooks, http MCP tools, and site-builder integrations are egress-allowlisted and block internal/metadata addresses.
- [ ] **Renameable** — all URLs, schemes, domains, app-ids derive from `packages/brand`; no hardcoded product literals (ESLint brand-guard passes).
- [ ] **No placeholders** — no fake endpoints/buttons; every module ships with passing unit + integration + contract tests (Turborepo `test` gate).
