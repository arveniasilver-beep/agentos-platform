# AgentOS — Security, Cost & Testing (Cross-Cutting Architecture)

> **Status:** Planning only. No code here — TypeScript appears solely as interface *sketches* to pin contracts.
> **Scope of this doc:** The three cross-cutting planning pillars — **Security / Permission model**, **Cost / Resource control**, **Logging / Observability** — plus the **Testing strategy** (planning sections 29, 30, 31 + logging). These are *not* a single module: they are embedded from Phase 1 onward per the hard rules.
> **Companion docs (CONFORMED TO, do not contradict):** `docs/00-scope-and-phases.md` (scope, phases, MVP cut, acceptance criteria), `docs/01-stack-and-system-architecture.md` (stack, topology, wire contracts, folder layout). Prior research: `_research/MANUS_TEARDOWN.md`, `_research/BUILD_BLUEPRINT.md`.
> **Brand handling:** Every literal "AgentOS" below is `BRAND.appName` from `packages/brand` (renameable via one constant — see stack doc §34.6). The deep-link scheme `agentos://` is `${BRAND.protocol}://`.
> **Phase tags:** `MVP` = Phases 0–4 (per scope doc; MVP completes at end of Phase 4); `LATER` = Phases 5–13. Each feature below carries an explicit tag consistent with the scope doc Appendix A and §4.

---

## 0. Document map

| § | Section | Spec item |
|---|---|---|
| 1 | Cross-cutting placement & ownership | — |
| 2 | Shared TS interfaces (RiskLevel, Permission, AuditLog, UsageRecord, CostRecord, LogEntry) | (interfaces) |
| 3 | **SECURITY / PERMISSION MODEL** | spec 29 (security) |
| 3.1 | The 4 risk levels — exact definitions + example actions | — |
| 3.2 | Risk classification engine (how a level is assigned) | — |
| 3.3 | Approval flow (state machine + sequence) | — |
| 3.4 | Backend-side permission enforcement | — |
| 3.5 | Secrets: encryption at rest (algorithm/KMS), keys never to frontend | — |
| 3.6 | Masking (passwords/tokens/keys/cards/identity/messages) | — |
| 3.7 | Unauthorized file-read prevention | — |
| 3.8 | Terminal risk analysis + dangerous-command blocklist | — |
| 3.9 | Approval-gated action classes (delete/modify/email/form/api-write/external-post) | — |
| 3.10 | Browser-session deletion | — |
| 3.11 | Rate limiting | — |
| 3.12 | CSRF / XSS / SQLi protections | — |
| 3.13 | Safe file-upload handling | — |
| 3.14 | Minimizing private data sent to the LLM | — |
| 3.15 | No CAPTCHA/2FA bypass; no spam/abuse | — |
| 4 | **COST / RESOURCE CONTROL** | spec 29 (cost) |
| 4.1 | What we meter (tokens/model/tool/browser/worker/storage) | — |
| 4.2 | Cost-estimation method (token counting + Opus pricing) | — |
| 4.3 | Prompt-caching / summarization savings strategy | — |
| 4.4 | Budgets, quotas, credits + STOP-on-exceed | — |
| 4.5 | Usage dashboard | — |
| 5 | **LOGGING / OBSERVABILITY** | spec 30 (logging) |
| 5.1 | Log types (11 categories) | — |
| 5.2 | Structured log schema | — |
| 5.3 | No private chain-of-thought — safe summaries only | — |
| 5.4 | Where logs surface in the admin panel | — |
| 6 | **TESTING STRATEGY** | spec 31 (testing) |
| 6.1 | Test types (16) → tooling | — |
| 6.2 | The 24 required E2E scenarios → module + command + expected result | — |
| 6.3 | Per-module "done" rule + command layout (per package + root) | — |
| 7 | Acceptance criteria (cross-cutting) | — |
| 8 | Folder/file placement of the cross-cutting code | — |

---

## 1. Cross-cutting placement & ownership

Security, cost, logging, and testing are **interceptor/middleware layers**, not standalone services. They wrap every privileged path in the backend trust zone (`services/api`, `services/gateway`, `services/worker` + `packages/agent-engine`). Per the stack doc, NestJS gives us **guards** (authn/authz), **interceptors** (audit, risk-gate, cost-meter, redaction), and **pipes** (Zod validation) applied uniformly.

| Concern | Lives in | Applied as | Phase |
|---|---|---|---|
| Risk classification + approval gate | `packages/agent-engine` (classifier) + `services/api` (`approvals` module) | Engine pre-tool hook + Nest interceptor | MVP P2 |
| Permission enforcement (tenancy, scopes) | `packages/auth` + `services/api` guards | Nest guard + Postgres RLS backstop | MVP P1 |
| Secrets encryption | `packages/crypto` | Called only in backend process | MVP P1 |
| Masking / redaction | `packages/logger` (redactor) | Logging boundary + LLM prompt builder + UI serializer | MVP P1 |
| Cost metering / budgets | `packages/llm` (token+cost capture) + `packages/queue` + `services/api` (`billing`) | Engine post-call hook + pre-flight estimator | MVP P2 |
| Audit + structured logging | `packages/logger` + `packages/db` (audit tables) | Nest interceptor (append-only writes) | MVP P1 |
| Testing harness | `packages/test-utils` + per-package `vitest` + root Playwright | Turborepo `test` task (merge gate) | MVP P0+ |

**Hard-rule anchor:** Safety, audit, masking, cost-tracking, telemetry are cross-cutting and embedded from Phase 1 (scope doc §Appendix A footnote). Nothing in this doc invents a parallel stack — it realizes the pinned one.

---

## 2. Shared TypeScript interfaces

> Authored in `packages/protocol` (risk + log + approval wire types) and `packages/db` (persisted row shapes), all **Zod-backed** (`z.infer` = the type) per stack doc §6.17. Sketches, not implementation.

```typescript
// packages/protocol/src/risk.ts — single source of the 4 levels (matches stack doc §7.6)
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_ORDER: Record<RiskLevel, number> =
  { low: 0, medium: 1, high: 2, critical: 3 };

// Whether a level requires explicit human approval before execution.
export const REQUIRES_APPROVAL: Record<RiskLevel, boolean> =
  { low: false, medium: false, high: true, critical: true };
```

```typescript
// packages/protocol/src/permission.ts — a grant of capability on a resource scope
export interface Permission {
  id: string;
  workspaceId: string;
  subjectType: 'user' | 'role' | 'tool' | 'connector' | 'sidecar';
  subjectId: string;                         // userId | roleName | toolName | ...
  capability:                                // verb on a resource class
    | 'file.read' | 'file.write' | 'file.delete'
    | 'shell.exec' | 'browser.navigate' | 'browser.submit'
    | 'api.read' | 'api.write' | 'email.send'
    | 'external.post' | 'secret.read' | 'sandbox.spawn';
  resourceScope: string;                     // canonicalized path glob | domain | api id | '*'
  mode: 'ro' | 'rw';                         // read-only vs read-write (sidecar folders, etc.)
  maxRisk: RiskLevel;                        // ceiling this grant auto-allows w/o approval
  grantedBy: string;                         // userId who granted
  expiresAt?: string;                        // ISO-8601; optional TTL (one-time grants)
  revokedAt?: string;                        // soft-revoke; null = active
}
```

```typescript
// packages/protocol/src/approval.ts — the approval request/decision wire shape
export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  taskId: string;
  workspaceId: string;
  action: string;                            // 'file.write' | 'email.send' | 'shell.exec' ...
  risk: RiskLevel;                           // always 'high' | 'critical' to reach here
  detail: string;                            // masked, human-readable ("write ~/Desktop/report.md")
  reasonCodes: string[];                     // ['outside_approved_scope','irreversible']
  proposedScopeGrant?: Omit<Permission, 'id' | 'grantedBy'>; // what 'approve' would grant
  createdAt: string;
  expiresAt: string;                         // auto-deny on timeout (default 15 min)
}

export interface ApprovalDecision {
  approvalId: string;
  decision: 'approved' | 'denied';
  decidedBy: string;                         // userId
  decidedAt: string;
  grantScope?: 'once' | 'session' | 'persistent'; // breadth of the grant on approve
}
```

```typescript
// packages/db — AuditLog: append-only, the product-grade audit trail
export interface AuditLog {
  id: string;                                // ULID (time-sortable)
  ts: string;                                // ISO-8601 (event time)
  workspaceId: string;
  userId: string | null;                     // null = system/automation actor
  sessionId: string | null;
  taskId: string | null;
  actor: 'user' | 'agent' | 'system' | 'sidecar' | 'automation';
  category: AuditCategory;                    // see §5.1
  action: string;                            // 'tool.file.write' | 'approval.granted' | 'auth.login'
  risk: RiskLevel | null;
  resource: string | null;                   // masked target (path/domain/api/recordId)
  decision: 'allowed' | 'denied' | 'approved' | 'auto' | null;
  approvalId: string | null;                 // links to the approval that gated it
  outcome: 'ok' | 'error' | 'blocked' | 'stopped';
  detail: Record<string, unknown>;           // masked JSONB payload (no secrets, no CoT)
  ipHash: string | null;                     // hashed source IP (privacy)
  prevHash: string | null;                   // hash chain → tamper-evident (admin export)
  rowHash: string;                           // sha256(prevHash + canonical(this row))
}

export type AuditCategory =
  | 'agent_action' | 'tool_call' | 'browser_action' | 'file_access'
  | 'api_call' | 'automation_run' | 'error' | 'security'
  | 'cost_token' | 'collaboration' | 'desktop_operator';
```

```typescript
// packages/db — UsageRecord: raw metered events (one per measurable unit of work)
export interface UsageRecord {
  id: string;
  ts: string;
  workspaceId: string;
  userId: string | null;
  sessionId: string | null;
  taskId: string | null;
  stepId: string | null;
  kind:                                       // what was consumed
    | 'llm_tokens' | 'tool_call' | 'browser_runtime'
    | 'worker_runtime' | 'sandbox_runtime' | 'storage_bytes' | 'egress_bytes';
  // llm token detail (zero for non-llm kinds):
  model: string | null;                       // 'claude-opus-4-8'
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;                   // tokens written to cache (~1.25x rate)
  cacheReadTokens: number;                    // tokens served from cache (~0.1x rate)
  // runtime/storage detail (zero for llm kinds):
  durationMs: number;                         // browser/worker/sandbox wall-clock
  bytes: number;                              // storage/egress
  unitCount: number;                          // generic counter (e.g. 1 tool call)
  requestId: string | null;                   // Anthropic response request-id, for reconciliation
}
```

```typescript
// packages/db — CostRecord: monetized rollup derived from UsageRecords (the money view)
export interface CostRecord {
  id: string;
  periodKey: string;                          // 'YYYY-MM' | 'YYYY-MM-DD' | sessionId | taskId
  scope: 'task' | 'session' | 'user' | 'workspace' | 'month';
  scopeId: string;
  workspaceId: string;
  currency: 'USD';
  llmInputUsd: number;
  llmOutputUsd: number;
  llmCacheUsd: number;                        // cache write + read priced separately
  toolUsd: number;
  browserUsd: number;
  workerUsd: number;
  sandboxUsd: number;
  storageUsd: number;
  totalUsd: number;
  inputTokens: number;                        // mirrored aggregates for the dashboard
  outputTokens: number;
  cacheReadTokens: number;
  computedAt: string;
  // budget state (denormalized for fast gate checks):
  budgetUsd: number | null;                   // applicable cap for this scope/period
  budgetConsumedPct: number | null;
  overBudget: boolean;
}
```

```typescript
// packages/protocol/src/log.ts — LogEntry: the structured operational/streamed log line
export interface LogEntry {
  id: string;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: 'api' | 'gateway' | 'worker' | 'engine' | 'sandbox' | 'sidecar' | 'web' | 'desktop';
  category: AuditCategory;                    // shared taxonomy with AuditLog
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  traceId: string | null;                     // OpenTelemetry trace id
  spanId: string | null;
  message: string;                            // human-readable, ALREADY REDACTED
  reasoningSummary?: string;                  // SAFE summary only — never raw chain-of-thought
  fields: Record<string, unknown>;            // structured, redacted context
  redacted: boolean;                          // true once the redactor has run (asserted in tests)
}
```

> **Why both `UsageRecord` and `CostRecord`:** raw metering (cheap, high-write, partitioned) is decoupled from monetization (pricing can change; cache-tier math is non-trivial). Budgets read the denormalized `CostRecord`, so the gate check is one indexed lookup, not a live aggregation.

---

## 3. SECURITY / PERMISSION MODEL

### 3.1 The 4 risk levels — exact definitions + example actions

Every tool call, terminal command, file op, browser action, API call, and automation carries exactly one `RiskLevel`. The classifier (§3.2) assigns it; `high`/`critical` **always** gate on approval (`REQUIRES_APPROVAL`). **Tag: MVP (P2).**

| Level | Definition (decision rule) | Reversibility / blast radius | Approval | Example actions |
|---|---|---|---|---|
| **low** | Read-only, in-sandbox, or fully reversible; touches no user secret/PII; no external write. | None / contained to sandbox. | **No** (auto) | web search; read a public page; `ls`/`cat`/`grep` in sandbox; read a sandbox file; list a workspace's own artifacts; token-count a prompt; screenshot a page. |
| **medium** | Mutates state the agent itself created, or reads user-scoped private data, but is reversible and stays inside the trust boundary. | Low; undoable within the workspace. | **No** (auto, but logged + masked) | write/edit a file **inside the sandbox or an already-approved RW folder**; create an artifact; read a *read-only*-scoped local folder (desktop); navigate to a known/allowlisted domain; run a non-mutating, non-blocklisted shell command (e.g. `python script.py` in sandbox). |
| **high** | Mutates resources **outside** an approved scope, sends/posts data externally, performs a write to a third-party API, or executes shell with side effects. Recoverable but with real-world effect. | Medium; affects user files/services/recipients. | **Yes** | write/modify a file **outside any approved scope** (e.g. user Desktop on first touch); `email.send`; submit a web form (`browser.submit`); `api.write` (POST/PUT/PATCH/DELETE to a 3rd party); post to a connector (Slack/GitHub/Notion); install a package; modify a local read-write folder for the first time. |
| **critical** | Irreversible, destructive, mass-affecting, or security-sensitive; or any action the blocklist flags as dangerous. | High; data loss, financial, identity, or large blast radius. | **Yes** (extra-confirm: typed reason or re-auth) | recursive/forced delete (`rm -rf`, `del /s`, drop table); bulk delete of records/files; sending money / placing an order / financial transaction; granting/altering permissions; rotating/exposing a secret; mass email/post (>N recipients); disabling security controls; overwriting system files; `git push --force` to a protected branch. |

**Invariants (asserted in tests):**
- A tool's *declared* `risk` in `packages/tool-abi` is a **floor**; the runtime classifier may **escalate** (never silently de-escalate) based on arguments and scope.
- `critical` can never be auto-approved by a workspace policy; only an explicit human decision clears it (extra-confirm).
- Destructive ops are `critical` **by default** (scope doc §8 risk table).

### 3.2 Risk classification engine (how a level is assigned)

Runs inside `packages/agent-engine` as a **pre-execution hook** on every `tool_call`, before the executor (sandbox or sidecar) is invoked. **Tag: MVP (P2).**

```typescript
// packages/agent-engine/src/risk-classifier.ts (sketch)
interface RiskInput {
  tool: ToolDef<unknown, unknown>;     // declared floor: tool.risk, tool.surface
  args: unknown;                       // the model's proposed arguments
  ctx: ToolContext;                    // session mode, approved scopes, workspace policy
}
interface RiskVerdict {
  risk: RiskLevel;
  reasonCodes: string[];               // why it landed here (audited, shown in approval)
  requiresApproval: boolean;
  extraConfirm: boolean;               // critical → typed reason / re-auth
  blocked: boolean;                    // hard-blocked (blocklist) — never even prompts
}
function classify(input: RiskInput): RiskVerdict;
```

Decision pipeline (first match wins, escalation-only):
1. **Hard blocklist** (terminal §3.8, CAPTCHA/2FA-bypass §3.15) → `blocked: true`, never executes, audited as `security`.
2. **Scope check** — is the target path/domain/api within an active `Permission` (`resourceScope`, `mode`)? Out-of-scope write/delete → at least `high`.
3. **Action class** — table in §3.9 maps verb → base level (e.g. `email.send` = high, `rm -rf` = critical).
4. **Argument heuristics** — recursion/force flags, wildcard/bulk counts, money keywords, recipient counts > threshold → escalate to `critical`.
5. **Floor merge** — final = `max(declaredFloor, pipelineLevel)`.
6. **Workspace policy** — a workspace may *raise* the auto-allow ceiling-no-further-than `maxRisk` of a relevant grant; it can never lower a `critical`.

The verdict is attached to the streamed `tool_call` event (`risk` field, stack doc §7.6) so the UI renders the badge; if `requiresApproval`, the engine emits `approval_request` and **pauses** (§3.3).

### 3.3 Approval flow (state machine + sequence)

**Tag: MVP (P2 engine gate; P3 web UI; P4 desktop).** The user can **stop any action instantly** at any state (global kill switch + per-action stop — scope doc §1.4).

**State machine (per gated action):**
```
            classify(high|critical)
PROPOSED ───────────────────────────► PENDING_APPROVAL
                                          │   │        │
                       approve            │   │ deny   │ timeout(expiresAt) / stop
                                          ▼   ▼        ▼
                                      APPROVED   DENIED / EXPIRED / STOPPED
                                          │
                                  execute (scoped)
                                          ▼
                                  EXECUTED ──► VERIFIED (engine re-checks result)
                                          └──► FAILED (recovery / replan)
```

**Sequence (the local-write example from stack doc §7.4 step 8–11):**
1. Engine classifies the final-step `file.write` to `~/Desktop/report.md` → no active scope → `high`.
2. Engine writes an `AuditLog{action:'tool.file.write', decision:'denied'(pending), risk:'high'}`, emits `approval_request` over `/chat`, and **sets `task.status = AWAITING_APPROVAL`**; the run loop blocks (no tool executes).
3. Renderer shows the masked approval prompt (`detail`, `reasonCodes`, the exact `proposedScopeGrant`). User can **Approve once / Approve for session / Approve persistently / Deny / Stop**.
4. Decision arrives over `/chat` (`approve`/`deny`) **or** REST (`POST /approvals/:id`). API validates the decider has the capability (§3.4), writes `ApprovalDecision`, audits it (`decision:'approved'`, `approvalId`).
5. On approve: a `Permission` is minted with the chosen breadth; the engine resumes, updates `device_config` (adds the folder scope), the sidecar performs the scoped write, streams a local audit entry.
6. Engine **verifies** (re-reads the artifact), emits `final_output`, finalizes cost. Every transition is an `AuditLog` row.

**Timeout & idempotency:** an unanswered approval auto-denies at `expiresAt` (default 15 min) and the step fails into recovery. Decisions are idempotent by `approvalId` (a duplicate `approve` is a no-op).

### 3.4 Backend-side permission enforcement

**Enforcement is server-side only; the client is never trusted.** **Tag: MVP (P1 tenancy; P2 risk-gate).**

- **Authn guard** (`packages/auth`): validates the cookie session (web) or bearer/socket token (desktop/sidecar) on every request and socket handshake (token in `auth`, never query — stack doc §6.18).
- **Tenancy guard:** every query is scoped by `workspaceId` derived from the *authenticated* principal, not from the request body. **Postgres Row-Level Security** is the backstop (stack doc §6.7) so a missed `WHERE` cannot leak cross-workspace rows.
- **Capability check** (risk-gate interceptor): before a tool executes, the engine confirms an active, unrevoked, unexpired `Permission` covers `{capability, resourceScope, mode}` with `maxRisk >= verdict.risk`; otherwise → approval or block. Approvers themselves are capability-checked (only a user with the resource's authority may approve).
- **Secret broker:** decryption happens **only** inside the API/engine process (§3.5); no endpoint ever returns plaintext secrets; the LLM key is fetched, used in-process, and never serialized to any wire payload or client bundle.
- **Defense in depth:** guard (deny by default) → RLS (backstop) → audit (every privileged mutation writes a row — scope doc Phase 1 acceptance).

### 3.5 Secrets: encryption at rest, keys never to frontend

**Tag: MVP (P1).** Realizes stack doc §6.20 (envelope encryption).

- **Algorithm:** **AES-256-GCM** (authenticated, with per-record IV + auth tag). **Envelope scheme:** a **master key in a KMS** (cloud KMS in prod; file-based master key in dev/self-host with a documented threat-model caveat) wraps a **per-secret data key (DEK)**; the DEK encrypts the secret payload. A DB dump alone yields only ciphertext; key rotation re-wraps DEKs without re-encrypting all data.
- **Stored secrets (data class `critical`):** the Anthropic API key (per-workspace BYO-key), OAuth client secrets, connector tokens, sidecar-issued tokens.
- **Decrypt boundary:** only `packages/crypto` inside the backend trust zone; never the renderer, never logs, masked in all surfaces.
- **Never-to-frontend guarantee (asserted):** the LLM key (and any secret) appears in **no** client artifact. CI **bundle scan** (stack doc §6.13 checklist #9, scope doc Phase 1) greps web + desktop bundles for secret/dev-endpoint patterns and **fails the build** on any hit. Settings round-trip stores envelope-encrypted; a settings GET returns a masked placeholder (`sk-ant-…••••`), never the value.

```typescript
// packages/crypto (sketch)
interface SecretVault {
  put(workspaceId: string, name: string, plaintext: string): Promise<{ ref: string }>; // encrypts
  use<T>(ref: string, fn: (plaintext: string) => Promise<T>): Promise<T>;               // decrypt in-process, never returns it
  mask(ref: string): string;                                                            // 'sk-ant-…••••' for UI
  rotateMaster(): Promise<void>;                                                        // re-wrap DEKs
}
```

### 3.6 Masking of sensitive data

**Tag: MVP (P1).** Centralized redactor in `packages/logger`, applied at **three boundaries**: (1) logs/audit sinks, (2) the LLM prompt builder (§3.14), (3) the UI/replay serializer (so shared replays are safe — scope doc Phase 3 acceptance).

| Class | Detection | Masked form |
|---|---|---|
| API keys / tokens | prefix patterns (`sk-ant-`, `ghp_`, `xox`-Slack, JWT `eyJ…`), entropy heuristic | `sk-ant-…••••` (last-4 kept for support) |
| Passwords | field-name match (`password`, `passwd`, `secret`, `pwd`) | `••••••••` (fully hidden) |
| Credit cards | Luhn-valid 13–19 digit sequences | `•••• •••• •••• 4242` |
| Identity / PII | SSN/national-id patterns, email, phone | `j•••@•••.com`, `•••-••-1234` |
| Sensitive messages | content flagged sensitive by the tool/connector | summarized; body withheld from logs/prompts |

The redactor runs **before** any write/stream; `LogEntry.redacted` is set true and **tests seed secrets and assert redaction** in every sink, prompt, and `device`/`chat` URL (scope doc Phase 3 / §F2).

### 3.7 Unauthorized file-read prevention

**Tag: MVP (P1 cloud sandbox; P4 sidecar read-only).** Two enforcement points:

- **Cloud sandbox:** file tools operate only within the per-session container filesystem (gVisor-isolated, stack doc §6.15); no host mount; egress-controlled. A path argument is canonicalized (`realpath`) and must resolve inside the session root.
- **Local sidecar (Rust):** every file op canonicalizes the path (`realpath`) and asserts it is a prefix of an **active, approved shared folder** at the granted `mode`. A `..` traversal or any path outside the scope is **refused and audited** (`security` category) before touching disk (scope doc Phase 4 / §E2; risk table §8). Read-only is the default; RW requires an explicit grant. Symlink targets are re-canonicalized to prevent escape.
- **No path from a tool argument is trusted verbatim** — classification (§3.2 step 2) treats any out-of-scope target as `high` and gates it.

### 3.8 Terminal risk analysis + dangerous-command blocklist

**Tag: MVP-lite (P2 in-sandbox; full gated shell P5 per scope doc §5).** Shell execution is parsed and risk-classified before running.

```typescript
// packages/agent-engine/src/terminal-guard.ts (sketch)
interface CommandVerdict { risk: RiskLevel; blocked: boolean; reasonCodes: string[]; }
function analyzeCommand(cmd: string, ctx: ToolContext): CommandVerdict;
```

Analysis steps:
1. **Tokenize** (shell-aware) to defeat obfuscation; expand aliases; detect chaining (`;`, `&&`, `|`, backticks, `$( )`).
2. **Hard blocklist (always `blocked`, never prompts):** fork bombs (`:(){ :|:& };:`), disk wipes (`dd of=/dev/sd*`, `mkfs`), `rm -rf /` and root-relative recursive deletes, `chmod -R 777 /`, credential exfiltration to external hosts, writing to system/boot paths, `curl … | sh` of untrusted URLs, anything attempting to read `~/.ssh`, `~/.aws`, `/etc/shadow`, keychains.
3. **Critical (approval + extra-confirm):** any recursive/forced delete (`rm -rf <path>`, `del /s /q`, `Remove-Item -Recurse -Force`), `DROP TABLE`/`TRUNCATE`, `git push --force`, package global installs, privilege changes, `kill -9` of non-owned PIDs.
4. **High:** network mutations, writes outside scope, installs, service control.
5. **Medium/low:** read-only/info commands in sandbox (`ls`, `cat`, `git status`, `python script.py` with no side effects).

The blocklist lives in `packages/agent-engine` as a versioned, test-covered table; CAPTCHA/2FA-bypass tooling is **not shippable** (§3.15).

### 3.9 Approval-gated action classes

These verb classes are **at least `high`** (approval required) by default; argument heuristics may escalate to `critical`. **Tag: MVP (P2).**

| Action class | Capability | Base risk | Escalates to critical when… |
|---|---|---|---|
| Delete | `file.delete` | high | recursive/force/wildcard, bulk count > N, protected path |
| Modify (out of scope) | `file.write` | high | overwrites system/config files, bulk |
| Email send | `email.send` | high | recipients > N (mass mail) |
| Form submit | `browser.submit` | high | payment/identity forms, irreversible submit |
| API write | `api.write` | high | DELETE verb, financial endpoint, bulk |
| External post | `external.post` | high | public/broadcast, > N targets |
| Money / order | `api.write` (financial) | **critical** | always (do-not-auto per computer-use rule) |
| Secret access/rotate | `secret.read` | **critical** | always |

> **Financial guardrail (from the desktop/computer-use rule):** the agent never executes a trade, places an order, sends money, or initiates a transfer on the user's behalf — these are `critical` and require the *user* to perform/confirm; AgentOS organizes and prepares but does not auto-execute money movement.

### 3.10 Browser-session deletion (user control)

**Tag: MVP-lite (P2 cloud sessions; full preferred-browser P5).** Each browser context (one Playwright context per session — stack doc §6.12) has persisted cookies/storage scoped to the session. The user can:
- **Delete a browser session** from the workspace UI → tears down the Playwright context, deletes its storage state + trace artifact, and audits the deletion (`browser_action`).
- **Clear all browser sessions** for the workspace (bulk) — `critical` if it would discard active logins, otherwise `medium`.
No credentials are persisted beyond the session unless the user explicitly saves a profile (LATER, preferred-browser).

### 3.11 Rate limiting

**Tag: MVP (P1).** Redis-backed (stack doc §6.10/§6.11 reuse) token-bucket / sliding-window limiters at multiple layers:

| Layer | Key | Limit (default, policy-tunable) |
|---|---|---|
| Auth endpoints | IP + account | login attempts (lockout + backoff) — anti-brute-force |
| REST API | userId + route class | per-minute request budget |
| Socket events | sessionId | client→server `approve`/`stop`/`takeover` flood guard |
| Task creation | workspaceId | concurrent + per-hour task caps (also a cost guard, §4.4) |
| Tool/automation | workspaceId | external-call rate (anti-spam/abuse, §3.15) |
| Sidecar `/device` | deviceId | reconnect-storm guard (staged backoff, stack doc §7.8) |

Exceeding a limit returns `429` (REST) or a typed `rate_limited` event (socket) and is audited (`security`).

### 3.12 CSRF / XSS / SQLi protections

**Tag: MVP (P1 backend; P0/P6 desktop CSP).**

- **CSRF:** web auth uses **HTTP-only, Secure, SameSite cookies** (stack doc §6.18); state-changing requests require a CSRF token / double-submit; the desktop PKCE deep-link carries a `state`/`nonce` guard.
- **XSS:** **full CSP** with per-request nonce (`default-src`, `connect-src`, `script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`), assets over the privileged `app://` protocol (no `file://`, no localhost HTTP), React's default escaping, and the redactor on any agent-produced HTML before render. No `dangerouslySetInnerHTML` on untrusted content; agent-generated HTML artifacts render in a sandboxed iframe.
- **SQLi:** Prisma parameterized queries everywhere; the **only** raw SQL is the documented `$queryRaw`/Kysely escape hatch (vector KNN, aggregations — stack doc §6.8), always with bound parameters, never string-built. CI lint bans string-concatenated SQL.
- **CORS:** scoped to our origins only — never a global `<all_urls>` strip (stack doc §6.13 checklist #3, the teardown's "single most dangerous thing").

### 3.13 Safe file-upload handling

**Tag: MVP (P2, with artifact store).**

- **Presigned uploads** straight to object storage (`BlobStore`) — large blobs never transit the API process (stack doc §6.16).
- **Validation:** enforce max size; verify declared MIME against **magic-byte sniffing** (not the filename/extension); reject mismatches.
- **Sanitization:** strip path components from filenames (`basename`), store under a content-addressed key (no user-controlled paths); never execute uploads; serve with `Content-Disposition: attachment` + a non-executing content type.
- **Scanning:** size/type quotas per workspace (cost + abuse); optional AV/scan hook (LATER).
- **Isolation:** uploads consumed by the agent are mounted read-only into the sandbox; office/PDF parsing runs in the sandbox, not the API process.

### 3.14 Minimizing private data sent to the LLM

**Tag: MVP (P2).** Directly serves the "avoid sending unnecessary private data" mandate (scope doc §1.2).

- **Redact-before-send:** the prompt builder runs the §3.6 redactor over every message, tool result, and retrieved memory before it reaches `LlmProvider`.
- **Scoped retrieval:** memory/RAG queries are filtered by `workspaceId`/`userId` in the same `WHERE` (pgvector tenancy, stack doc §6.9) so no cross-tenant private data is retrievable.
- **Local-first offload:** in desktop local mode, file *bytes* stay on the user's disk (sidecar); only the **model-necessary content** is sent (scope doc Phase 4 / §E4 — "file bytes never leave the machine"). Tests assert object storage is untouched and the secret never appears in the outbound prompt.
- **Chunking + summarization:** large files are chunked and summarized so only relevant spans (not whole private documents) are sent (§4.3).
- **No secrets, ever:** the LLM key and any `critical`-class secret are structurally excluded from prompts.

### 3.15 No CAPTCHA/2FA bypass; no spam/abuse

**Tag: MVP (hard rule, enforced in code from P2).** Non-negotiable (scope doc §1.3/§1.4/§8).

- **CAPTCHA/2FA:** the browser tool **detects** CAPTCHA/2FA challenge pages and **pauses → hands control to the user** (takeover, LATER) — it never attempts automated solving, and no solving tooling ships. This path is hard-blocked in the classifier (§3.2 step 1) and asserted in a test harness (scope doc Phase 5 / §3 of stack tests).
- **Spam/abuse:** automations and mail-to-task (LATER) require **sender allowlists**, rate limits (§3.11), **approval-before-execute**, and **dry-run preview** (scope doc §8 legal/ToS). Mass-send actions are `critical` (§3.9).
- **ToS-respecting automation:** browser automation respects robots/ToS; per-domain consent for the preferred browser (LATER).

---

## 4. COST / RESOURCE CONTROL

### 4.1 What we meter

**Tag: MVP-lite (P2 metering surfaced; full billing P10).** Every measurable unit emits a `UsageRecord` (§2); the worker rolls them into `CostRecord`s.

| Resource | Captured where | Unit | Source of truth |
|---|---|---|---|
| LLM tokens | `packages/llm` post-call (`usage.{input,output,cache_creation,cache_read}_input_tokens`) | tokens | Anthropic response `usage` + `request-id` (reconciliation) |
| Model cost | derived from tokens × pricing | USD | §4.2 pricing table |
| Tool cost | tool executor wrapper | per-call + any per-tool fee | tool-abi metadata |
| Browser runtime | sandbox-orchestrator | ms of Playwright/Chromium wall-clock | sandbox lifecycle |
| Worker runtime | BullMQ job timing | ms of job execution | queue |
| Sandbox runtime | sandbox-orchestrator | ms container alive (idle-reaped) | orchestrator |
| Storage | `BlobStore` head/put | bytes stored | object store |
| Egress | sandbox/api | bytes out | network accounting |

### 4.2 Cost-estimation method (token counting + Claude Opus pricing)

**Tag: MVP (P2). Model: `claude-opus-4-8`.** Pricing (per stack doc + Claude API reference, cached 2026-05):

| Component | Rate (per 1M tokens) | Multiplier |
|---|---|---|
| Input (uncached) | **$5.00** | 1.0× |
| Output | **$25.00** | 1.0× |
| Cache **write** (5-min TTL) | $5.00 base | **1.25×** → $6.25 |
| Cache **write** (1-hour TTL) | $5.00 base | **2.0×** → $10.00 |
| Cache **read** | $5.00 base | **0.1×** → $0.50 |

**Pre-flight estimate (before an expensive run):**
1. **Count input tokens accurately** via Anthropic's `messages.count_tokens` against `claude-opus-4-8` — **never `tiktoken`** (it undercounts Claude by ~15–20%, more on code). Count system + tool-ABI JSON schema + retrieved memory + user task.
2. **Estimate output tokens** from a per-task-type model (heuristic priors refined by historical `UsageRecord` data for similar tasks).
3. **Estimate step count** (planner's decomposition × expected tool round-trips) to project cumulative tokens across the ReAct loop.
4. **Apply cache projection:** the stable prefix (frozen system prompt + deterministic tool list) is counted once at write rate, then read rate on subsequent steps (§4.3).
5. **Add non-LLM projections** (browser/sandbox/worker ms × their rates).
6. `estUsd`, `estTokens` → emitted as a `cost_estimate` event (stack doc §7.6). If `estUsd > workspaceThreshold` (or projected to exceed remaining budget), set `overThreshold: true` and **pause for approval** before spending (scope doc Phase 2 / §C2).

```typescript
// packages/llm/src/cost.ts (sketch)
const OPUS_4_8 = { inUsdPerMTok: 5, outUsdPerMTok: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 };
function priceUsage(u: Pick<UsageRecord,'inputTokens'|'outputTokens'|'cacheWriteTokens'|'cacheReadTokens'>): number {
  return (u.inputTokens   / 1e6) * OPUS_4_8.inUsdPerMTok
       + (u.outputTokens  / 1e6) * OPUS_4_8.outUsdPerMTok
       + (u.cacheWriteTokens / 1e6) * OPUS_4_8.cacheWrite5m   // TTL-aware in practice
       + (u.cacheReadTokens  / 1e6) * OPUS_4_8.cacheRead;
}
async function estimateTask(plan: PlanStep[], ctx: EngineCtx): Promise<{ estUsd: number; estTokens: number }>;
```

> **Pricing is sourced from one constant** (`packages/llm`), so a price change is a one-line edit — mirroring the model-id-from-one-constant rule (stack doc §8).

### 4.3 Prompt-caching / summarization savings strategy

**Tag: MVP (P2).** Realizes stack doc §6.19 context management. Caching is a **prefix match** — order is `tools → system → messages`; any byte change in the prefix invalidates everything after it.

- **Cache the stable prefix:** frozen system prompt + **deterministically serialized** tool-ABI JSON schema (sorted keys) get a `cache_control: {type:'ephemeral'}` breakpoint. Subsequent ReAct steps in the same task read the prefix at **0.1×** instead of 1.0× — the dominant savings on multi-step runs.
- **Silent-invalidator audit (enforced):** no `Date.now()`/UUID/unsorted JSON/per-user string in the prefix; volatile content (the current question, timestamps) goes **after** the last breakpoint. CI/contract tests verify `cache_read_input_tokens > 0` across repeated-prefix steps (a zero means a silent invalidator — fail).
- **Minimum prefix:** Opus 4.8 caches only prefixes ≥ **4096 tokens**; shorter prefixes silently won't cache — the estimator accounts for this and won't project phantom savings.
- **Summarization + chunking:** long conversations use server-side **compaction** (beta, supported on Opus 4.8) to summarize earlier context as it approaches the window; large files are **chunked** and only relevant spans retrieved/summarized (also a privacy win, §3.14). Summaries replace raw history in the prompt, cutting input tokens.
- **Memory retrieval:** tenant-scoped pgvector retrieval injects only the top-k relevant memory, not whole stores.
- **Model tiering (LATER):** a cheaper planner / strong executor split (scope doc §8 cost table) once a second provider/model is wired — interface already abstracts it (`LlmProvider`).

**Net effect on the estimate:** the estimator models prefix-once-write + per-step-read, so a 10-step task's projected input cost is roughly `prefixWrite + 9×(prefixRead) + Σ(volatile inputs)` rather than `10×prefixFull`.

### 4.4 Budgets, quotas, credits + STOP-on-exceed

**Tag: MVP-lite (P2 caps + stop; full credits/tiers/Stripe P10).**

- **Hierarchical budgets:** per **task**, **session**, **user**, **workspace**, and **month** (`CostRecord.scope`). Each may carry a hard `budgetUsd` cap and soft warning thresholds (e.g. 80%).
- **Internal quota/credit system:** a workspace holds a credit balance; metered cost decrements it. Daily and monthly quotas (request/task/cost) enforced via Redis counters + the `CostRecord` rollup.
- **Pre-flight approval for expensive tasks:** if a task's estimate (§4.2) exceeds the workspace threshold or remaining budget, the run pauses for approval (`cost_estimate{overThreshold:true}`) before any spend.
- **STOP-on-exceed (hard rule):** the engine checks the budget gate **between steps** and **before** each expensive tool/LLM call. If a running task would push the scope over `budgetUsd`, the engine **stops the task** (status `STOPPED`, reason `budget_exceeded`), emits a `status` event, and audits it (`cost_token` + `security`). This reuses the same kill-switch machinery as the user stop (scope doc Phase 2 / instant-stop acceptance) — bounded halt (≤2s), in-flight tool/sidecar ops aborted (epoch-guarded).
- **Reconciliation:** metered token counts reconcile against Anthropic `usage`/`request-id` in a fixture test (scope doc Phase 2 acceptance).

```typescript
// packages/agent-engine/src/budget-gate.ts (sketch)
interface BudgetVerdict { allowed: boolean; reason?: 'over_task'|'over_workspace'|'over_month'|'no_credits'; remainingUsd: number; }
function checkBudget(scopeIds: { taskId; sessionId; userId; workspaceId }, projectedDeltaUsd: number): Promise<BudgetVerdict>;
```

### 4.5 Usage dashboard

**Tag: MVP-lite (P3 readout; full dashboard P7 admin).**

- **In-task cost readout** (P3): live `estUsd` / actual USD + token counts in the workspace UI (scope doc Phase 3 acceptance — "cost readout").
- **Usage dashboard** (P7, admin console): per user / workspace / month breakdown — tokens (input/output/cache-read), USD by component (LLM/tool/browser/worker/sandbox/storage), budget consumption %, top-cost tasks, cache-hit ratio (savings realized), and quota status. Powered by `CostRecord` aggregates (indexed, partitioned) — no live LLM calls to render.
- **Alerts:** threshold-crossing (80%/100%) surfaces in the Inbox/admin and can trigger a webhook (LATER).

---

## 5. LOGGING / OBSERVABILITY

> One first-party pipeline (structured logs → Postgres audit log + OpenTelemetry traces) + Sentry for errors only (stack doc §6.23). **No third-party fingerprinting.** **Tag: MVP (P1 logs/audit; tracing P2+).**

### 5.1 Log types (11 categories)

The shared `AuditCategory` taxonomy (used by both `AuditLog` and `LogEntry`):

| # | Category | What it records | Example |
|---|---|---|---|
| 1 | `agent_action` | High-level agent step summary (SAFE summary, not CoT) | "Planned 4 steps; researching EV chargers" |
| 2 | `tool_call` | Each tool invocation + result (masked args/output) | `tool.web_search{query:'…'}` ok |
| 3 | `browser_action` | Navigate/read/fill/submit/screenshot | `browser.navigate{domain:'example.com'}` |
| 4 | `file_access` | Read/write/delete + scope + decision | `file.write ~/Desktop/report.md → approved` |
| 5 | `api_call` | Outbound 3rd-party API calls | `api.write POST connector:slack` |
| 6 | `automation_run` | Scheduled/triggered runs (LATER) | `cron daily-brief fired` |
| 7 | `error` | Errors + recovery actions | `tool timeout → retry(2) → replanned` |
| 8 | `security` | Risk gates, blocks, denials, masking events | `rm -rf blocked (blocklist)` |
| 9 | `cost_token` | Token/cost metering + budget events | `step cost $0.18; workspace 62% of budget` |
| 10 | `collaboration` | Shares, comments, role changes (LATER) | `task shared with user B (viewer)` |
| 11 | `desktop_operator` | Sidecar lifecycle + local "what it touched" | `sidecar wrote 1 file in /Shared (rw)` |

Every **important/sensitive** action writes an `AuditLog` (append-only, Postgres, replayable, partitioned). Operational telemetry writes `LogEntry` (structured, OTel-traced). Sentry captures crashes/exceptions only.

### 5.2 Structured log schema

`AuditLog` and `LogEntry` shapes are in §2. Key properties:
- **Append-only** audit table, time-partitioned, with a **hash chain** (`prevHash`/`rowHash`) → tamper-evident export (scope doc Phase 7 admin acceptance).
- **Correlation:** `traceId`/`spanId` (OTel) span request → queue → engine → tool → sandbox; `sessionId`/`taskId`/`stepId` thread the agent run; `approvalId` links a gated action to its decision.
- **Redaction guaranteed:** every payload passes the §3.6 redactor; `redacted:true` asserted in tests; tokens/PII redacted in all sinks and in `device`/`chat` URLs (scope doc §F2).
- **Replay source:** the persisted event log re-renders a task deterministically (scope doc Phase 3 / §B1); the audit log carries the risk levels + approval decisions for the audit overlay.

### 5.3 No private chain-of-thought — safe summaries only

**Non-negotiable.** The model's raw private reasoning (thinking blocks) is **never** persisted, streamed to the client, logged, or shown in replays. Instead:
- The engine emits a **safe `reasoningSummary`** — a short, sanitized action/intent line ("Comparing 3 chargers on price and range") suitable for the activity log.
- `LogEntry.reasoningSummary` is the only reasoning surface; it is generated from the *action plan*, not from the thinking tokens.
- On Opus 4.8, thinking content is omitted by default (`display:'omitted'`); we keep it omitted in transit and **never** request summarized thinking into any user-facing or logged sink. Tests assert no raw-CoT field is ever written to audit/log/replay.

### 5.4 Where logs surface in the admin panel

**Tag: MVP (in-task activity P3); admin console LATER (P7).**
- **In-task Live Activity Panel (P3):** the right pane renders the streamed `tool_call`/`browser_action`/`file_access`/`error` events with an **audit overlay** (risk badge + approval decision per action) — the user watches what the agent does in real time.
- **Replay (P3):** any finished task re-renders its event stream (masked) — sharable safely.
- **Admin console (P7):** searchable/filterable audit log (by workspace/user/session/category/risk/date), **tamper-evident export** (hash-chain verified), the cost/usage dashboard (§4.5), security events feed (blocks/denials/rate-limits), and the per-tool permission ledger. RBAC-gated; export is itself audited.

---

## 6. TESTING STRATEGY

> Hard rule: **no module is "done" until its tests pass**, enforced by the Turborepo `test` task gating merges (stack doc §6.21, scope doc §H2). Stack: **Vitest** (unit/integration), **Playwright Test** (web + Electron E2E), **Testcontainers** (ephemeral Postgres+Redis+MinIO), **Rust `cargo test`** (sidecar), **contract tests** on `protocol`/`tool-abi`.

### 6.1 Test types (16) → tooling

| # | Test type | Tooling | Lives in | Phase |
|---|---|---|---|---|
| 1 | unit | Vitest (v8 coverage) | each package `*.test.ts` | P0+ |
| 2 | integration | Vitest + Testcontainers (PG/Redis/MinIO) | `services/*`, `packages/db` | P1+ |
| 3 | e2e | Playwright Test (web Chromium + `_electron`) | root `e2e/` | P3+ |
| 4 | browser | Playwright (sandbox Chromium) | `services/sandbox-orchestrator`, tool tests | P2+ |
| 5 | desktop smoke | Playwright `_electron` (launch packaged shell) | `apps/desktop` | P4+ |
| 6 | file parser | Vitest fixtures (PDF/xlsx/csv/office) | `packages/blob-store`, parser tests | P2+ |
| 7 | api | Supertest-style against ephemeral PG/Redis | `services/api` | P1+ |
| 8 | auth/permission | Vitest authz matrix + RLS tests | `packages/auth`, `services/api` | P1+ |
| 9 | queue/worker | Vitest + real Redis (Testcontainers) | `services/worker`, `packages/queue` | P1+ |
| 10 | scheduler | Vitest fake timers + BullMQ repeatable | `services/worker` (automations) | P6 |
| 11 | security | Vitest + custom harness (blocklist, redaction, bundle-scan, CSP/CORS) | `packages/agent-engine`, `packages/crypto`, `packages/logger`, root | P1+ |
| 12 | error recovery | Vitest with forced tool failures / chaos | `packages/agent-engine` | P2+ |
| 13 | artifact | Vitest + `BlobStore` (presign round-trip, versioning) | `packages/blob-store` | P2+ |
| 14 | collaboration | Vitest authz + Playwright multi-user | `services/api`, e2e | P7 |
| 15 | skills | Vitest (parameterized task-graph replay) | `packages/agent-engine` (skills) | P7 |
| 16 | mcp | Vitest sandboxed MCP exec + per-server scopes | `packages/tool-abi` (mcp), sandbox | P10 |

Plus **contract tests** on `packages/protocol`/`packages/tool-abi` (both client and server import them) — the highest-value tests in a streaming, tool-calling system (stack doc §6.21).

### 6.2 The 24 required end-to-end test scenarios → module + command + expected result

> Run via Playwright Test (`pnpm e2e`) against the one-command local stack (`docker compose up`), except the unit/integration-level safety checks noted. `T01–T24` are stable IDs. Command shown is the canonical invocation; Turborepo scopes it (`--filter`) per package where applicable.

| # | Scenario | Owning module(s) | Test command | Expected result |
|---|---|---|---|---|
| T01 | Sign in (web session) + desktop PKCE deep-link | `packages/auth`, `services/api`, `apps/desktop` | `pnpm --filter @app/auth test && pnpm e2e -g "T01"` | Login succeeds; PKCE code exchanged over HTTPS; **no plaintext token in the deep-link** (asserted); state/nonce mismatch rejected. |
| T02 | Submit NL task → inspectable plan + step decomposition | `packages/agent-engine`, `services/worker` | `pnpm e2e -g "T02"` | A `plan` event with ≥1 decomposed step arrives **before** any `tool_call`. |
| T03 | ReAct loop runs ≥3 chained tool calls → verified result | `packages/agent-engine`, sandbox | `pnpm e2e -g "T03"` | ≥3 `tool_call`/`tool_result` pairs (correlated by `callId`); engine verifies; `final_output` ends the stream. |
| T04 | Web search tool (cloud/headless browser) | `services/sandbox-orchestrator`, tool-abi | `pnpm e2e -g "T04"` | Browser activity renders in Live Activity; results returned; sensitive request data redacted in logs. |
| T05 | Sandbox code-exec + file read/write (in sandbox) | sandbox, `packages/blob-store` | `pnpm e2e -g "T05"` | Code runs in container; file written/read inside session root; no host access. |
| T06 | Read-only local file via sidecar (desktop) | `apps/sidecar`, `apps/desktop` | `cargo test -p sidecar && pnpm e2e -g "T06"` | Agent reads an RO shared folder; a **write attempt is denied and audited**. |
| T07 | High-risk action gates on approval | `packages/agent-engine`, `services/api` (approvals) | `pnpm e2e -g "T07"` | `approval_request{risk:'high'}` emitted; run **pauses**; nothing executes until `approve`; `deny` aborts cleanly; both audited. |
| T08 | Instant stop halts in-flight task | `packages/agent-engine`, `services/gateway` | `pnpm e2e -g "T08"` | `stop` aborts within one step boundary (≤2s); task→`STOPPED`; no further events; stop audited. |
| T09 | Critical command blocked (`rm -rf`) | `packages/agent-engine` (terminal-guard) | `pnpm --filter @app/agent-engine test -t "T09"` | Command **blocked** (blocklist) — never prompts/executes; `security` audit row. |
| T10 | Pre-flight cost estimate over threshold | `packages/llm`, `packages/agent-engine` | `pnpm e2e -g "T10"` | `cost_estimate{overThreshold:true}` emitted; run pauses for approval **before** spend. |
| T11 | Budget exceeded → task stopped | `packages/agent-engine` (budget-gate) | `pnpm --filter @app/agent-engine test -t "T11"` | Engine stops task at budget cap (`reason:'budget_exceeded'`); `status` STOPPED; audited. |
| T12 | Token + cost metering reconciles with provider | `packages/llm`, `packages/db` | `pnpm --filter @app/llm test -t "T12"` | Metered tokens/cost match a fixtured Anthropic `usage`/`request-id`; `CostRecord` rollup correct. |
| T13 | Prompt-cache hit on repeated prefix | `packages/llm` | `pnpm --filter @app/llm test -t "T13"` | `cache_read_input_tokens > 0` across repeated-prefix steps; estimator's savings projection matches. |
| T14 | Error recovery: forced tool failure → replan | `packages/agent-engine` | `pnpm --filter @app/agent-engine test -t "T14"` | Forced failure triggers retry/backoff then replanning; graceful give-up explained if unrecoverable. |
| T15 | Artifact store: presigned up/download + versioning | `packages/blob-store` | `pnpm --filter @app/blob-store test -t "T15"` | Presigned PUT/GET round-trip; second write creates a new version; old version retrievable. |
| T16 | Secret never in frontend; encrypted at rest | `packages/crypto`, root bundle-scan | `pnpm test:bundle-scan && pnpm --filter @app/crypto test -t "T16"` | LLM key in **no** client artifact; settings stored envelope-encrypted; DB dump yields only ciphertext. |
| T17 | Log/prompt/replay redaction | `packages/logger`, `packages/agent-engine` | `pnpm --filter @app/logger test -t "T17"` | Seeded secrets/PII redacted in all log sinks, the outbound LLM prompt, and shared replays; `device`/`chat` URLs masked. |
| T18 | Unauthorized file-read / path traversal prevented | `apps/sidecar`, sandbox | `cargo test -p sidecar -- traversal && pnpm e2e -g "T18"` | RO write + `../` escape both refused (canonicalized path + RO scope); audited. |
| T19 | Browser session deletion by user | `services/sandbox-orchestrator` | `pnpm e2e -g "T19"` | Context + storage + trace deleted; deletion audited; no residual cookies. |
| T20 | CSP/CORS/IPC posture (desktop hardening) | `apps/desktop` | `pnpm e2e -g "T20"` | Full CSP headers present; CORS scoped to our origins (no `<all_urls>`); only named typed IPC succeeds (no generic `invoke` passthrough). |
| T21 | Sidecar integrity gate + kill switch | `apps/desktop`, `apps/sidecar` | `pnpm e2e -g "T21"` | Tampered binary refused (codesign+hash-pin); dropping `/device` stops all sidecars (epoch guard); no orphans (PID-lockfile). |
| T22 | Replay reproduces event stream deterministically | `services/api`, `apps/web` | `pnpm e2e -g "T22"` | Finished task replays identically from the persisted event log; sensitive values masked. |
| T23 | CAPTCHA/2FA → pause + handoff (no bypass) | `packages/agent-engine`, browser tool | `pnpm --filter @app/agent-engine test -t "T23"` | Challenge page detected → agent **pauses and hands off**; no solving attempted; hard-blocked + audited. |
| T24 | Full MVP loop on **both** web and desktop | all MVP modules | `pnpm e2e -g "T24" --project=web --project=electron` | plan→tools→approval→recover→verify→deliver with audit/cost/stop passes identically on web (Chromium) and the Electron renderer (engine-uniformity check). |

> **Coverage of spec hard rules:** instant stop (T08), risk gate (T07), blocklist (T09), budget stop (T11), pre-flight estimate (T10), secrets-never-frontend (T16), masking (T17), unauthorized-read prevention (T18), no-CAPTCHA-bypass (T23), and the dual-surface MVP gate (T24) each map to a scenario. LATER scenarios (automations/scheduler T-series extensions, collaboration, skills, MCP) are added in their phases under the same `T##` convention.

### 6.3 Per-module "done" rule + test command layout

**Rule:** a module is not "done" until (a) its `vitest`/`cargo` suite passes, (b) any contract tests it touches pass, and (c) the relevant E2E scenarios (§6.2) are green. CI runs `install → typecheck → lint → test → e2e → build`; the `test` task **gates merges** (red blocks). No placeholders/TODOs in core paths; CI bundle-scan finds zero secrets (scope doc §7 global gate).

**Command layout (per package + root) — Turborepo task graph:**

```
# root package.json scripts (orchestrated by turbo.json: build → test → lint → e2e)
pnpm test            # turbo run test           — all unit + integration (per package), gated
pnpm test:unit       # turbo run test -- --no-integration
pnpm typecheck       # turbo run typecheck      — tsc --noEmit (strict) everywhere
pnpm lint            # turbo run lint           — eslint (incl. brand-literal + raw-SQL bans)
pnpm e2e             # playwright test          — web + electron projects (root e2e/)
pnpm test:bundle-scan# CI: grep web+desktop bundles for secrets/dev-endpoints (must be empty)
pnpm test:contract   # turbo run test --filter @app/protocol --filter @app/tool-abi
pnpm test:sidecar    # cargo test -p sidecar    — Rust: traversal/approval/reconnect
pnpm test:security   # turbo run test -- --grep security  (blocklist, redaction, CSP/CORS, RLS)

# per-package (each ships its own vitest suite; Turborepo runs them in dep order)
pnpm --filter @app/agent-engine test      # risk classifier, terminal-guard, budget-gate, recovery
pnpm --filter @app/llm test               # token count, cost pricing, cache projection, metering
pnpm --filter @app/crypto test            # envelope encryption, masking helpers
pnpm --filter @app/logger test            # redaction in every sink; reasoningSummary; no raw CoT
pnpm --filter @app/auth test              # PKCE, session, tenancy/authz matrix, RLS
pnpm --filter @app/db test                # migrations up/down, RLS, audit hash-chain
pnpm --filter @app/blob-store test        # presign round-trip, versioning, upload validation
pnpm --filter @app/queue test             # durable jobs, retries, cancellation
pnpm --filter @services/api test          # api integration (Testcontainers PG/Redis/MinIO)
pnpm --filter @services/gateway test      # socket auth handshake, fan-out, stop/approve
pnpm --filter @services/worker test       # job lifecycle, resumability, scheduler
```

CI matrix runs the JS suites (Vitest + Testcontainers, needs Docker), the Rust suite (`cargo test`), and the Playwright web+Electron E2E (the `--project=electron` leg validates engine uniformity, T24). Coverage thresholds enforced on core paths in the hardening phase (P11).

---

## 7. Acceptance criteria (cross-cutting)

> Inherits the global gate (all shipped modules tested; no placeholders/TODOs in core paths; no secrets in frontend bundle — CI-scanned). These are the cross-cutting-specific bars; each maps to a §6.2 scenario.

**Security / permission (P1–P2):**
- [ ] Every tool/terminal/file/browser/api action carries a `RiskLevel`; `high`/`critical` block pending approval (T07). *(scope doc Phase 2)*
- [ ] A `critical` action (`rm -rf`) is hard-blocked and never executes (T09); destructive ops default to `critical`.
- [ ] Approve/deny/timeout/stop transitions are audited with `approvalId` linkage; approver is capability-checked.
- [ ] LLM key (and any secret) appears in **no** client bundle; stored AES-256-GCM envelope-encrypted; DB dump = ciphertext only (T16).
- [ ] Secrets/PII redacted in every log sink, the outbound LLM prompt, and shared replays; `device`/`chat` URLs masked (T17).
- [ ] Path traversal / out-of-scope / RO-write refused by sandbox and sidecar (T18).
- [ ] CSP full (`default-src`/`connect-src`/`object-src 'none'`/nonce), CORS scoped to our origins, IPC named-typed-only (T20).
- [ ] CAPTCHA/2FA encountered → pause + handoff, never bypass (T23).
- [ ] Tenancy enforced (a user cannot read another workspace's rows); RLS backstop verified.

**Cost / resource (P2–P3):**
- [ ] Pre-flight `cost_estimate` produced; `overThreshold` pauses for approval before spend (T10).
- [ ] Token/cost metered per task/session/user/workspace/month; reconciles with provider `usage`/`request-id` (T12).
- [ ] Budget exceeded → task stopped (`budget_exceeded`), bounded halt, audited (T11).
- [ ] Prompt-cache hit verified (`cache_read_input_tokens>0`) and savings projection matches (T13).
- [ ] In-task cost readout (P3); usage dashboard per user/workspace/month (P7).

**Logging / observability (P1–P3):**
- [ ] Every important/sensitive action writes an append-only `AuditLog` with risk + decision; hash-chain tamper-evident.
- [ ] **No raw chain-of-thought** is ever persisted/streamed/logged/replayed — only safe `reasoningSummary` (asserted).
- [ ] Events replay deterministically from the persisted log; masked in replay (T22).
- [ ] OTel traces span request→queue→engine→tool→sandbox; Sentry captures a forced error (errors only).

**Testing (P0+):**
- [ ] Turborepo `test` task gates merges; a failing module's test blocks the pipeline (scope doc §H2).
- [ ] All 24 E2E scenarios green on the local stack; T24 passes on **both** web and Electron (engine uniformity).
- [ ] Contract tests on `protocol`/`tool-abi` fail on drift; bundle-scan finds zero secrets.

---

## 8. Folder / file placement of the cross-cutting code

> Conforms to stack doc §34. No new top-level dirs — the cross-cutting code lives in the already-defined packages/services.

```
packages/
├─ protocol/src/
│  ├─ risk.ts            # RiskLevel, RISK_ORDER, REQUIRES_APPROVAL
│  ├─ permission.ts      # Permission
│  ├─ approval.ts        # ApprovalRequest, ApprovalDecision
│  └─ log.ts             # LogEntry (+ AuditCategory shared)
├─ crypto/src/           # SecretVault — AES-256-GCM envelope encryption (KMS/master key)
├─ logger/src/
│  ├─ redactor.ts        # masking (keys/passwords/cards/PII/messages)
│  └─ audit.ts           # AuditLog writer (append-only, hash-chain), LogEntry emitter
├─ llm/src/
│  ├─ cost.ts            # Opus 4.8 pricing constant, priceUsage, estimateTask
│  └─ provider.ts        # LlmProvider (token capture, cache hints) — metering hook
├─ agent-engine/src/
│  ├─ risk-classifier.ts # classify() pipeline (§3.2)
│  ├─ terminal-guard.ts  # blocklist + analyzeCommand (§3.8)
│  ├─ budget-gate.ts     # checkBudget + STOP-on-exceed (§4.4)
│  └─ approval-gate.ts   # pause/resume state machine (§3.3)
├─ db/                   # AuditLog, UsageRecord, CostRecord tables + migrations + RLS
└─ test-utils/           # Testcontainers helpers, secret-seeding fixtures, contract harness

services/
├─ api/src/modules/
│  ├─ approvals/         # POST /approvals/:id, capability-checked decisions
│  ├─ billing/           # budgets, quotas, credits, CostRecord rollups, dashboard API
│  └─ settings/          # encrypted-secret CRUD (masked reads)
├─ gateway/             # socket auth handshake guard, token redaction, stop/approve relay
├─ worker/              # UsageRecord→CostRecord rollup jobs; budget-gate enforcement
└─ sandbox-orchestrator/# egress control, runtime metering, browser-session teardown

apps/
├─ sidecar/ (Rust)      # path canonicalization, RO/RW scope enforcement, local audit stream
└─ desktop/             # CSP nonce, named-typed IPC allowlist, sidecar integrity gate

e2e/                     # Playwright T01–T24 (web + electron projects)
infra/                   # compose.yaml (one-command stack for integration/E2E)
```

---

### Summary of conformance
- **Stack:** NestJS guards/interceptors, Zod contracts, Prisma+RLS+pgvector, BullMQ/Redis, Socket.IO `/chat`+`/device`, AES-256-GCM envelope encryption, `claude-opus-4-8` via `LlmProvider`, Vitest+Playwright+Testcontainers+cargo — all as pinned.
- **Scope/phases:** every feature tagged MVP (P0–P4) or LATER (P5–P13) consistent with Appendix A; the 24 E2E scenarios map onto the per-phase acceptance criteria; cross-cutting safety/audit/masking/cost from Phase 1.
- **Hard rules:** risk-gated approval, instant stop, secrets encrypted + never in frontend, masking everywhere, no unauthorized reads, dangerous-command blocklist, no CAPTCHA/2FA bypass, no spam — each realized and test-covered.
