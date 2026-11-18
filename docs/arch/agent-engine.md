# AgentOS — Agent Engine & Execution Core

> **Status:** Planning only. No code ships from this document — TypeScript appears solely as interface *sketches* to pin contracts.
> **Owner:** Agent Engine & Execution Core.
> **Scope of this doc:** Sections **13 (Agent Engine)**, **14 (Tool Registry)**, **15 (Queue/Worker)** plus **Memory & Context** and **Wide / Parallel Research**.
> **Conforms to:** `docs/00-scope-and-phases.md` (scope, phases, MVP/Later split) and `docs/01-stack-and-system-architecture.md` (stack, topology, wire contracts, folder layout). Where this doc names a stack element, model id, namespace, status enum, or package, it is the one already pinned in those docs — no contradictions, no re-litigation.
> **Companion docs:** `_research/MANUS_TEARDOWN.md`, `_research/BUILD_BLUEPRINT.md`.
> **Brand handling:** every literal "AgentOS" / `agentos://` / `com.agentos.*` derives from `packages/brand` (`BRAND.*`). Treat them as constants.

This module is implemented as **`packages/agent-engine`** (the brain library), **`packages/tool-abi`** (the typed, risk-tagged tool source of truth), **`packages/queue`** (typed BullMQ job/queue defs), and **`packages/memory`** (`MemoryStore` + pgvector). It is *run inside* **`services/worker`** (BullMQ consumers) and streams events to **`services/gateway`** (`/chat`). It persists to **PostgreSQL 16** via **`packages/db`** (Prisma), uses **Redis 7** (BullMQ broker + cache + cancel signal), calls the LLM via **`packages/llm`** (`LlmProvider`, default `claude-opus-4-8`), and executes tools in the **session sandbox** (`services/sandbox-orchestrator`) or via the **Rust sidecar** (`apps/sidecar`, local-first).

---

## Table of Contents

- [0. Conformance map & terminology](#0-conformance-map--terminology)
- [1. Architecture overview of the engine](#1-architecture-overview-of-the-engine)
- [2. Core TypeScript interface sketches](#2-core-typescript-interface-sketches)
- [3. The agent loop (precise state machine)](#3-the-agent-loop-precise-state-machine)
- [4. Task lifecycle state machine](#4-task-lifecycle-state-machine)
- [5. Engine subcomponents](#5-engine-subcomponents)
  - [5.1 Task Understanding](#51-task-understanding)
  - [5.2 Planner & Step Generator](#52-planner--step-generator)
  - [5.3 Tool Router](#53-tool-router)
  - [5.4 Executor](#54-executor)
  - [5.5 Verifier](#55-verifier)
  - [5.6 Error Recovery](#56-error-recovery)
  - [5.7 Safety / Risk Classifier](#57-safety--risk-classifier)
  - [5.8 Permission Manager](#58-permission-manager)
  - [5.9 Context Manager](#59-context-manager)
  - [5.10 Memory Manager](#510-memory-manager)
  - [5.11 Artifact Manager](#511-artifact-manager)
  - [5.12 Cost Estimator & Token Accounting](#512-cost-estimator--token-accounting)
  - [5.13 Checkpointing & Resume](#513-checkpointing--resume)
- [6. What a task must persist](#6-what-a-task-must-persist)
- [7. Tool Registry & tool ABI](#7-tool-registry--tool-abi)
  - [7.1 Tool definition interface](#71-tool-definition-interface)
  - [7.2 Registration & discovery](#72-registration--discovery)
  - [7.3 Router selection algorithm](#73-router-selection-algorithm)
  - [7.4 Claude tool-use ↔ registry mapping](#74-claude-tool-use--registry-mapping)
  - [7.5 Initial ~30 tools & risk levels](#75-initial-30-tools--risk-levels)
- [8. Queue / Worker topology](#8-queue--worker-topology)
- [9. Memory & Context](#9-memory--context)
- [10. Wide / Parallel Research](#10-wide--parallel-research)
- [11. Test scenarios & acceptance criteria](#11-test-scenarios--acceptance-criteria)
- [12. Feature inventory with MVP/LATER tags](#12-feature-inventory-with-mvplater-tags)

---

## 0. Conformance map & terminology

| Element | Pinned source | Used here as |
|---|---|---|
| Engine package | `packages/agent-engine` (§34.4 stack doc) | the library this doc specifies |
| Tool source of truth | `packages/tool-abi`, `ToolDef<I,O>` (§7.6 stack doc) | extended in §7 below |
| Event contract | `ServerToClientEvents` / `ClientToServerEvents` (§7.6) | event names reused verbatim; new internal events flagged |
| Realtime | Socket.IO `/chat` (users) + `/device` (sidecar) | engine publishes to `/chat` rooms keyed by `sessionId` |
| Queue | BullMQ on Redis 7, `@nestjs/bullmq`, flow parent/child | §8 |
| DB | PostgreSQL 16 + Prisma + pgvector (HNSW) | §6, §9 |
| LLM | `claude-opus-4-8` via `LlmProvider` (`complete`/`stream`/`countTokens`/`tools`/`cache`) | §5, §9 |
| Risk levels | `RiskLevel = 'low'|'medium'|'high'|'critical'` (§7.6) | §5.7 |
| Sandbox | container-per-session (Docker+gVisor) behind `SandboxProvider` | §5.4 cloud path |
| Sidecar | Rust binary, `/device` reconcile, RO/RW scopes, per-action approval | §5.4 local path |
| Kill switch | client `stop` + supervisor disconnect; checked between steps + aborts in-flight | §3, §8 |

**Terminology (single set used throughout):**

- **Session** — the top-level conversational/work container the user sees (row: `Session`). One session may host multiple tasks (follow-ups), but MVP treats **one task per session turn**.
- **Task** — one unit of agent work with a plan, steps, artifacts, audit, final output (row: `Task`).
- **Plan** — an ordered, inspectable list of **Steps** produced by the planner; revisable by replanning.
- **Step** — one planned unit of progress; may map to zero, one, or many **ToolCalls** (a step can be reasoning-only).
- **ToolCall** — one concrete invocation of a registered tool with validated args, a risk level, an approval state, and a result.
- **Iteration / turn** — one pass of the agent loop = one LLM call + the tool calls it requests + observation.
- **Checkpoint** — a durable snapshot of resumable engine state in Postgres (see §5.13).

> **`TaskStatus` naming:** the wire/event layer (§7.6 stack doc, `final_output`/`status`) shows UI-facing labels; the brief enumerates the lifecycle states `created, planning, waiting_for_approval, running, paused, retrying, failed, completed, cancelled`. We adopt **those nine** as the canonical `TaskStatus` enum (§4) and map them to the coarse UI `status` event. This is additive to — not in conflict with — the stack doc, which only sketched `PENDING/COMPLETED/STOPPED` illustratively. `cancelled` is the canonical name for the stack doc's `STOPPED`.

---

## 1. Architecture overview of the engine

```
services/worker (BullMQ consumer host)
  └── packages/agent-engine  ── AgentRuntime (one instance per running Task)
        ├─ TaskUnderstanding      → normalized intent + constraints + acceptance criteria
        ├─ Planner / StepGenerator→ Plan { Step[] }            (LLM, cache-friendly)
        ├─ ContextManager         → builds each LLM request (cache blocks, summaries, memory)
        ├─ ToolRouter             → maps model tool_use → ToolDef from registry
        ├─ SafetyRiskClassifier   → final risk for each ToolCall (static ⊕ dynamic)
        ├─ PermissionManager      → scope check + approval gating (emits approval_request)
        ├─ Executor               → runs ToolDef.execute in sandbox | sidecar
        ├─ Verifier               → checks step + final result against acceptance criteria
        ├─ ErrorRecovery          → retry / reroute / replan / give-up
        ├─ CostEstimator          → pre-flight + live token/cost metering
        ├─ MemoryManager          → retrieve (pre) + write-back (post) via MemoryStore
        ├─ ArtifactManager        → register/version artifacts via BlobStore
        └─ Checkpointer           → persist resumable state to Postgres between steps

  Emits  → ServerToClientEvents on /chat room(sessionId) via gateway (Redis pub/sub)
  Reads  ← ClientToServerEvents (stop/approve/deny/takeover) via a Redis control channel
  Writes → Postgres (event log, audit log, tasks/steps/tool_calls, usage), BlobStore (artifacts)
```

**Design stance (inherited):** the brain is ~90% server-side; the client is a thin renderer of streamed events. The engine never trusts the client for anything but control intents (stop/approve/deny/takeover), and never exposes secrets. Every tool call is risk-tagged; `high`/`critical` gate to approval; the user can stop instantly.

---

## 2. Core TypeScript interface sketches

> Sketches only — they pin contracts. Runtime validation is Zod (`z.infer` → these types). These live in `packages/agent-engine` and `packages/tool-abi`; `RiskLevel`, the socket event maps, `DeviceConfig`/`DeviceStatus`, and base `ToolDef` are imported from `packages/protocol` / `packages/tool-abi` as already defined in the stack doc.

```typescript
// ─────────────────────────────────────────────────────────────────────────
// packages/protocol (already pinned) — re-stated for reference
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ─────────────────────────────────────────────────────────────────────────
// packages/agent-engine/src/types.ts  (this doc's additions)

type TaskStatus =
  | 'created' | 'planning' | 'waiting_for_approval' | 'running'
  | 'paused' | 'retrying' | 'failed' | 'completed' | 'cancelled';

type StepStatus =
  | 'pending' | 'running' | 'waiting_for_approval'
  | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

type ToolCallStatus =
  | 'proposed'            // model requested it; not yet risk-classified
  | 'awaiting_approval'   // gated, paused on user
  | 'approved'
  | 'denied'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'aborted';            // killed by stop / epoch guard

interface Task {
  id: string;
  sessionId: string;
  workspaceId: string;
  projectId?: string;
  userId: string;
  prompt: string;                       // raw natural-language input
  intent?: TaskIntent;                  // §5.1 normalized understanding
  status: TaskStatus;
  plan?: Plan;
  steps: Step[];
  mode: 'cloud' | 'local_first';        // decides default tool surface
  budget: TaskBudget;                   // §5.12
  costActual: CostUsage;                // running totals
  costEstimate?: CostEstimate;          // pre-flight
  retryCount: number;                   // task-level replans consumed
  epoch: number;                        // bumped on resume; guards stale ops
  checkpoint?: CheckpointRef;           // §5.13
  finalOutput?: FinalOutput;
  error?: TaskError;
  createdAt: string; updatedAt: string;
}

interface Plan {
  id: string;
  version: number;                      // incremented on replan
  rationale: string;                    // short, user-visible "why this plan"
  acceptanceCriteria: string[];         // what "done" means; drives the Verifier
  steps: Step[];
  estimatedToolCalls: number;
}

interface Step {
  id: string;
  taskId: string;
  index: number;                        // order within plan version
  title: string;                        // user-visible
  description: string;                  // model-facing intent
  status: StepStatus;
  dependsOn: string[];                  // step ids (enables limited parallelism)
  toolCalls: ToolCall[];
  attempts: number;
  maxAttempts: number;                  // from retry policy / budget
  verification?: VerificationResult;    // §5.5
  startedAt?: string; endedAt?: string;
}

interface ToolCall {
  id: string;                           // == protocol callId on the wire
  stepId: string;
  tool: string;                         // ToolDef.name
  args: unknown;                        // validated against ToolDef.input
  surface: 'cloud' | 'local' | 'either';
  staticRisk: RiskLevel;                // from ToolDef.risk
  effectiveRisk: RiskLevel;             // after dynamic classification (§5.7)
  status: ToolCallStatus;
  approvalId?: string;                  // set when gated
  result?: ToolResult;
  redacted?: boolean;                   // sensitive output masked before logging
  startedAt?: string; endedAt?: string;
  durationMs?: number;
  retryOf?: string;                     // prior ToolCall id if this is a retry
}

interface ToolResult {
  ok: boolean;
  output?: unknown;                     // validated against ToolDef.output
  error?: { code: string; message: string; retryable: boolean };
  artifacts?: ArtifactRef[];
  observedRisk?: RiskLevel;             // tool may escalate (e.g. CAPTCHA seen)
  metrics?: { bytes?: number; httpStatus?: number };
}

interface AgentContext {              // passed read-mostly through the loop
  task: Task;
  workspace: { id: string; name: string; settings: WorkspaceSettings };
  memory: MemoryManager;             // retrieve / write
  llm: LlmProvider;                  // claude-opus-4-8 adapter
  registry: ToolRegistry;            // §7
  artifacts: ArtifactManager;
  emit: (e: EngineEvent) => void;    // publishes to /chat room
  signal: AbortSignal;               // tripped by stop / epoch change
  logger: RedactingLogger;           // tokens/PII redacted at sink
  now: () => Date;                   // injectable clock (testability)
  epoch: number;                     // current run epoch
}

// ToolContext is the *per-call* slice handed to ToolDef.execute (narrower than AgentContext)
interface ToolContext {
  taskId: string; sessionId: string; workspaceId: string;
  surface: 'cloud' | 'local';
  sandbox?: SandboxHandle;           // cloud path
  sidecar?: SidecarChannel;          // local-first path
  blob: BlobStore;
  signal: AbortSignal;
  approval: ApprovalGrant | null;    // present iff gated & approved
  logger: RedactingLogger;
  emitProgress: (partial: unknown) => void;  // streamed tool progress
}
```

Supporting value types (`TaskIntent`, `TaskBudget`, `CostEstimate`, `CostUsage`, `VerificationResult`, `FinalOutput`, `CheckpointRef`, `ArtifactRef`, `ApprovalGrant`, `EngineEvent`) are defined inline in the sections that own them below.

---

## 3. The agent loop (precise state machine)

The loop is a deterministic, checkpoint-between-iterations state machine. Every transition is logged to the event log; every iteration is bounded by step/iteration/token/wall-clock budgets; the `AbortSignal` is checked at every labeled boundary so a `stop` halts within one step boundary.

### 3.1 Loop states

```
INIT → UNDERSTAND → PLAN → (COST_GATE) → SELECT_STEP → ROUTE → CLASSIFY_RISK
     → (APPROVAL_GATE) → EXECUTE → OBSERVE → VERIFY_STEP
     → {next step | REPLAN | RECOVER} → … → VERIFY_FINAL → DELIVER → DONE
                                          �‖ (any boundary) → ABORTED
```

### 3.2 State table

| State | Action | Emits (`/chat`) | Next |
|---|---|---|---|
| **INIT** | Load task + workspace + memory handles; set `epoch`; install AbortSignal listener (Redis control channel). | `status: planning` | UNDERSTAND |
| **UNDERSTAND** | TaskUnderstanding → `TaskIntent` (goal, constraints, deliverable, acceptance criteria, sensitivity, ambiguity). If `ambiguityScore` high → emit a clarifying `approval_request`/`message` and PAUSE. | `message` (intent summary) | PLAN |
| **PLAN** | Planner builds cache-friendly prompt → `Plan{steps[]}`. Persist plan v1. | `plan` | COST_GATE |
| **COST_GATE** | CostEstimator pre-flight; if `estUsd > workspace.threshold` or risk-heavy → emit `cost_estimate{overThreshold:true}` and PAUSE for approval. | `cost_estimate` | SELECT_STEP (or wait) |
| **SELECT_STEP** | Pick next `pending` step whose `dependsOn` are `succeeded`. If none left → VERIFY_FINAL. Check budgets + AbortSignal. | — | ROUTE |
| **ROUTE** | ToolRouter resolves the model's requested `tool_use` (or a reasoning-only step) to a `ToolDef`. Validate args against `ToolDef.input` (Zod). | `tool_call` (status proposed) | CLASSIFY_RISK |
| **CLASSIFY_RISK** | SafetyRiskClassifier computes `effectiveRisk` (static ⊕ dynamic). | — | APPROVAL_GATE |
| **APPROVAL_GATE** | PermissionManager: if scope already granted AND `effectiveRisk ∈ {low,medium}` → proceed; else emit `approval_request`, set status `waiting_for_approval`, PAUSE until `approve`/`deny` (or stop). | `approval_request` | EXECUTE / (denied→RECOVER) |
| **EXECUTE** | Executor runs `ToolDef.execute(args, toolCtx)` on the chosen surface; streams progress; enforces per-tool timeout; honors AbortSignal. | `tool_call` (running), progress | OBSERVE |
| **OBSERVE** | Persist `ToolResult` (redacted), append to event/audit log, feed observation back to the model on next turn. Update token/cost. | `tool_result` | VERIFY_STEP |
| **VERIFY_STEP** | Verifier checks step output against its mini-criteria. Pass → mark step `succeeded`. Fail → RECOVER. | `message` (verify note) | SELECT_STEP / RECOVER / REPLAN |
| **RECOVER** | ErrorRecovery decides: retry (same args, backoff) / reroute (alt tool) / replan / give-up. Bumps counters. | `message`/`status: retrying` | EXECUTE / ROUTE / REPLAN / DELIVER(failed) |
| **REPLAN** | Planner revises remaining plan from current state (new `Plan.version`). Caps replans. | `plan` (vN+1) | SELECT_STEP |
| **VERIFY_FINAL** | Verifier checks the whole deliverable against `Plan.acceptanceCriteria`. Fail (and budget left) → REPLAN; else DELIVER with caveats. | `message` | DELIVER |
| **DELIVER** | ArtifactManager finalizes; emit `final_output`; finalize cost; status `completed` or `failed`. | `final_output`, `status` | DONE |
| **ABORTED** | Any boundary sees `signal.aborted`: abort in-flight tool (and sidecar op, epoch-guarded), persist partial, status `cancelled`. | `status: cancelled` | DONE |
| **DONE** | Write final checkpoint; release sandbox/sidecar handles; job completes. | — | — |

### 3.3 Loop invariants (enforced + tested)

1. **A `stop` aborts within one step boundary** (acceptance: ≤2s, §11). The AbortSignal is checked at INIT, SELECT_STEP, ROUTE, before/after EXECUTE, OBSERVE; `ToolContext.signal` is the same signal so in-flight HTTP/WS aborts.
2. **No `high`/`critical` ToolCall executes without an `approved` `ApprovalGrant`.** Enforced in APPROVAL_GATE, not in the tool.
3. **Every state transition appends exactly one event-log row** (replayable) and risk-bearing transitions append an audit row.
4. **Budgets are hard ceilings.** Exceeding any budget routes to RECOVER→give-up with a clear explanation, never silent continuation.
5. **The model never sees raw secrets/PII.** ContextManager redacts before constructing the prompt (§5.9, §9).
6. **Checkpoint precedes every EXECUTE and every PAUSE**, so a worker crash resumes without re-executing a completed side-effecting tool (§5.13).

---

## 4. Task lifecycle state machine

Canonical `TaskStatus` enum and allowed transitions (the brief's nine states). UI `status` events collapse these to the labels the renderer shows.

### 4.1 States

| State | Meaning |
|---|---|
| `created` | Row exists; job enqueued; not yet picked up. |
| `planning` | Understanding + planning in progress (also covers active LLM planning turns). |
| `waiting_for_approval` | Paused on a user decision: cost gate, risk gate, or clarification. |
| `running` | Actively executing steps/tools. |
| `paused` | Paused by the user (soft pause, not a decision gate) or by a budget soft-warning hold. |
| `retrying` | In ErrorRecovery (retry/reroute/replan) between attempts. |
| `failed` | Terminal: gave up after recovery exhausted, or unrecoverable error. |
| `completed` | Terminal: verified deliverable produced. |
| `cancelled` | Terminal: user `stop` (kill switch) or admin/budget hard-cancel. |

### 4.2 Allowed transitions

```
created ──────────────► planning
planning ─────────────► waiting_for_approval   (clarification | cost gate)
planning ─────────────► running                (plan accepted / no gate)
planning ─────────────► failed                 (planning error, no recovery)
waiting_for_approval ─► running                (approve)
waiting_for_approval ─► failed                 (deny on a required step)
waiting_for_approval ─► cancelled              (stop while waiting)
running ──────────────► waiting_for_approval    (risk/cost gate hit mid-run)
running ──────────────► paused                 (user soft-pause)
running ──────────────► retrying               (step failure → recovery)
running ──────────────► completed              (final verify pass)
running ──────────────► failed                 (unrecoverable / budget exhausted)
running ──────────────► cancelled              (stop)
paused ───────────────► running                (resume)
paused ───────────────► cancelled              (stop)
retrying ─────────────► running                (retry/reroute/replan proceeds)
retrying ─────────────► waiting_for_approval    (replan introduces a gated step)
retrying ─────────────► failed                 (recovery exhausted)
retrying ─────────────► cancelled              (stop)
```

**Terminal states:** `completed`, `failed`, `cancelled` (no outgoing transitions). Every other state can reach `cancelled` (kill switch is universal). Illegal transitions throw (guarded by a transition table in `packages/agent-engine`) and are unit-tested (§11 L-series).

---

## 5. Engine subcomponents

### 5.1 Task Understanding

Converts the raw prompt + lightweight context into a normalized, model-and-machine-readable intent. One cheap LLM call (cacheable system prompt) producing a Zod-validated `TaskIntent`.

```typescript
interface TaskIntent {
  goal: string;                          // one-sentence objective
  deliverable: { kind: 'report'|'file'|'spreadsheet'|'answer'|'action'; detail: string };
  constraints: string[];                 // explicit limits ("under $500", "by Friday")
  inputsReferenced: { type: 'file'|'url'|'connector'|'folder'; ref: string }[];
  acceptanceCriteria: string[];          // seeds Plan.acceptanceCriteria
  sensitivity: 'none' | 'low' | 'high';  // drives masking aggressiveness
  ambiguityScore: number;                // 0..1; >threshold → ask, don't guess
  suggestedMode: 'cloud' | 'local_first';
}
```

- **Ambiguity handling:** above threshold, the engine asks **one** consolidated clarifying question (a `message` + optional `approval_request`) rather than guessing — aligns with "no fake/guessed work." Configurable; MVP asks at most one round to avoid stalling.
- **Sensitivity** raises masking aggressiveness in ContextManager and forces local-first for `high` when the desktop sidecar is available.

**Tag: MVP** (ambiguity round = MVP-lite; multi-turn clarification = LATER).

### 5.2 Planner & Step Generator

Produces an explicit, inspectable `Plan`. The plan is **data, not prose**: an ordered `Step[]` with `dependsOn`, each step naming the *capability* it needs (not yet a concrete tool — that's the router's job at runtime), so the plan survives tool substitution during recovery.

- **Prompt construction:** system prompt + tool *capability catalog* (names/descriptions/risk, JSON-Schema'd from `tool-abi`) + retrieved memory + intent. Built cache-friendly (stable prefix → prompt caching, §9).
- **Output:** strict JSON (validated by Zod) → `Plan{version, rationale, acceptanceCriteria, steps[]}`.
- **Replanning:** on VERIFY/RECOVER, the planner is re-invoked with *current state* (succeeded steps, failures, observations) and asked to revise only the *remaining* steps; `Plan.version` increments; superseded steps are marked `skipped` (audited, not deleted — replay must reconstruct both versions).
- **Step budget:** the planner is told the remaining step/tool/cost budget so it scopes plans to fit.

**Tag: MVP.** Hierarchical/parallel sub-planning → §10 (LATER).

### 5.3 Tool Router

Maps the model's requested action to a concrete registered tool. Two routing modes coexist:

1. **Model-driven (primary, MVP):** the LLM is given the tool JSON Schemas (Anthropic tool-use) and emits `tool_use` blocks; the router resolves `tool_use.name` → `ToolDef`, validates `tool_use.input` against `ToolDef.input` (Zod). Unknown/invalid → a structured `tool_result` error fed back so the model self-corrects (bounded by retry budget).
2. **Capability-driven (recovery/reroute):** when ErrorRecovery wants an *alternative* tool for the same capability, the router queries the registry by `capability` tag and picks by `(surface match, lower risk, higher historical success, lower cost)`.

Surface resolution: `ToolDef.surface` ∩ `task.mode` decides cloud vs local; `either` defaults to `task.mode`. A `local`-only tool on a web session is unavailable → router surfaces a clear "requires desktop" `tool_result` error rather than failing opaquely.

**Tag: MVP** (model-driven + simple capability fallback). Learned routing/scoring → LATER.

### 5.4 Executor

Runs `ToolDef.execute(args, toolCtx)` on the resolved surface.

- **Cloud path:** acquires a `SandboxHandle` from `services/sandbox-orchestrator` (container-per-session, Docker+gVisor), runs terminal/file/browser tools inside it. Network egress policy + request/response redaction enforced before logging (Playwright interception).
- **Local-first path:** the engine updates the session's `device_config` (adds the needed folder scope/mode); the gateway pushes it over `/device`; the desktop sidecar (hash-pinned) performs the op on the user's real disk under the granted scope and streams `device_status` + a local audit entry. The desktop app supervises; it is **not** in the file-write data path. Sidecar dials the session WS directly.
- **Per-tool timeout** (from `ToolDef.timeoutMs`) wrapped around the call; on timeout → AbortSignal local to the call → `ToolResult{error.retryable}`.
- **Progress streaming:** `toolCtx.emitProgress` coalesces partials in the gateway (backpressure) before bulk DB write.
- **Idempotency:** side-effecting tools declare an `idempotencyKey` strategy so a resume after crash does not double-apply (§5.13).

**Tag: MVP** (cloud sandbox + read-only local files). Local write/shell = Phase 5 (LATER), but the executor contract is MVP.

### 5.5 Verifier

Two scopes:

- **Step verification (lightweight):** checks the `ToolResult` against the step's success condition (schema-valid output, no error, expected artifact exists, non-empty, http 2xx, etc.). Mostly deterministic; an LLM "does this output satisfy the step?" check only when the condition is semantic.
- **Final verification:** checks the assembled deliverable against `Plan.acceptanceCriteria` — re-reads written artifacts (via the `file_read` tool / sidecar) to confirm existence + well-formedness, runs declared checks (e.g. "report has all 3 chargers compared"), and produces a `VerificationResult`.

```typescript
interface VerificationResult {
  passed: boolean;
  checks: { criterion: string; passed: boolean; evidence?: string }[];
  confidence: number;                    // 0..1
  shortfalls: string[];                  // unmet criteria → drive replan or caveats
}
```

A failed final verification with remaining budget triggers REPLAN; with no budget, DELIVER proceeds but `final_output.caveats` lists shortfalls (never a silent false "done").

**Tag: MVP** (deterministic + single LLM check). Rich evaluator rubrics → LATER.

### 5.6 Error Recovery

A decision function over a failed step/tool:

```typescript
type RecoveryDecision =
  | { action: 'retry';   backoffMs: number }                 // transient
  | { action: 'reroute'; toolName: string }                  // alternative tool, same capability
  | { action: 'replan' }                                     // strategy was wrong
  | { action: 'ask';     approval: ApprovalRequest }         // needs user input/permission
  | { action: 'give_up'; reason: string };                   // budget out / unrecoverable
```

Decision inputs: `error.retryable`, attempt counts (`step.attempts`, `task.retryCount`), budget remaining, error class (network/timeout/validation/permission/tool-internal/policy), and whether an alternative tool exists.

- **Retry:** transient/`retryable` errors, capped by `step.maxAttempts`, exponential backoff with jitter (reuses the staged backoff family from the stack doc).
- **Reroute:** capability has another tool (e.g. `web_search` provider B) and the first failed non-transiently.
- **Replan:** repeated step failure or a verification shortfall the planner should address differently. Capped (`maxReplans`, default 2).
- **Ask:** a `permission`/`policy` error (e.g. CAPTCHA encountered, scope missing) → escalate to user, never bypass.
- **Give up:** budget exhausted or no path forward → graceful `failed` with a plain-language explanation in `final_output`.

**Tag: MVP** (retry/reroute/replan/give-up). Adaptive backoff tuning → LATER.

### 5.7 Safety / Risk Classifier

Computes `effectiveRisk` for every ToolCall = **static** (`ToolDef.risk`) **escalated by dynamic** signals:

| Dynamic signal | Effect |
|---|---|
| Write/delete outside any pre-approved scope | escalate to ≥`high` |
| Destructive shell pattern (`rm -rf`, `format`, `drop`, `:>`) | escalate to `critical` |
| Egress to a domain not on the task's allowlist | escalate ≥`medium` |
| Spend above the per-call cost threshold | escalate ≥`high` |
| CAPTCHA/2FA page detected by the browser tool | **never auto-solve** → force `ask`/takeover (policy) |
| Sensitive data about to leave the machine (local-first) | escalate + mask |
| Bulk operation (>N files, >N recipients) | escalate ≥`high` (anti-spam) |

```typescript
interface RiskAssessment {
  staticRisk: RiskLevel;
  effectiveRisk: RiskLevel;
  reasons: string[];                     // human-readable, shown in approval UI
  requiresApproval: boolean;             // effectiveRisk ∈ {high, critical} OR scope-miss
  policyBlock?: { rule: string };        // hard stop (e.g. CAPTCHA bypass) — cannot be approved away
}
```

- **Policy blocks** (CAPTCHA/2FA bypass, ToS-violating automation, spam thresholds) are **non-approvable**: the only resolution is user takeover or task abort — enforcing the brief's hard rules in code.
- The classifier is deterministic + rule-based (auditable), with an optional LLM second-opinion for ambiguous destructive intent (advisory only; can only *raise* risk, never lower).

**Tag: MVP.** Rule set expands per phase (local shell rules land Phase 5).

### 5.8 Permission Manager

Owns scopes and the approval gate.

```typescript
interface ScopeGrant {
  kind: 'folder' | 'domain' | 'connector' | 'spend' | 'tool';
  ref: string;                           // folder path | domain | connector id | tool name
  mode?: 'ro' | 'rw';                    // folders
  limitUsd?: number;                     // spend
  scope: 'once' | 'task' | 'session' | 'workspace';
  expiresAt?: string;
  grantedBy: string; grantedAt: string;
}
interface ApprovalRequest {
  approvalId: string; sessionId: string;
  action: string; risk: RiskLevel; detail: string; reasons: string[];
  proposedGrant?: ScopeGrant;            // what approving would grant
}
interface ApprovalGrant { approvalId: string; decision: 'approve'|'deny'; grant?: ScopeGrant; decidedAt: string; }
```

- On a gated ToolCall the manager emits `approval_request` (matches the pinned `ServerToClientEvents.approval_request`) and parks the loop in `waiting_for_approval`. Client `approve`/`deny` (the pinned `ClientToServerEvents`) resolves it; `approve` may carry a `ScopeGrant` (e.g. "allow this folder for the whole task") so repeat actions don't re-prompt.
- Grants are **least-privilege, scoped, revocable, expiring**, and audited. A `policyBlock` cannot be satisfied by any grant.
- Local-first folder grants translate directly into the sidecar's `device_config` folder scope (`ro`/`rw`).

**Tag: MVP** (per-action approval + `once`/`task` grants). `workspace`-scope grants + permission profiles → LATER.

### 5.9 Context Manager

Builds every LLM request to be **correct, minimal, and cache-friendly** — the core cost-control lever.

Layered prompt (stable → volatile, to maximize prompt-cache hits):

```
[1] System + safety policy + output contract     ── stable, cached
[2] Tool JSON Schemas (from tool-abi)             ── stable per registry version, cached
[3] Retrieved memory (workspace/project/prefs)    ── semi-stable, cache-windowed
[4] Task intent + plan + acceptance criteria      ── per task
[5] Rolling working set: recent steps/observations── volatile, summarized when large
[6] Current instruction / tool_result to react to ── volatile
```

Strategies:
- **Prompt caching:** layers 1–2 (and often 3) marked as cache breakpoints via `LlmProvider.cache`, so repeated turns pay cache-read, not full input, price.
- **Summarization / compaction:** when the rolling working set exceeds a token budget, older observations are summarized (cheap model call or extractive) into a compact "progress so far" block; full detail stays in Postgres + retrievable on demand.
- **File chunking:** large files are chunked; only retrieval-selected chunks enter the prompt (never whole files blindly).
- **Minimal-data-to-LLM:** redaction + sensitivity rules strip secrets/PII; only model-necessary content is sent — directly serving "avoid sending unnecessary private data."
- **Token budgeting:** the manager enforces a per-request input ceiling and degrades gracefully (drop oldest detail → summary) before ever truncating mid-structure.

```typescript
interface PromptPlan {
  blocks: { id: string; role: 'system'|'user'|'assistant'; cache?: boolean; tokens: number; content: ContentPart[] }[];
  estInputTokens: number;
  droppedForBudget: string[];            // what was summarized/omitted (audited)
}
```

**Tag: MVP** (chunking + summarization + prompt caching + redaction). Adaptive memory-window tuning → LATER.

### 5.10 Memory Manager

See §9 for the full model. Interface contract used by the loop:

```typescript
interface MemoryManager {
  retrieve(q: MemoryQuery): Promise<MemoryHit[]>;     // pgvector KNN, tenant-scoped
  write(items: MemoryWrite[]): Promise<void>;         // post-task write-back
  forget(ref: MemoryRef): Promise<void>;              // user privacy control
}
```

**Tag: MVP** (workspace/project/file/preference retrieval, minimal). Knowledge/Playbooks depth → Phase 7 (LATER).

### 5.11 Artifact Manager

Registers deliverables and intermediate outputs as **content-addressed, versioned, audit-linked** artifacts via `packages/blob-store` (`BlobStore`: S3/R2/MinIO cloud; local FS via sidecar in local-first).

```typescript
interface ArtifactRef {
  id: string; taskId: string;
  name: string; mime: string; bytes: number;
  sha256: string;                        // content address (dedupe + integrity)
  version: number;
  location: 'blob' | 'local_fs';
  uri: string;                           // presigned (cloud) or local path (sidecar)
  producedByToolCall?: string;
  createdAt: string;
}
```

- Cloud artifacts use presigned up/download (large blobs stay off the API process). Local-first artifacts live on the user's disk and are referenced, not uploaded, unless the user opts in.
- Every artifact links to the producing ToolCall → full provenance for the audit log and replay.

**Tag: MVP** (register/version/presign reports + files + spreadsheets-lite). Library browse UI → LATER (§stack C12).

### 5.12 Cost Estimator & Token Accounting

```typescript
interface TaskBudget {
  maxUsd: number; maxTokens: number; maxSteps: number;
  maxToolCalls: number; maxWallClockMs: number; maxReplans: number;
}
interface CostEstimate { estUsd: number; estTokens: number; basis: string; overThreshold: boolean; }
interface CostUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  usd: number; byStep: Record<string, number>;
}
```

- **Pre-flight estimate (COST_GATE):** estimates expected tokens from plan size × historical per-step token averages (per tool) + model price; emits `cost_estimate` (the pinned event). Over the workspace threshold → pause for approval before spending.
- **Live metering:** every `LlmProvider` call returns token counts (input/output/cache-read/cache-write); the engine meters into Postgres per **task / workspace / user / month** (the brief's four axes). Cache-read vs full-input priced separately (caching savings are visible).
- **Budget enforcement:** any ceiling hit → RECOVER→give-up with explanation; hard workspace/month caps can hard-cancel a task.

> Authoritative model id (`claude-opus-4-8`) and price/caching parameters come from the dedicated LLM/provider planning doc and `packages/llm`; this doc commits the *accounting architecture* (four-axis metering, pre-flight estimate, cache-aware pricing).

**Tag: MVP** (metering + pre-flight estimate + per-task/workspace caps). Per-user/month dashboards + billing → LATER.

### 5.13 Checkpointing & Resume

The engine is crash- and restart-safe because Postgres is the system of record and a **checkpoint is written before every side-effecting EXECUTE and every PAUSE**.

```typescript
interface CheckpointRef {
  taskId: string; epoch: number;
  loopState: string;                     // §3.1 state name
  planVersion: number;
  cursor: { stepId: string; toolCallId?: string };
  completedToolCalls: string[];          // idempotency: never re-run these
  workingSetDigest: string;              // pointer to compacted context in DB
  costUsage: CostUsage;
  createdAt: string;
}
```

**Resume semantics:**
1. On worker pickup of a task already past `created`, the runtime loads the latest `CheckpointRef`, **bumps `epoch`** (invalidates any stale in-flight op / sidecar timer — epoch-guarded op queue), and rebuilds `AgentContext`.
2. The loop re-enters at `loopState`/`cursor`. ToolCalls in `completedToolCalls` are **never re-executed**; their persisted results are reused (idempotency).
3. A ToolCall that was `running` at crash with no recorded result is treated as **unknown-outcome**: if its tool declares idempotency, retry; otherwise route to RECOVER→`ask` (user confirms whether the side effect happened) — never blindly re-run a non-idempotent side effect.
4. `paused`/`waiting_for_approval` tasks resume on the user's decision arriving via the control channel.

**Stop/pause/resume across the queue:** see §8.3.

**Tag: MVP** (checkpoint between steps + resume-from-checkpoint). Cross-worker live migration → LATER.

---

## 6. What a task must persist

Every field the brief enumerates, mapped to tables (Postgres, via `packages/db`/Prisma). Append-only logs are partitioned by `sessionId`/time for cheap replay + retention.

| Concern | Table(s) | Key fields |
|---|---|---|
| **Prompt / intent** | `Task` | `prompt`, `intent` (JSONB `TaskIntent`), `mode`, `sensitivity` |
| **Plan** | `Plan` | `taskId`, `version`, `rationale`, `acceptanceCriteria[]`, `estimatedToolCalls` |
| **Steps** | `Step` | `planId`, `index`, `title`, `description`, `status`, `dependsOn[]`, `attempts`, `maxAttempts` |
| **Tool calls** | `ToolCall` | `stepId`, `tool`, `args` (JSONB), `staticRisk`, `effectiveRisk`, `status`, `approvalId?`, `result` (JSONB, redacted), `durationMs`, `retryOf?` |
| **Browser sessions** | `SandboxSession`, `BrowserContext` | `sessionId`, `sandboxId`, `wsUrl`, `traceArtifactId`, `contextId`, cookies/storage handle (in sandbox, not DB) |
| **Files / artifacts** | `Artifact` | `taskId`, `name`, `mime`, `bytes`, `sha256`, `version`, `location`, `uri`, `producedByToolCall` |
| **Logs (replayable stream)** | `EventLog` (append-only, partitioned) | `sessionId`, `seq`, `type`, `payload` (JSONB), `ts` |
| **Audit (risk/approval)** | `AuditLog` (append-only) | `sessionId`, `actor`, `action`, `risk`, `approvalId?`, `decision?`, `target`, `ts`, `prevHash`/`hash` (tamper-evident) |
| **Token usage** | `UsageMeter` | `taskId`, `workspaceId`, `userId`, `month`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `usd` |
| **Cost estimate** | `Task.costEstimate` (JSONB) + `UsageMeter` | pre-flight `CostEstimate`; actuals roll up to `UsageMeter` |
| **Errors** | `Task.error`, `ToolCall.result.error`, `StepError` | `code`, `message`, `class`, `retryable`, `stepId`, `ts` |
| **Retry count** | `Task.retryCount`, `Step.attempts` | task-level replans + per-step attempts |
| **Approvals / grants** | `Approval`, `ScopeGrant` | request + decision + granted scope (folder/domain/spend/connector) |
| **Checkpoint** | `Checkpoint` | latest `CheckpointRef` per task (`epoch`, `loopState`, `cursor`, `completedToolCalls[]`, `costUsage`) |
| **Final output** | `Task.finalOutput` (JSONB) | `summary`, `artifacts[]`, `caveats[]`, `verification` |
| **Memory write-back** | `Memory`, `MemoryEmbedding` (pgvector) | scoped facts/summaries + embeddings (§9) |

```typescript
interface FinalOutput {
  summary: string;
  artifacts: ArtifactRef[];
  verification: VerificationResult;
  caveats: string[];                     // unmet criteria when delivered with shortfalls
  costUsd: number;
}
interface TaskError { code: string; message: string; class: string; recoverable: boolean; ts: string; }
```

**Replay guarantee:** the `EventLog` is a totally-ordered (`seq`) stream per session; re-rendering it reproduces the UI deterministically (stack doc Scenario B1). The `AuditLog` is hash-chained for tamper-evidence.

---

## 7. Tool Registry & tool ABI

### 7.1 Tool definition interface

Extends the pinned `ToolDef<I,O>` (§7.6 stack doc) with the fields the brief requires (timeout, retry policy, logging behavior, approval requirement, tests, capability tag):

```typescript
// packages/tool-abi/src/tool.ts
interface ToolDef<I = unknown, O = unknown> {
  name: string;                          // unique, snake_case (model-facing)
  capability: string;                    // e.g. 'web.search' — routing & substitution
  description: string;                   // model-facing; drives selection
  input: ZodSchema<I>;                   // → JSON Schema for Claude tool-use + runtime validation
  output: ZodSchema<O>;
  risk: RiskLevel;                       // static baseline (classifier may escalate)
  surface: 'cloud' | 'local' | 'either';
  permissionScope?: { kind: ScopeGrant['kind']; mode?: 'ro'|'rw' };  // what executing needs
  approval: 'never' | 'if_high' | 'always';     // baseline approval policy
  timeoutMs: number;
  retry: { max: number; backoff: 'fixed'|'exponential'; baseMs: number; retryOn: string[] };
  logging: { logArgs: boolean; logOutput: boolean; redactPaths: string[] };  // masking policy
  costHint?: { perCallUsd?: number; perCallTokens?: number };   // feeds pre-flight estimate
  idempotency?: { key: (input: I) => string };  // safe-resume for side effects
  execute(input: I, ctx: ToolContext): Promise<O>;
  // tests: each tool ships a co-located <name>.test.ts (hard rule: no tool "done" w/o passing tests)
}
```

**Logging behavior** is declared per tool: `redactPaths` (JSON paths in args/output to mask), `logArgs`/`logOutput` toggles. The `RedactingLogger` enforces these at the sink — sensitive values never hit logs, prompts, or replays unredacted.

**Approval requirement** resolves as: `effectiveRisk ∈ {high,critical}` **OR** `approval === 'always'` **OR** required `permissionScope` not yet granted → gate. `approval: 'never'` cannot suppress a gate forced by a `policyBlock`.

### 7.2 Registration & discovery

- **Static registration (MVP):** built-in tools are registered at worker boot into a `ToolRegistry` keyed by `name`, indexed by `capability` and `surface`. The registry computes a **registry version hash** (over names + input/output schemas + risk) — when it changes, the cached tool-schema prompt block (layer 2, §5.9) is invalidated and the `zod→json-schema` codegen re-runs (stack Scenario A3 parity).
- **Dynamic discovery (LATER):** MCP servers (Phase 10) and connector tools register at runtime through the same `ToolRegistry.register(def)` contract, each behind per-server permission scopes and sandboxed execution. The registry contract is MVP; dynamic sources are LATER.

```typescript
interface ToolRegistry {
  register(def: ToolDef): void;
  get(name: string): ToolDef | undefined;
  byCapability(cap: string, surface: 'cloud'|'local'): ToolDef[];
  jsonSchemas(surface: 'cloud'|'local'): AnthropicToolSchema[];   // for the LLM
  version(): string;                     // hash; cache-key for the schema prompt block
}
```

### 7.3 Router selection algorithm

1. **Model-driven:** resolve `tool_use.name` → `get(name)`. If missing → structured error `tool_result` (model retries). Validate `tool_use.input` against `input` (Zod). Invalid → structured validation error back to the model (bounded retries).
2. **Surface filter:** keep only tools where `surface ∩ task.mode` is satisfiable; a `local`-only tool on web → "requires desktop" error.
3. **Capability fallback (recovery):** `byCapability(cap, surface)` minus the failed tool, ranked by `(lowest risk, highest rolling success rate, lowest costHint)`; pick the top.
4. **Gate:** hand the chosen `ToolDef` + classified risk to PermissionManager.

### 7.4 Claude tool-use ↔ registry mapping

- `ToolRegistry.jsonSchemas(surface)` emits Anthropic `tools` (name, description, `input_schema` from `zod-to-json-schema`) passed to `LlmProvider.tools`. **One source** (the Zod `input`) feeds both the schema the model sees and runtime validation — no drift (stack Scenario A3).
- Model response `content` is parsed: `text` → `message` events; each `tool_use` block → a `ToolCall` (`callId = tool_use.id`), routed/classified/gated/executed.
- Each `ToolResult` is returned to the model as a `tool_result` content block (with `tool_use_id = callId`), redacted per the tool's logging policy before it enters the prompt.
- Parallel `tool_use` blocks in one model turn map to multiple ToolCalls; independent ones (no shared scope) may execute concurrently within the executor's per-task concurrency cap; gated ones serialize behind their approvals.

### 7.5 Initial ~30 tools & risk levels

Grouped by capability. Risk = **static baseline**; the classifier may escalate dynamically. **Surface**: C=cloud, L=local, E=either. **Phase**: MVP unless tagged.

| # | Tool (`name`) | Capability | Risk | Surface | Approval | Phase |
|---|---|---|---|---|---|---|
| 1 | `web_search` | web.search | low | C | never | MVP |
| 2 | `web_fetch` | web.fetch | low | C | never | MVP |
| 3 | `browser_navigate` | browser.navigate | low | C | never | MVP |
| 4 | `browser_read_page` | browser.read | low | C | never | MVP |
| 5 | `browser_click` | browser.interact | medium | C | if_high | MVP |
| 6 | `browser_fill_form` | browser.interact | medium | C | if_high | MVP |
| 7 | `browser_screenshot` | browser.capture | low | C | never | MVP |
| 8 | `browser_download` | browser.download | medium | C | if_high | MVP |
| 9 | `file_read` | fs.read | low | E | never | MVP |
| 10 | `file_write` | fs.write | high | E | always | MVP* |
| 11 | `file_list` | fs.list | low | E | never | MVP |
| 12 | `file_delete` | fs.delete | high | E | always | MVP* |
| 13 | `file_move` | fs.move | high | E | always | MVP* |
| 14 | `local_file_read` | fs.read.local | medium | L | if_high | MVP (RO) |
| 15 | `local_file_write` | fs.write.local | high | L | always | LATER (P5) |
| 16 | `shell_exec` | shell.exec | critical | C | always | MVP (sandbox) |
| 17 | `local_shell_exec` | shell.exec.local | critical | L | always | LATER (P5) |
| 18 | `code_exec` | code.run | high | C | if_high | MVP |
| 19 | `python_repl` | code.python | high | C | if_high | MVP |
| 20 | `artifact_create` | artifact.write | medium | E | if_high | MVP |
| 21 | `artifact_read` | artifact.read | low | E | never | MVP |
| 22 | `report_generate` | gen.report | low | C | never | MVP |
| 23 | `spreadsheet_write` | gen.sheet | medium | C | if_high | MVP |
| 24 | `memory_search` | memory.read | low | C | never | MVP |
| 25 | `memory_write` | memory.write | low | C | never | MVP |
| 26 | `http_request` | net.http | medium | C | if_high | MVP |
| 27 | `send_email` | comms.email | high | C | always | LATER (P8) |
| 28 | `connector_call` | connector.* | high | C | always | LATER (P7/10) |
| 29 | `schedule_task` | automation.cron | medium | C | always | LATER (P6) |
| 30 | `subagent_spawn` | research.fanout | medium | C | if_high | LATER (P10) |
| 31 | `ask_user` | interaction.ask | low | E | never | MVP |
| 32 | `deploy_site` | publish.deploy | high | C | always | LATER (P9/10) |

\* `file_write`/`file_delete`/`file_move` are **MVP inside the sandbox** (cloud surface). Their **local** (`L`) variants — writing the user's real disk — are LATER (Phase 5); MVP local is **read-only** (`local_file_read`). This matches the scope doc's "MVP local = read-only files."

**Hard-rule note (reflected in tool design):** there is deliberately **no** `solve_captcha` / `bypass_2fa` tool, and `browser_*` tools surface CAPTCHA/2FA detection as a `policyBlock` → user takeover. No bulk-comms tool ships without anti-spam thresholds in the classifier.

---

## 8. Queue / Worker topology

### 8.1 Queues & jobs (BullMQ on Redis 7, `packages/queue`)

| Queue | Job | Producer | Consumer (`services/worker`) | Notes |
|---|---|---|---|---|
| `agent-run` | `RunTaskJob` | `services/api` on `createTask` | AgentRuntime | one job = one task lifecycle; resumable via checkpoint |
| `agent-step` (optional) | `RunStepJob` | AgentRuntime | step workers | only used when a plan opts into step-level parallelism |
| `research` (LATER) | `CoordinatorJob` → `SubAgentJob` (flow) | AgentRuntime | sub-agent workers | BullMQ **flow** parent/child fan-out (§10) |
| `artifacts` | `GenerateArtifactJob` | AgentRuntime | artifact workers | report/spreadsheet generation off the hot loop |
| `maintenance` | `ReapSandboxJob`, `ExpireGrantJob` | scheduler (repeatable) | maintenance workers | idle-reap sandboxes, expire scope grants |
| `scheduled` (LATER) | repeatable `TriggerJob` | BullMQ repeatable | enqueues `agent-run` | cron Automations (Phase 6) |

```typescript
// packages/queue — typed job payloads
interface RunTaskJob   { taskId: string; sessionId: string; workspaceId: string; epoch: number; }
interface RunStepJob   { taskId: string; stepId: string; epoch: number; }
interface SubAgentJob  { taskId: string; subTaskId: string; subPrompt: string; budget: TaskBudget; }
```

### 8.2 Worker topology & concurrency

- **Worker process (`services/worker`)** runs N BullMQ `Worker`s, one per queue, each with a configured `concurrency`. The **engine runtime is hosted in-process**; long agent runs are I/O-bound (LLM + tool WS), so concurrency is high per worker.
- **Concurrency controls:**
  - Per-queue `concurrency` (e.g. `agent-run`: tuned to sandbox-pool capacity).
  - **Per-workspace fairness** via BullMQ group keys / rate limiting (one workspace can't starve others).
  - **Per-task tool concurrency cap** inside the executor (parallel `tool_use` blocks) bounded so a single task can't exhaust the sandbox pool.
- **Mapping task → jobs:** a task is **one `RunTaskJob`** by default (the runtime drives the whole loop, checkpointing between steps). Step-level parallelism (independent `dependsOn`-free steps) optionally fans into `RunStepJob`s under the parent; results aggregate back. Wide Research fans into a `research` **flow** (§10). Subtasks/steps becoming jobs is therefore **opt-in**, decided by the planner's dependency graph — the default keeps one durable job per task for simple, resumable runs.

### 8.3 Stop / pause / resume across the queue

- **Stop (kill switch):** a client `stop` (`/chat`) → API/gateway sets a **cancel flag** in Redis keyed by `sessionId` and publishes on the engine **control channel**. The runtime's `AbortSignal` (subscribed to that channel) trips → in-flight tool/sandbox/sidecar op aborts (epoch-guarded), the BullMQ job is marked done with `cancelled`, task status → `cancelled`. Acceptance: ≤2s (§11). A queued-but-unstarted job checks the cancel flag on pickup and exits immediately.
- **Pause (soft):** sets a `paused` flag; the runtime checkpoints and the job **completes cleanly** (BullMQ jobs aren't meant to sleep indefinitely). Status → `paused`.
- **Resume:** API enqueues a fresh `RunTaskJob` with `epoch+1`; the runtime loads the checkpoint and continues from `cursor` (§5.13). Approval-driven resume (`waiting_for_approval`) works the same way: the decision arriving re-enqueues with the grant applied.
- **Crash/restart:** BullMQ's stalled-job detection re-delivers the job; the runtime resumes from the last checkpoint with a bumped epoch (no double side effects).

> **Why complete-and-re-enqueue rather than block:** BullMQ workers shouldn't hold a job open while parked on a human decision (ties up concurrency, risks stall timeouts). Pausing/awaiting-approval **persists state + frees the slot**; resuming is a new job off the durable checkpoint. Postgres is the source of truth, Redis only coordinates — a Redis loss degrades to "reschedule from Postgres," not data loss (stack §6.10).

**Tag: MVP** (`agent-run`, `artifacts`, `maintenance`, stop/pause/resume, checkpoint resume). `research`/`scheduled`/`agent-step` parallel fan-out → LATER.

---

## 9. Memory & Context

### 9.1 Memory scopes

| Scope | Lifetime | Examples | Reaches model? |
|---|---|---|---|
| **User preference** | persistent | tone, default deliverable format, units, timezone | yes, if relevant + permitted |
| **Workspace** | persistent | org facts, glossary, standard sources | yes, tenant-scoped |
| **Project** | persistent | project brief, prior decisions, linked files | yes, project-scoped |
| **Task (working)** | task lifetime | plan, observations, intermediate results | yes (summarized when large) |
| **File** | persistent | chunk embeddings of uploaded/produced files | retrieval-selected chunks only |

All memory rows carry `workspaceId` (+ `userId`/`projectId` as applicable); retrieval **always** filters by tenancy in the same `WHERE` as the pgvector KNN — no cross-tenant leakage (stack §6.9).

### 9.2 Storage & retrieval (pgvector, HNSW)

```typescript
interface MemoryQuery {
  workspaceId: string; userId?: string; projectId?: string;
  text: string;                          // query → embedding
  scopes: ('preference'|'workspace'|'project'|'task'|'file')[];
  k: number; minScore: number;
  excludeSensitive?: boolean;            // privacy gate (§9.4)
}
interface MemoryHit {
  ref: MemoryRef; scope: string; score: number;
  content: string; source: { kind: string; id: string }; // source-based attribution
  stale?: boolean;                       // §9.3
}
interface MemoryWrite {
  scope: 'preference'|'workspace'|'project'|'task'|'file';
  content: string; source: { kind: string; id: string };
  embedding?: number[];                  // computed if absent
  ttlDays?: number;                      // staleness
}
```

- **Chunking:** files split into overlapping chunks (token-bounded); each chunk embedded and stored with `source` (file id + offset). Only top-k chunks enter the prompt.
- **Summarization:** long task histories compacted to summary memories; full detail stays queryable in Postgres.
- **Source-based retrieval:** every `MemoryHit` carries its `source` so the engine can cite provenance and the user can trace/forget by source.

### 9.3 Staleness handling

- Each memory has `createdAt`, optional `ttlDays`, and a `supersededBy` link. Retrieval flags `stale` when past TTL or superseded; stale hits are de-prioritized and excluded from authoritative claims unless re-verified.
- Project/workspace facts that change (e.g. a decision reversed) write a new memory and set `supersededBy` on the old — replay and audit keep both, but retrieval prefers the current one.

### 9.4 Cost-control context strategy (the lever)

Restating §5.9 as the memory/cost contract:
1. **Prompt caching** of the stable system + tool-schema (+ semi-stable memory) blocks → repeated turns pay cache-read price.
2. **Summarization/compaction** of the rolling working set when it exceeds budget.
3. **File chunking + retrieval** so whole files never blindly enter the prompt.
4. **Minimal private data:** redaction + `excludeSensitive` + sensitivity rules strip secrets/PII; only model-necessary content is sent.
5. **Token budgeting** with graceful degradation (drop oldest detail → summary) before any structural truncation.
6. **Four-axis metering** (task/workspace/user/month) with cache-read vs full-input priced separately so savings are visible.

**Tag: MVP** (retrieval + chunking + summarization + caching + redaction + four-axis metering). Knowledge base / Playbooks / RAG depth → Phase 7 (LATER).

---

## 10. Wide / Parallel Research

A coordinator/sub-agent (map-reduce) pattern for tasks that benefit from breadth. **Entirely LATER (Phase 10)** per the scope doc, but the contract is designed now so the MVP engine, queue, and tool ABI don't need rework to add it.

### 10.1 Decomposition → fan-out → reduce

```
Coordinator (parent task)
  ├─ split(): planner emits N independent SubTasks (disjoint sub-questions, isolated criteria)
  ├─ fan-out: BullMQ flow → N SubAgentJob children, each its own AgentRuntime instance
  │     • isolated AgentContext, isolated working memory, isolated event sub-stream + logs
  │     • per-sub TaskBudget (sub-budgets sum ≤ parent budget) — hard caps prevent blow-ups
  │     • per-sub retry/recovery (a failed sub doesn't fail the whole job)
  ├─ join: BullMQ flow parent waits for children; partial success tolerated (quorum policy)
  ├─ reduce(): coordinator LLM merges sub-results → deduped, conflict-resolved synthesis
  └─ verify(): final verification against the parent's acceptance criteria; replan/refetch gaps
```

```typescript
interface SubTask {
  id: string; parentTaskId: string;
  subPrompt: string; acceptanceCriteria: string[];
  budget: TaskBudget;                    // carved from parent
}
interface SubResult {
  subTaskId: string; ok: boolean;
  summary: string; artifacts: ArtifactRef[]; sources: { kind: string; id: string }[];
  cost: CostUsage; error?: TaskError;
}
interface ReduceInput { parentTaskId: string; results: SubResult[]; quorum: number; }
```

### 10.2 Isolation, concurrency, aggregation guarantees

- **Isolation:** each sub-agent has its own context, memory window, sandbox (if needed), event sub-stream (`subTaskId`-tagged), and log partition — no cross-talk; one sub's failure/cancel is contained.
- **Concurrency:** bounded by the `research` queue concurrency + sandbox-pool capacity + per-workspace fairness; sub-budgets cap total spend; the coordinator can cap "N in flight."
- **Retry:** per-sub recovery; the coordinator may re-fan a failed sub once (capped) before degrading to quorum.
- **Aggregation:** reduce step deduplicates overlapping findings, resolves conflicts (prefer higher-confidence/fresher sources, cite provenance), and produces one verified deliverable; **final verification** runs once on the merged result.
- **Stop:** a parent `stop` cancels all children (epoch-guarded) and aborts in-flight sandbox ops.

**Tag: LATER (Phase 10).** Contract (`SubTask`/`SubResult`/`ReduceInput`, BullMQ flow, `subagent_spawn` tool) is forward-declared MVP-compatible.

---

## 11. Test scenarios & acceptance criteria

> Hard rule: **no module is "done" without passing tests.** Each scenario is automatable (Vitest unit/integration; Testcontainers for Postgres+Redis+MinIO; contract tests on `tool-abi`/`protocol`). Acceptance criteria are objective.

### A. Task Understanding
- **A1 — intent extraction.** Given a multi-constraint prompt, `TaskIntent` captures goal, deliverable kind, all constraints, and acceptance criteria. **Accept:** all constraints present; schema-valid; deterministic on a fixture (temperature-pinned/mocked LLM).
- **A2 — ambiguity gate.** A vague prompt (`ambiguityScore` > threshold) yields a single clarifying question, not a guessed plan. **Accept:** no `plan` event before clarification; exactly one clarifying `message`/`approval_request`.

### B. Planner & Steps
- **B1 — inspectable plan.** A task emits a `plan` (ordered steps + acceptance criteria) **before** any `tool_call`. **Accept:** `plan` precedes first `tool_call`; plan is Zod-valid; persisted as `Plan v1`.
- **B2 — replan on failure.** Force a step to fail unrecoverably-in-place. **Accept:** `Plan.version` increments; superseded steps marked `skipped` (not deleted); replan capped at `maxReplans`.

### C. Tool Router & ABI
- **C1 — schema parity.** Edit a Zod tool `input`. **Accept:** regenerated JSON Schema equals runtime-validated shape (parity test); registry `version()` changes; schema prompt-block cache invalidates.
- **C2 — invalid args self-correct.** Model emits args failing Zod. **Accept:** structured validation `tool_result` returned; model retries within bounded attempts; no execution on invalid args.
- **C3 — surface gating.** A `local`-only tool requested on a web (cloud) session. **Accept:** "requires desktop" error `tool_result`; no execution; clear user-facing message.

### D. Executor & Surfaces
- **D1 — cloud chain.** A task runs ≥3 chained tool calls in a container-per-session sandbox and returns a verified result. **Accept:** 3 `tool_call`/`tool_result` pairs correlate by `callId`; final verified.
- **D2 — local read-only.** Local-first task reads an RO folder; a write is denied. **Accept:** read succeeds; write → `policyBlock`/scope-miss → denied + audited; bytes never uploaded (local-first).
- **D3 — per-tool timeout.** A tool exceeds `timeoutMs`. **Accept:** call aborts; `ToolResult.error.retryable`; recovery engaged.

### E. Verifier
- **E1 — final verify pass/fail.** Deliverable missing a required criterion. **Accept:** `VerificationResult.passed=false` with the shortfall listed; triggers replan (budget left) or delivers with `caveats` (no budget) — never a silent "completed."

### F. Error Recovery
- **F1 — retry transient.** Inject a transient (retryable) tool error. **Accept:** retried with backoff up to `maxAttempts`; succeeds; counters updated.
- **F2 — reroute.** First tool of a capability fails non-transiently; an alternative exists. **Accept:** router selects the alternative; capability satisfied.
- **F3 — graceful give-up.** Exhaust budget. **Accept:** task → `failed` with a plain-language explanation; no infinite loop.

### G. Safety / Risk Classifier
- **G1 — dynamic escalation.** A `medium`-static write targets a path outside any granted scope. **Accept:** `effectiveRisk ≥ high`; gated.
- **G2 — destructive critical.** `shell_exec` with `rm -rf` pattern. **Accept:** `effectiveRisk = critical`; gated; blocked until approved; denied → step aborts cleanly.
- **G3 — policy block (non-approvable).** Browser hits a CAPTCHA. **Accept:** `policyBlock` raised; **cannot** be approved away; resolution is takeover or abort; never auto-solved (hard rule).

### H. Permission Manager
- **H1 — approval gate.** A `high` ToolCall. **Accept:** `approval_request` emitted; status `waiting_for_approval`; nothing executes until `approve`; `deny` aborts the step; both audited.
- **H2 — scoped grant suppresses re-prompt.** `approve` with a `task`-scope folder grant. **Accept:** subsequent same-scope writes don't re-prompt within the task; grant expires/cleared at task end.

### I. Context & Cost
- **I1 — cache hit.** Two consecutive turns with a stable system+tool prefix. **Accept:** second turn reports `cacheReadTokens > 0`; metered separately from full input.
- **I2 — pre-flight estimate.** A task over the workspace cost threshold. **Accept:** `cost_estimate{overThreshold:true}` emitted; run pauses before spending; approval resumes it.
- **I3 — four-axis metering.** Run a task. **Accept:** `UsageMeter` rows reconcile per task/workspace/user/month with provider usage in a fixture (within tolerance).
- **I4 — minimal private data.** Seed a secret in a file; run a task that doesn't need it. **Accept:** the secret never appears in any LLM request payload (asserted on captured requests).

### J. Memory
- **J1 — tenant isolation.** Two workspaces with similar embeddings. **Accept:** retrieval for W1 never returns W2 rows (KNN + tenancy filter).
- **J2 — staleness.** A superseded fact. **Accept:** retrieval flags `stale`/prefers the current memory; authoritative claims don't use stale hits.
- **J3 — forget.** User forgets a source. **Accept:** subsequent retrieval excludes it; embeddings removed.

### K. Checkpoint / Resume
- **K1 — resume after crash.** Kill the worker mid-run. **Accept:** BullMQ re-delivers; runtime resumes from checkpoint; `completedToolCalls` are **not** re-executed; epoch bumped.
- **K2 — non-idempotent safety.** Crash with a non-idempotent tool `running`, no result. **Accept:** runtime does **not** blindly re-run; routes to `ask`/idempotent-retry only.

### L. Lifecycle & Kill Switch
- **L1 — instant stop.** `stop` mid-tool. **Accept:** in-flight tool/sandbox/sidecar op aborts within ≤2s; task → `cancelled`; no further events; stop audited.
- **L2 — illegal transition guard.** Force an illegal `TaskStatus` transition. **Accept:** rejected by the transition table; unit test covers the full matrix (§4.2).
- **L3 — pause/resume.** Pause then resume. **Accept:** job frees its slot on pause (status `paused`), resumes from checkpoint on a new `epoch`, continues at `cursor`.

### M. Queue / Worker
- **M1 — durable job.** One task = one `RunTaskJob`; survives a worker restart (→ K1). **Accept:** exactly-once side effects across restart.
- **M2 — workspace fairness.** Flood W1 with tasks. **Accept:** W2's task still progresses (group-key rate limiting); no starvation.
- **M3 — parallel tool cap.** A turn with many parallel `tool_use` blocks. **Accept:** executor respects the per-task concurrency cap; sandbox pool not exhausted.

### N. Wide Research (LATER — contract tests now)
- **N1 — fan-out/reduce.** Coordinator splits into N subs, reduces to one verified result within per-sub budgets. **Accept:** N child jobs; isolated logs per `subTaskId`; merged result passes final verify; total cost ≤ parent budget.
- **N2 — partial failure.** One sub fails. **Accept:** quorum policy tolerates it; coordinator still delivers (or re-fans once); no whole-job failure.
- **N3 — stop cascades.** Parent `stop`. **Accept:** all children cancel; in-flight sandbox ops abort.

---

## 12. Feature inventory with MVP/LATER tags

Consistent with `docs/00-scope-and-phases.md` (F1) and Appendix A. "Definitely exists" ≠ "in MVP."

| Area | Feature | Tag | Phase |
|---|---|---|---|
| **Agent engine** | Task understanding (intent + acceptance criteria) | **MVP** | P2 |
| | Ambiguity clarification (one round) | **MVP-lite** | P2 |
| | Planner + step generator (inspectable plan) | **MVP** | P2 |
| | Replanning on failure | **MVP** | P2 |
| | Tool router (model-driven + capability fallback) | **MVP** | P2 |
| | Executor (cloud sandbox path) | **MVP** | P2 |
| | Executor (local read-only path) | **MVP** | P4 |
| | Executor (local read-write / shell) | LATER | P5 |
| | Step + final Verifier | **MVP** | P2 |
| | Error recovery (retry/reroute/replan/give-up) | **MVP** | P2 |
| | Safety/risk classifier (static ⊕ dynamic) | **MVP** | P2 |
| | Policy blocks (CAPTCHA/2FA/spam, non-approvable) | **MVP** | P2 |
| | Permission manager + approval gate | **MVP** | P2 |
| | Scoped/expiring grants (`once`/`task`) | **MVP** | P2 |
| | Workspace-scope grants + permission profiles | LATER | P7 |
| | Context manager (chunking/summary/caching/redaction) | **MVP** | P2 |
| | Cost estimator (pre-flight) + four-axis metering | **MVP** | P2 |
| | Budget enforcement (hard caps) | **MVP** | P2 |
| | Checkpointing + resume-from-checkpoint | **MVP** | P2 |
| | Artifact manager (versioned, content-addressed) | **MVP-lite** | P2 |
| **Tool registry** | Typed risk-tagged tool ABI (`ToolDef`) | **MVP** | P0/P2 |
| | Static registration + discovery + JSON-Schema parity | **MVP** | P2 |
| | Dynamic discovery (MCP/connectors) | LATER | P7/P10 |
| | Initial ~30 tools (cloud + RO-local subset) | **MVP** | P2/P4 |
| | Local write/shell, comms, connector, deploy, subagent tools | LATER | P5–P10 |
| **Queue/worker** | `agent-run` durable job + concurrency + fairness | **MVP** | P2 |
| | Stop / pause / resume across the queue | **MVP** | P2 |
| | `artifacts` + `maintenance` (reap/expire) queues | **MVP** | P2 |
| | `agent-step` parallel fan-out | LATER | — |
| | `scheduled` (cron Automations) | LATER | P6 |
| | `research` flow (Wide Research) | LATER | P10 |
| **Memory & context** | Workspace/project/task/file/preference memory | **MVP-lite** | P1/P2 |
| | pgvector KNN retrieval (tenant-scoped) | **MVP-lite** | P1 |
| | Chunking + summarization + source-based retrieval | **MVP** | P2 |
| | Staleness handling | **MVP-lite** | P2 |
| | Knowledge base / Playbooks / RAG depth | LATER | P7 |
| **Wide research** | Coordinator split → fan-out → reduce → verify | LATER | P10 |
| | Per-sub isolation/budget/retry/aggregation | LATER | P10 |

---

> **Conformance statement:** This document uses only the stack, model id (`claude-opus-4-8`), namespaces (`/chat`, `/device`), event/tool contracts, package layout, and MVP/Later phase split fixed in `docs/00-scope-and-phases.md` and `docs/01-stack-and-system-architecture.md`. The single additive decision — adopting the brief's nine-state `TaskStatus` enum (with `cancelled` ≡ the stack doc's illustrative `STOPPED`) — is explicitly reconciled in §0 and contradicts neither pinned doc.
