# AgentOS — Platform Collaboration Features (Sections 17–21)

> **Status:** Planning only. No code. TypeScript appears solely as interface *sketches* to pin contracts.
> **Scope of this doc:** §17 **Projects**, §18 **Skills**, §19 **Collaboration (real-time)**, §20 **Mail-to-Task**, §21 **Meeting Minutes**.
> **Conforms to:** `docs/00-scope-and-phases.md` (phase split, MVP cut, hard rules) and `docs/01-stack-and-system-architecture.md` (stack, topology, wire contracts, folder layout, rename strategy). Where this doc names a stack element it is the one already committed there — no contradictions, no new providers.
> **Brand handling:** every literal "AgentOS" / `agentos` below is `BRAND.appName` / `BRAND.protocol` from `packages/brand` (§34.6 of the stack doc). Renaming stays a one-file edit.
> **Phase anchoring (from §6/§7 of the scope doc):** Projects-lite = **MVP (Phase 1)**; Projects depth + Skills + Collaboration = **Phase 7 (`org`)**; Mail-to-Task + Meeting = **Phase 8 (`ingest`)**. Tags below use **MVP** vs **LATER** consistent with that map (the only MVP-tagged items here are the Projects-lite primitives that the Phase-1 schema must already carry; everything else is LATER).

---

## 0. Document map

| § | Area | Phase | Primary entity |
|---|---|---|---|
| 1 | Cross-cutting conventions (reused everywhere) | — | — |
| 17 | Projects (first-class) | 1 (lite) / 7 (depth) | `Project` |
| 18 | Skills | 7 | `Skill` |
| 19 | Collaboration (real-time) | 7 | `CollaborationSession` |
| 20 | Mail-to-Task | 8 | `MailTask` |
| 21 | Meeting Minutes | 8 | `MeetingRecord` |
| A | Consolidated MVP-vs-LATER tag table | — | — |

---

## 1. Cross-cutting conventions (so every section stays consistent)

These are reused verbatim by §17–§21; defined once here.

- **Entity placement.** Every entity is a Prisma model in `packages/db` (Postgres 16, system of record). Vector columns use `pgvector` (HNSW), reachable via the `MemoryStore` interface in `packages/memory`. Blobs (files, audio, attachments, exports) go to `BlobStore` (S3/R2/MinIO) in `packages/blob-store`, or the user's disk via the Rust sidecar in local-first mode.
- **Tenancy.** Every row carries `workspaceId`; Postgres RLS is the backstop, app-layer scoping is primary. No cross-workspace read is ever possible (asserted by authz tests, per scope-doc Phase-1 acceptance).
- **Risk + approval.** Every action that mutates the user's world or spends money carries a `RiskLevel = 'low' | 'medium' | 'high' | 'critical'`. `high`/`critical` emit an `approval_request` over `/chat` and **pause** until `approve`/`deny`. This is the *same* risk-gate interceptor the engine already uses — these features add new *triggers*, not a new mechanism.
- **Audit.** Every important action writes an append-only `AuditEvent` row (actor, action, risk, target, decision, `redacted` payload). This is a product feature, not just ops telemetry (per stack §6.23).
- **Masking.** Sensitive values are redacted at the logger boundary and in any shared/replay/email surface, via `packages/logger`. Skills/mail/meeting all route through it.
- **Realtime.** New live events ride the existing Socket.IO `/chat` namespace (Redis adapter, typed contracts in `packages/protocol`). No new transport. Collaboration adds presence/queue events; meetings add transcript-chunk events.
- **Cost attribution.** Token/cost metering already keys on `(taskId, workspaceId, userId, month)`. Collaboration and mail introduce an **actor vs payer split**: the *actor* who prompted is recorded for audit, but cost is always metered to the **task owner + owning workspace** (see §19.6, §20.7).
- **Validation.** Every payload (HTTP, WS, file-on-disk like `SKILL.md` front-matter, inbound email, IPC) is Zod-validated. Schemas live beside their owning package and infer the TS types.

---

# §17 — Projects (first-class)

> **Phase:** Projects-**lite** lands in **MVP / Phase 1** (the `Project` table + grouping + per-project budget cap already exist so tasks can be scoped). Full depth (knowledge base, memory, integrations, automations, templates, clone, export/import, roles, settings) is **LATER / Phase 7 (`org`)**. Each sub-feature is tagged inline.

A **Project** is a persistent container that groups Tasks and supplies *inherited context* to every Task created inside it. It is the unit of organization, budget, permission, and reusable knowledge.

## 17.1 What a Project owns

| Sub-feature | Tag | Notes |
|---|---|---|
| Grouping of Tasks/Sessions | **MVP** | `Task.projectId` FK; project task history view |
| Per-project budget cap + token/cost rollup | **MVP** | reuses metering; cap enforced pre-flight |
| Persistent **custom instructions** (system-prompt prefix) | **MVP-lite** | one text field in P1; structured in P7 |
| Permission profile (which tool risk-tiers allowed) | **MVP-lite** | default profile in P1; editable in P7 |
| File **knowledge base** (RAG corpus) | **LATER** | `ProjectFile` + embeddings in `pgvector` |
| Project **memory** (durable facts, learned preferences) | **LATER** | `MemoryItem` scoped to project |
| **Integrations** (connector bindings) | **LATER** | depends on Connectors (Phase 7+) |
| **Automations** (cron/event triggers) | **LATER** | depends on Automations (Phase 6) |
| Agent settings (model, temperature, context policy) | **LATER** | overrides workspace defaults |
| **Templates** (project blueprint) | **LATER** | seed instructions/files/skills/automations |
| **Clone** | **LATER** | deep copy minus secrets |
| **Export / Import** (portable bundle) | **LATER** | `.agentosproj` zip |
| **Roles** (owner/editor/viewer at project scope) | **LATER** | RBAC, ties to Collaboration §19 |

## 17.2 `Project` interface sketch

```typescript
// packages/db (Prisma-modeled) — illustrative TS shape
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type ProjectRole = 'owner' | 'editor' | 'viewer';

interface Project {
  id: string;
  workspaceId: string;                 // tenancy (MVP)
  name: string;
  slug: string;                        // stable handle for slash/mail addressing
  description?: string;
  createdBy: string;                   // userId
  archivedAt?: Date | null;

  // --- Inherited context (the heart of §17) ---
  instructions: ProjectInstructions;   // MVP-lite -> structured LATER
  agentSettings: ProjectAgentSettings;  // LATER (falls back to workspace defaults)
  permissionProfile: PermissionProfile; // MVP-lite

  // --- Knowledge & memory (LATER) ---
  knowledgeBaseId?: string;            // -> ProjectKnowledgeBase
  memoryNamespace: string;            // partition key in MemoryStore (pgvector)

  // --- Bindings (LATER) ---
  integrationIds: string[];           // connector bindings
  automationIds: string[];            // cron/event triggers
  defaultSkillIds: string[];          // skills auto-available in this project

  // --- Budget (MVP) ---
  budget: ProjectBudget;

  // --- Provenance (LATER) ---
  templateId?: string;                // if created from a template
  clonedFromProjectId?: string;
}

interface ProjectInstructions {
  // MVP-lite: just `system` is populated. LATER: the structured fields below.
  system: string;                      // always-on system-prompt prefix
  style?: string;                      // tone/format guidance
  constraints?: string[];              // "never email external domains", etc.
  glossary?: { term: string; definition: string }[];
  version: number;                     // bumped on edit; tasks pin the version they used
}

interface ProjectAgentSettings {       // LATER
  modelId?: string;                    // defaults to claude-opus-4-8 if unset
  temperature?: number;
  contextPolicy?: 'lean' | 'balanced' | 'full';
  maxStepsPerTask?: number;
  retrievalTopK?: number;              // how many KB chunks to inject
}

interface PermissionProfile {          // MVP-lite
  maxAutoRisk: RiskLevel;              // tools above this always need approval
  allowedSurfaces: ('cloud' | 'local')[];
  allowShell: boolean;
  allowedDomains?: string[];           // browser egress allowlist (LATER expands)
}

interface ProjectBudget {              // MVP
  monthlyUsdCap?: number;
  perTaskUsdCap?: number;
  hardStop: boolean;                   // true = block at cap; false = warn only
  spentThisMonthUsd: number;          // rolled up from usage metering
}

interface ProjectMember {              // LATER (RBAC)
  projectId: string;
  userId: string;
  role: ProjectRole;
  addedBy: string;
  addedAt: Date;
}
```

## 17.3 Context inheritance — the precise mechanism (CRITICAL)

> Requirement: *every new Task inside a Project auto-inherits project context.* Inheritance must be **deterministic, versioned, auditable, and privacy-respecting** — not "dump everything into the prompt."

**Where it runs.** Inheritance is resolved by a **`ProjectContextResolver`** in `packages/agent-engine`, invoked exactly once at **task intake** (step 1 of the end-to-end flow in stack §7.4), *before* the planner's first LLM call. It produces a frozen **`ResolvedContext`** that is pinned to the Task for its whole life (so a mid-run edit to project instructions never changes a running task — reproducibility).

**Resolution order (deterministic merge, later wins on conflict):**

1. **Workspace defaults** (model, context policy, global constraints).
2. **Project agent settings** (`ProjectAgentSettings`) override workspace.
3. **Project instructions** (`ProjectInstructions`, pinned by `version`) → injected as a labeled system-prompt block.
4. **Project permission profile** → loaded into the risk-gate as the per-task ceiling (`maxAutoRisk`, `allowedSurfaces`, `allowShell`, `allowedDomains`). This is enforcement, not prompt text.
5. **Default skills** (`defaultSkillIds`) → registered into the task's tool catalog via progressive disclosure (only names + one-line descriptions injected up front; bodies lazy-loaded — see §18.6).
6. **Integrations** (`integrationIds`) → connector tools registered (scoped tokens brokered server-side, never in prompt).
7. **Retrieved knowledge** (RAG) → at intake, the resolver runs a `MemoryStore` KNN query over the project `memoryNamespace` + knowledge base, filtered by `workspaceId`/`projectId`, top-K from `agentSettings.retrievalTopK`. Only the top-K **chunks** (not whole files) are injected, each with a citation handle so the agent can fetch more on demand. This directly serves the "avoid sending unnecessary private data to the model" rule — files are chunked and retrieved, not bulk-dumped.
8. **Project memory** (durable facts/preferences) → high-salience memory items injected as a compact "what we know" block; low-salience items remain retrievable.

**Output contract:**

```typescript
interface ResolvedContext {
  taskId: string;
  projectId: string;
  instructionsVersion: number;         // pinned
  systemBlocks: { label: string; text: string; source: string }[]; // auditable provenance per block
  toolCatalog: { name: string; risk: RiskLevel; source: 'skill'|'integration'|'core' }[];
  permissionCeiling: PermissionProfile;
  retrieved: { chunkId: string; score: number; citation: string }[];
  estTokensFromContext: number;        // feeds the pre-flight cost estimate
}
```

**Auditability.** Every `systemBlock` and retrieved chunk records its `source`, so the audit log can answer "why did the agent know X?" and "which instruction version was in force?" The `ResolvedContext` is persisted with the Task.

**Cost control.** `estTokensFromContext` is added to the pre-flight cost estimate (stack §7.4 step 5). If injected context alone blows the budget, the resolver summarizes lower-salience blocks (using the engine's existing summarization) before the first call. Prompt caching marks the stable project-instruction + skill-definition blocks as cache-friendly so repeated tasks in a project reuse cached prefixes.

**Privacy gate.** A per-project `privacyPolicy` flag list (e.g. `excludeFromModel: ['ssn', 'salary']`) is honored: matching memory/KB chunks are filtered *before* injection, and the exclusion is asserted by a test (mirrors scope-doc Phase-7 acceptance "excluded data never sent to model").

## 17.4 Templates, Clone, Export/Import (LATER)

- **Template** = a serialized blueprint: `instructions`, `agentSettings`, `permissionProfile`, `defaultSkillIds`, `automationIds` (as definitions, not bindings to live secrets), and optional seed KB files. Stored as `ProjectTemplate`. "New project from template" deep-copies these into a fresh `Project`.
- **Clone** = deep copy of an existing project **minus all secrets and connector tokens** (integrations are re-listed as "needs reconnect"). Task history is *not* copied by default (toggle to include as read-only archive). `clonedFromProjectId` records provenance.
- **Export** = `.agentosproj` zip: `project.json` (manifest, schema-versioned), `instructions/`, `knowledge/` (files), `skills/` (referenced local skills by id+version), `automations/` (definitions). **Secrets are stripped**; a `MANIFEST` lists what must be reconnected on import. **Import** validates the manifest schema version, re-scopes to the importing workspace, security-scans any bundled skill scripts (§18.7) before enabling them, and surfaces a reconnect checklist.

## 17.5 Folder / module placement

- `services/api`: `projects` Nest module (CRUD, members/roles, budget, template/clone/export/import endpoints).
- `packages/agent-engine`: `ProjectContextResolver` (inheritance).
- `packages/memory`: project `memoryNamespace` partitioning.
- `apps/web`: `/projects`, `/projects/[slug]` routes (overview, knowledge, memory, integrations, automations, history, settings, members) — already in the route map (stack §34.2).

## 17.6 Test scenarios & acceptance criteria — Projects

| ID | Scenario | Acceptance |
|---|---|---|
| P-1 (MVP) | Create project, create a task inside it | Task carries `projectId`; project history lists it; budget rollup increments after the run |
| P-2 (MVP) | Set project `instructions.system`; run a task | The system block appears in `ResolvedContext.systemBlocks` with `source='project.instructions@vN'`; the agent obeys it (asserted via a probe instruction like "always answer in JSON") |
| P-3 (MVP) | Edit instructions to v2 while a task from v1 is mid-run | Running task still shows `instructionsVersion=1`; only the *next* task uses v2 (reproducibility) |
| P-4 (MVP) | Set `budget.monthlyUsdCap` with `hardStop=true`, exceed it | New task is blocked pre-flight with a cost-cap message; audit records the block |
| P-5 (MVP) | `permissionProfile.maxAutoRisk='medium'`; agent attempts a `high` tool | Risk-gate emits `approval_request`; nothing runs until approved |
| P-6 (LATER) | Add 3 files to KB, ask a question answerable only from file 2 | Only top-K chunks from file 2 are injected (not all 3 files); answer cites the chunk; KB bytes beyond top-K never sent |
| P-7 (LATER) | Set `privacyPolicy.excludeFromModel=['salary']`; KB contains a salary line | The salary chunk is filtered before injection; a test asserts it is absent from the model prompt |
| P-8 (LATER) | Clone a project that has a connected integration | Clone has no secret/token; integration shows "needs reconnect"; task history not copied unless toggled |
| P-9 (LATER) | Export then import into a second workspace | Manifest schema validated; bundled skill scripts security-scanned before enable; reconnect checklist shown; no secrets present in the zip (asserted by scanning the artifact) |
| P-10 (LATER) | Assign user B role `viewer` | B can read project + history but cannot create tasks or edit instructions; unauthorized mutation denied + audited |

---

# §18 — Skills

> **Phase:** **LATER / Phase 7 (`org`)** — "Projects/Skills depth." A **Skill** is a filesystem-based, versioned package that bundles instructions, tool permissions, optional scripts, prompt templates, examples, and workflow definitions, invocable by slash-command. Skills are the AgentOS-original equivalent of "reusable parameterized task graphs" (scope-doc C14).

## 18.1 Skill package layout (on disk / in a zip)

A skill is a folder (or zip of that folder). Canonical layout:

```
my-skill/
├─ SKILL.md                 # REQUIRED. Front-matter (YAML) + human/agent-readable body (the instructions)
├─ skill.json               # REQUIRED. Machine manifest: id, version, category, declared tool permissions, inputs
├─ scripts/                 # OPTIONAL. Executable helpers (py/js/sh). Each is risk-classified + security-scanned.
│  └─ fetch_report.py
├─ prompts/                 # OPTIONAL. Prompt templates (parameterized with {{vars}})
│  └─ summarize.md
├─ examples/                # OPTIONAL. Example inputs/outputs used for few-shot + self-test
│  ├─ input-1.md
│  └─ output-1.md
├─ workflows/               # OPTIONAL. Declarative step graphs (parameterized task graphs)
│  └─ default.workflow.json
└─ assets/                  # OPTIONAL. Static files the skill ships (templates, logos, schemas)
```

**`SKILL.md` front-matter** (the part loaded for *progressive disclosure* — cheap to scan):

```yaml
---
id: weekly-status-report
name: Weekly Status Report
version: 1.4.0
category: official | community | local
summary: Compile a weekly status report from a project's task history.
slash: /weekly-report           # invocation handle
inputs:
  - { name: week, type: string, required: false, description: "ISO week, defaults to current" }
declaredPermissions:
  toolRisk: medium              # max risk this skill is allowed to reach without re-approval
  surfaces: [cloud]
  scripts: true                 # ships executable scripts -> triggers security scan
  network: [api.internal]       # egress allowlist the scripts may touch
---
```

## 18.2 `Skill` interface sketch

```typescript
type SkillCategory = 'official' | 'community' | 'local';
type SkillSource   = 'ui' | 'zip' | 'folder' | 'github' | 'from-task';
type ScanVerdict   = 'clean' | 'warn' | 'block';

interface Skill {
  id: string;                          // stable; from skill.json
  workspaceId?: string;                // null for official/global; set for community/local installs
  name: string;
  slash: string;                       // e.g. "/weekly-report"
  version: string;                     // semver; multiple versions can coexist
  category: SkillCategory;
  source: SkillSource;
  summary: string;                     // injected up-front (progressive disclosure)
  inputs: SkillInput[];

  declaredPermissions: SkillPermissions;
  scan: SkillSecurityReport;           // result of the security scan (must be clean|warn-with-approval to enable)
  enabled: boolean;

  // content references (lazy-loaded; NOT injected until invoked)
  bodyBlobRef: string;                 // SKILL.md body
  scriptRefs: { path: string; risk: RiskLevel; scan: ScanVerdict }[];
  promptRefs: { name: string; blobRef: string }[];
  workflowRefs: { name: string; blobRef: string }[];
  exampleRefs: string[];

  createdFromTaskId?: string;          // if generated from a successful task
  originRepo?: string;                 // if imported from GitHub
}

interface SkillInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'file' | 'enum';
  required: boolean;
  description?: string;
  enumValues?: string[];
}

interface SkillPermissions {
  toolRisk: RiskLevel;                 // ceiling; anything above re-prompts
  surfaces: ('cloud' | 'local')[];
  scripts: boolean;
  network: string[];                   // egress allowlist for scripts
  filesystem?: { mode: 'ro' | 'rw'; scope: string }[];
}

interface SkillSecurityReport {
  verdict: ScanVerdict;                // clean | warn | block
  scannedAt: Date;
  scannerVersion: string;
  findings: {
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
    rule: string;                      // e.g. "shell.curl-pipe-bash", "fs.outside-scope", "secret.exfil"
    location: string;                  // file:line
    detail: string;
  }[];
  requiresApprovalToEnable: boolean;   // true when verdict='warn'
}

interface WorkflowDef {                // parameterized task graph
  name: string;
  steps: {
    id: string;
    tool?: string;                     // tool to call
    promptRef?: string;                // or a prompt template
    inputsFrom: Record<string, string>; // wiring: {arg}->{stepOutput|skillInput}
    risk: RiskLevel;
    onError?: 'retry' | 'replan' | 'abort';
  }[];
}
```

## 18.3 Invocation flow (slash-command)

1. User types `/weekly-report week=2026-W24` in the task composer (or it's referenced via project `defaultSkillIds`, or by a mail/workflow address).
2. The composer resolves the slash to a `Skill` (workspace-scoped → community → official precedence) and **the specific enabled version**.
3. Inputs are Zod-validated against `inputs`; missing required inputs prompt the user inline.
4. The engine loads the skill **body, prompts, and workflow** *now* (progressive disclosure — see §18.6) and registers its scripts/tools into the task catalog **capped at `declaredPermissions.toolRisk`**.
5. If the skill ships scripts and its `scan.verdict='warn'`, an `approval_request` (risk = the script's classified risk) gates first execution.
6. The workflow (if present) drives the plan; otherwise `SKILL.md` body is injected as task instructions and the agent plans normally.
7. Every script execution runs **in the session sandbox** (cloud) or via the **sidecar under approval** (local) — never in the API/worker process. Egress is restricted to `declaredPermissions.network`.

## 18.4 Import paths

| Source | Tag | Flow |
|---|---|---|
| **UI** (build in the app) | LATER | Skill editor writes the package; saved as `local` |
| **Zip** | LATER | Upload → unzip to a quarantined temp → validate layout/manifest → **security scan** → install on `clean`/`warn(+approval)` |
| **Folder** (desktop) | LATER | Pick a local folder via native dialog → sidecar reads it RO → same validate+scan pipeline |
| **GitHub** | LATER | Paste repo URL → server-side shallow clone in a sandbox → validate+scan → install; `originRepo` recorded; pinned to a commit SHA |
| **From a successful task** | LATER | See §18.5 |

All import paths converge on one **`SkillInstaller`** pipeline: *unpack → schema-validate manifest → security-scan → risk-classify scripts → present report → enable on approval*.

## 18.5 Create-skill-from-successful-task (LATER)

After a task completes successfully, the user clicks "Save as skill." The engine:
1. Replays the task's persisted event stream (already available) and extracts the **plan, tool sequence, and parameters**.
2. **Parameterizes** the run: values that varied from defaults (URLs, names, the week, target folder) become `SkillInput`s; the engine proposes names/types, the user confirms.
3. Generates `SKILL.md` (instructions distilled from the successful plan), `skill.json` (declared permissions = the *actual* max risk used in the run, not broader), and a `default.workflow.json` mirroring the proven step graph.
4. Runs the **security scan** on any extracted scripts and presents the report.
5. Saves as a `local` skill (`createdFromTaskId` set). The user can later promote it to `community`.

This guarantees the generated skill's declared permissions are tight (least-privilege from observed behavior), not hand-waved.

## 18.6 Progressive disclosure

To avoid bloating the prompt and leaking unneeded detail:
- **Up-front (always loaded):** only `name`, `slash`, `summary`, and `inputs` of *available* skills (a one-line catalog). This is what the planner sees to decide whether to use a skill.
- **On invocation:** the `SKILL.md` body, the relevant prompt templates, and the workflow are loaded for *that* skill only.
- **On demand within a run:** examples and assets are fetched only if the step needs them (e.g. few-shot examples injected just for the generation step).
- Stable skill bodies are marked **prompt-cache-friendly** so repeated invocations reuse the cached prefix.

## 18.7 Security scanning + risk analysis (non-negotiable)

Because skills can ship scripts and shell, this is a hard-rule surface (scope-doc rule 7, "no spam/abuse/ToS violation"; stack §7.7 sandbox trust boundary). The **`SkillScanner`** runs on every install/import/update and on create-from-task:

- **Static checks (block-listed patterns):** `curl … | bash`, `rm -rf` outside scope, base64-decoded exec, raw socket/exfil to non-allowlisted hosts, reading `.env`/credential paths, writing outside declared `filesystem.scope`, dynamic `eval` on network input, requests to disallowed domains.
- **Manifest cross-check:** declared `network`/`filesystem`/`toolRisk` vs what the scripts actually reference; mismatch raises a `medium`+ finding ("script touches a host not in `network`").
- **Risk classification:** each script gets a `RiskLevel`; the skill's effective ceiling is `max(declared, classified)`.
- **Verdict gate:** `clean` → enable; `warn` → enable only after explicit user approval of the findings; `block` → cannot enable (the install is quarantined, never auto-run).
- **Re-scan on version change** and on scanner-version bump; cached `scan` is invalidated.
- **Runtime confinement:** even a `clean` skill's scripts run sandboxed with the declared egress allowlist; the scan reduces but does not replace runtime isolation.

## 18.8 Versioning

- Semver per skill; **multiple versions coexist**; a project pins the version it uses (`defaultSkillIds` store `id@version`).
- Updating publishes a new version; existing pins are unaffected until explicitly bumped (reproducibility).
- `official` skills are read-only to workspaces (can be pinned, not edited); `community`/`local` are editable and re-scanned on edit.

## 18.9 Folder / module placement

- `services/api`: `skills` module (install/import/scan/enable/version endpoints).
- `packages/agent-engine`: skill resolution, progressive disclosure, workflow execution.
- `packages/tool-abi`: skill scripts surface as risk-tagged tools (same ABI).
- `apps/web`: `/skills` (catalog: official/community/local tabs), skill editor, scan-report viewer.
- `apps/desktop`: folder-import via sidecar (RO read of the chosen folder).

## 18.10 Test scenarios & acceptance criteria — Skills

| ID | Scenario | Acceptance |
|---|---|---|
| S-1 | Install a valid zip skill | Layout+manifest validated; scan `clean`; skill enabled and slash resolves |
| S-2 | Import a skill whose script pipes `curl \| bash` | Scanner emits a `high` finding `shell.curl-pipe-bash`; verdict `warn` or `block`; cannot run until resolved |
| S-3 | Import a GitHub skill | Server-side clone in sandbox; pinned to a commit SHA; `originRepo` recorded; scan runs before enable |
| S-4 | Invoke `/skill` with a missing required input | Inline prompt for the input; nothing runs until provided; input is Zod-validated |
| S-5 | Skill declares `toolRisk=medium`; its workflow attempts a `high` action | Risk-gate forces an `approval_request`; ceiling enforced |
| S-6 | Progressive disclosure | Before invocation, only `summary`+`inputs` are in the prompt (asserted); body/scripts load only on invoke |
| S-7 | Create-skill-from-successful-task | Generated skill's `declaredPermissions.toolRisk` equals the max risk actually used; params extracted from varied values; scan runs |
| S-8 | Version coexistence | Pin v1 in a project, publish v2; the project keeps using v1 until bumped |
| S-9 | Script egress | A script tries to reach a host not in `declaredPermissions.network` | egress blocked at runtime + audited |
| S-10 | Edit a community skill | Re-scan triggers automatically; stale `scan` invalidated; re-enable requires the new verdict |

---

# §19 — Collaboration (real-time)

> **Phase:** **LATER / Phase 7 (`org`)**. Multiple users participate in one live Task. Built on the existing `/chat` namespace + Redis adapter; adds presence, a prompt queue, owner controls, and shared artifacts. Cost always attributes to the task owner/workspace.

## 19.1 Capabilities

| Capability | Tag |
|---|---|
| Invite a user to a task (link or workspace member) | LATER |
| Live task view for all participants (shared stream) | LATER |
| Multiple users prompt the same task | LATER |
| Prompt **queue** (ordered, owner-moderated) | LATER |
| Shared artifacts (all see/download deliverables) | LATER |
| Owner controls (pause sharing, mute, set read-only) | LATER |
| Read-only vs active sharing per collaborator | LATER |
| Remove a collaborator (instant revoke) | LATER |
| Sensitive-session warning + reset before sharing | LATER |
| Cost attribution to owner/workspace | LATER |

## 19.2 `CollaborationSession` interface sketch

```typescript
type CollabRole = 'owner' | 'active' | 'readonly';
type PromptState = 'queued' | 'running' | 'done' | 'rejected' | 'cancelled';

interface CollaborationSession {
  id: string;
  taskId: string;                      // the live Task being collaborated on
  workspaceId: string;
  ownerId: string;                     // cost payer + ultimate controller
  mode: 'private' | 'shared';
  sharing: 'paused' | 'active';        // owner can pause without removing anyone
  invites: CollabInvite[];
  participants: CollabParticipant[];
  promptQueue: QueuedPrompt[];
  sensitive: boolean;                  // flagged if session touched secrets/PII
  resetBeforeShareDone: boolean;       // gate: must reset a sensitive session before sharing
  createdAt: Date;
}

interface CollabInvite {
  id: string;
  email?: string;                      // external invite
  userId?: string;                     // existing member
  role: CollabRole;                    // active | readonly (owner is implicit)
  token: string;                       // single-use, scoped, expiring
  expiresAt: Date;
  acceptedAt?: Date;
}

interface CollabParticipant {
  userId: string;
  role: CollabRole;
  presence: 'online' | 'idle' | 'offline';
  joinedAt: Date;
  removedAt?: Date | null;
}

interface QueuedPrompt {
  id: string;
  byUserId: string;                    // actor (for audit)
  text: string;
  attachments?: string[];              // artifact/file refs
  state: PromptState;
  enqueuedAt: Date;
  decidedBy?: string;                  // owner who approved/rejected (if moderated)
}
```

## 19.3 Realtime contracts (added to `/chat`)

```typescript
// Server -> clients (extends ServerToClientEvents)
interface CollabServerEvents {
  presence:        (e: { taskId: string; participants: CollabParticipant[] }) => void;
  queue_updated:   (e: { taskId: string; queue: QueuedPrompt[] }) => void;
  prompt_state:    (e: { taskId: string; promptId: string; state: PromptState }) => void;
  sharing_state:   (e: { taskId: string; sharing: 'paused' | 'active' }) => void;
  collaborator_removed: (e: { taskId: string; userId: string }) => void;
  sensitive_warning:    (e: { taskId: string; reason: string }) => void;
}
// Client -> server (extends ClientToServerEvents)
interface CollabClientEvents {
  collab_join:     (e: { taskId: string; inviteToken?: string }) => void;
  collab_prompt:   (e: { taskId: string; text: string; attachments?: string[] }) => void;
  owner_moderate:  (e: { taskId: string; promptId: string; decision: 'accept' | 'reject' }) => void;
  owner_set_sharing:(e:{ taskId: string; sharing: 'paused' | 'active' }) => void;
  owner_set_role:  (e: { taskId: string; userId: string; role: CollabRole }) => void;
  owner_remove:    (e: { taskId: string; userId: string }) => void;
}
```

## 19.4 Prompt queue & multi-user prompting

- The Task runs a **single engine loop** (one brain). Concurrent prompts do **not** fork the engine; they **enqueue**.
- **`active`** collaborators can enqueue prompts; **`readonly`** cannot (their composer is disabled; they only watch + download).
- Queue ordering is FIFO with **owner moderation modes**: `open` (active prompts run in order automatically) or `moderated` (owner must `accept` each before it runs). Default for shared sessions is `moderated`.
- The engine drains the queue between steps/turns; the currently-running prompt is marked `running`, others `queued`. Owner can reorder or cancel.
- Every prompt records its **actor** (`byUserId`) in the audit log even though execution is the owner's brain/budget.

## 19.5 Owner controls, roles, removal

- **Read-only vs active** is per-participant (`role`), changeable live via `owner_set_role`.
- **Pause sharing** (`sharing: 'paused'`) freezes all non-owner input instantly without removing anyone (composers disabled, stream still visible) — a soft kill switch for the room.
- **Remove collaborator** (`owner_remove`) revokes their invite token, drops them from the `/chat` room (server-side disconnect, not client-trusted), nulls their participant record, and emits `collaborator_removed`. Revocation is **immediate** and asserted by test.
- The global **stop** (kill switch) remains owner/active-capable depending on policy; default: owner + active can `stop`, readonly cannot.

## 19.6 Sensitive-session warning & reset

- A session is flagged `sensitive: true` if, during its life, the agent accessed secrets, masked PII, local files, or connector data.
- Attempting to share a `sensitive` session emits `sensitive_warning` and **blocks** until the owner either (a) acknowledges and proceeds, or (b) runs **Reset before collaboration**: a `resetSession` action that strips the live context of sensitive material (redacts prior tool I/O from the shared replay buffer, clears local-file scopes, drops connector tokens from the live context) and sets `resetBeforeShareDone=true`. Only then does `sharing` flip to `active`.
- Newly joined collaborators receive the **post-reset** stream; they cannot scroll back into pre-reset sensitive content (the shared replay buffer is the redacted one).

## 19.7 Cost attribution

- **Actor ≠ payer.** Every queued prompt records `byUserId` for audit, but all token/cost metering for the task is attributed to **`ownerId` + the owning `workspaceId`** (and counts against that project/workspace budget). This is enforced in the metering layer: collaborator prompts inherit the owner's billing key; collaborators never spend their own quota.
- Cost readout in the shared view shows the running task cost to all participants (transparency), but the ledger entry's payer is always the owner.

## 19.8 Folder / module placement

- `services/gateway`: collaboration room logic on `/chat` (presence, queue, moderation), invite-token guard.
- `services/api`: `collaboration` module (invites, roles, removal, sensitive-reset endpoint).
- `apps/web`: shared task view (presence avatars, queue panel, owner controls, readonly composer lock).

## 19.9 Test scenarios & acceptance criteria — Collaboration

| ID | Scenario | Acceptance |
|---|---|---|
| C-1 | Owner invites user B (active); B joins via token | B appears in presence; B's composer is enabled; expired/used token rejected |
| C-2 | A (active) and B (active) prompt simultaneously | Both prompts enqueue; engine runs them in FIFO; no engine fork; both recorded with correct `byUserId` |
| C-3 | Moderated mode: B prompts | Prompt sits `queued` until owner `accept`; `reject` discards it; audited |
| C-4 | Owner sets B to `readonly` | B's composer disables live; B can still watch + download artifacts; a B prompt attempt is rejected server-side |
| C-5 | Owner removes B mid-run | B is disconnected from the room immediately (server-side); `collaborator_removed` emitted; B's token no longer works (asserted) |
| C-6 | Share a sensitive session without reset | `sensitive_warning` blocks sharing; only after `resetSession` does `sharing` go `active` |
| C-7 | After reset, B joins | B cannot access pre-reset sensitive tool I/O in the shared replay buffer (asserted on a seeded secret) |
| C-8 | Cost attribution | All tokens from B's prompts meter to the owner+workspace ledger; B's personal quota is untouched (asserted) |
| C-9 | Pause sharing | Non-owner composers freeze instantly; stream still visible; resume restores input |
| C-10 | Readonly attempts `stop` | Rejected per policy; owner/active `stop` works and halts within one step boundary |

---

# §20 — Mail-to-Task

> **Phase:** **LATER / Phase 8 (`ingest`)**. A unique bot email per user/workspace turns forwarded mail into Tasks, with a sender allowlist, attachment ingestion, result-by-email, workflow addresses, CC-as-collaborators, and abuse protection. Reuses the trigger plumbing from Automations (Phase 6) and Collaboration (Phase 7).

## 20.1 Capabilities

| Capability | Tag |
|---|---|
| Unique bot email per user/workspace | LATER |
| Approved-sender allowlist | LATER |
| Forward email → Task (parse subject/body/attachments) | LATER |
| Attachments → Task files | LATER |
| Send result by email | LATER |
| Workflow email addresses (predefined instructions) | LATER |
| CC users → collaborators | LATER |
| Spam/abuse protection (SPF/DKIM/DMARC, rate limits) | LATER |
| Full logs of every inbound/outbound mail | LATER |

## 20.2 Addressing scheme

- **Personal inbox address:** `u-<userToken>@inbound.<BRAND.storageDomain>` — forwards create a task owned by that user.
- **Workspace address:** `w-<workspaceToken>@inbound.<BRAND.storageDomain>` — task owned by the workspace.
- **Workflow address:** `<workflowSlug>.<projectSlug>@inbound.<BRAND.storageDomain>` — binds to a predefined instruction set / skill / project (e.g. `summarize.research@inbound.…`).
- Tokens are opaque, rotatable (rotating a token instantly invalidates the old address), and never the raw user/workspace id.

## 20.3 `MailTask` interface sketch

```typescript
type MailVerdict = 'accepted' | 'rejected_sender' | 'rejected_spam' | 'rejected_ratelimit' | 'quarantined';

interface MailTask {
  id: string;
  workspaceId: string;
  inboundAddress: string;              // which bot address received it
  addressKind: 'personal' | 'workspace' | 'workflow';
  workflowSlug?: string;               // if a workflow address
  projectId?: string;                  // resolved from workflow/address

  fromAddress: string;
  ccAddresses: string[];               // -> candidate collaborators
  subject: string;
  bodyText: string;                    // sanitized
  bodyHtmlBlobRef?: string;            // stored, not injected raw

  attachments: MailAttachment[];

  auth: { spf: boolean; dkim: boolean; dmarc: boolean }; // inbound auth results
  verdict: MailVerdict;
  rejectionReason?: string;

  createdTaskId?: string;              // the Task this produced (if accepted)
  requiresApproval: boolean;          // mail-created tasks gate before executing (hard rule)
  resultEmailSentAt?: Date | null;
  receivedAt: Date;
}

interface MailAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  blobRef: string;                     // stored in BlobStore -> becomes a Task file
  scanned: boolean;
  scanVerdict: 'clean' | 'block';      // malware/type scan
}

interface WorkflowEmailAddress {
  id: string;
  slug: string;                        // -> <slug>.<project>@inbound...
  projectId: string;
  instructions: string;                // predefined task instructions
  skillId?: string;                    // optional skill to invoke
  defaultRisk: RiskLevel;
  allowlist: string[];                 // senders allowed for THIS workflow
  enabled: boolean;
}
```

## 20.4 Inbound flow

1. **Receive.** Inbound provider (see §20.6) delivers the parsed message to a `POST /webhooks/inbound-mail` endpoint (HMAC-signed, IP-allowlisted).
2. **Authenticate the sender.** Check SPF/DKIM/DMARC results; check `fromAddress` against the relevant allowlist (personal/workspace/workflow). Non-allowlisted → `rejected_sender`, logged, no task created, optional bounce notice.
3. **Abuse gate.** Per-sender + per-address rate limits (Redis counters); spam scoring; oversized/too-many-attachment caps. Fail → `rejected_spam`/`rejected_ratelimit`, logged.
4. **Sanitize & parse.** Strip tracking pixels/active content from HTML; extract plain text for the body; store raw HTML as a blob (never injected raw into the model). Parse subject → task title, body → task instructions.
5. **Attachments → files.** Each attachment is malware/type-scanned, stored in `BlobStore`, and attached to the task as a file (so the agent can read them). `block` verdict drops that attachment + warns.
6. **Resolve target.** Personal/workspace/workflow → owner + project + (for workflow) predefined instructions/skill. Workflow instructions are prepended; the email body becomes the task input.
7. **CC → collaborators.** Each CC address that maps to a workspace member is added as a **readonly** collaborator (active requires explicit opt-in) on the created task (ties to §19). External CCs get a read-only share link if the workspace allows external sharing; otherwise ignored + logged.
8. **Create task — approval-gated.** Mail-created tasks are created `requiresApproval=true`: they appear in the **Inbox** as a pending task and **do not execute until a human approves** (hard rule: "approval before execute" for ingestion; scope-doc Phase-8 acceptance). The exception: a workflow address explicitly configured as auto-run for allowlisted senders may skip the gate but still honors per-action risk gating.
9. **Execute & deliver.** On approval, the normal engine loop runs. On completion, the result is emailed back to the sender (and CCs) via the outbound provider: summary + links to artifacts (presigned, expiring) — sensitive values masked.

## 20.5 Outbound (result email)

- Templated, brand-derived (`BRAND.supportEmail` as reply-to). Contains: task title, one-paragraph summary, list of artifacts as expiring presigned links (never raw blobs), and a "view in app" deep link.
- Masking applied to the summary; nothing `critical`/`sensitive` is ever placed in email body or headers.
- Send is logged (`resultEmailSentAt`), with delivery status tracked via the provider's webhook.

## 20.6 Local/mock implementation plan vs production guide

**Local / mock (dev + CI):**
- Run **MailHog** (or a tiny SMTP sink) in `infra/compose.yaml`. A small dev "mail-bridge" service polls MailHog, parses messages with `mailparser`, and POSTs them to the same `/webhooks/inbound-mail` endpoint the production provider hits — so the inbound code path is identical in dev and prod.
- Outbound in dev goes to MailHog's SMTP; the UI links to MailHog's web view to inspect result emails.
- SPF/DKIM/DMARC are stubbed to `true` in dev behind a config flag (documented threat-model caveat), so the allowlist/rate-limit logic is still exercised.

**Production guide (inbound email provider):**
- Use a managed **inbound parse** provider (e.g. an inbound-email/parse webhook service) that receives mail for the `inbound.<storageDomain>` MX and POSTs parsed JSON (headers, text/html, attachments, auth results) to our HMAC-signed webhook.
- DNS: add MX records for `inbound.<storageDomain>` to the provider; publish SPF/DKIM/DMARC for the outbound sending domain.
- Outbound via a transactional email API (the same vendor or a separate one) behind a `MailSender` interface, so provider is swappable.
- Verify provider webhooks (HMAC + IP allowlist), enforce TLS, and store nothing in email that exceeds the `operational` data class.
- Both inbound and outbound sit behind `packages` interfaces (`InboundMailSource`, `MailSender`) so the dev MailHog bridge and the prod provider are interchangeable with zero call-site changes.

## 20.7 Abuse, security & cost

- **Sender allowlist is mandatory** per address; default-deny. A non-allowlisted sender never creates a task.
- **Rate limits** per sender/address/workspace (Redis); breach → `rejected_ratelimit` + temporary block.
- **Attachment scanning** (type + malware) before any becomes a task file; `block` drops it.
- **Cost** is metered to the **address owner** (user or workspace), never the sender. A workflow address bills its owning project/workspace.
- **No open relay:** the bot never forwards arbitrary mail; it only sends result emails to the original sender/CCs of an accepted task.
- Every inbound and outbound message writes an audit row (sender, verdict, task linkage, redacted body).

## 20.8 Folder / module placement

- `services/api`: `mail` module (webhook receiver, allowlist, workflow addresses, outbound sender) + `inbound-mail` webhook route.
- `infra/compose.yaml`: MailHog + dev mail-bridge.
- `apps/web`: settings → "Mail-to-Task" (show addresses, manage allowlist, create workflow addresses), and Inbox surfacing of pending mail-created tasks.

## 20.9 Test scenarios & acceptance criteria — Mail-to-Task

| ID | Scenario | Acceptance |
|---|---|---|
| M-1 | Allowlisted sender forwards an email | `verdict='accepted'`; a Task is created `requiresApproval=true`; appears in Inbox; does not execute until approved |
| M-2 | Non-allowlisted sender | `verdict='rejected_sender'`; no Task; logged; (optional) bounce notice |
| M-3 | Email with 2 attachments | Both scanned + stored; attached as Task files; a `block`-verdict attachment is dropped + warned |
| M-4 | Workflow address `summarize.research@…` | Predefined instructions/skill applied; body becomes the input; project resolved |
| M-5 | Email CCs a workspace member | That member added as a readonly collaborator on the created task (§19) |
| M-6 | Result delivery | On completion, sender+CCs receive a templated email with expiring presigned artifact links; sensitive values masked |
| M-7 | Rate-limit breach | Nth message in the window → `rejected_ratelimit` + temp block; logged |
| M-8 | Dev parity | The MailHog dev-bridge hits the same `/webhooks/inbound-mail` path as prod; identical handling (asserted) |
| M-9 | HTML sanitization | Tracking pixels/active content stripped; raw HTML stored as blob, never injected into the model |
| M-10 | Cost attribution | Tokens meter to the address owner, never the sender |
| M-11 | Token rotation | Rotating an address token invalidates the old address immediately (mail to it is rejected) |

---

# §21 — Meeting Minutes

> **Phase:** **LATER / Phase 8 (`ingest`)**. Record audio (web/desktop), live transcript + diarization when possible, structured summary (decisions/action-items/owners), convert notes→tasks, generate report/email/slides, offline-safe local recording, audio artifact storage, and delete recording/transcript. Consent + on-device option are first-class (scope-doc C28).

## 21.1 Capabilities

| Capability | Tag |
|---|---|
| Record audio (web via MediaRecorder; desktop native capture) | LATER |
| Live transcript when possible | LATER |
| Diarization (speaker separation) when possible | LATER |
| Structured summary: decisions / action-items / owners | LATER |
| Convert notes/action-items → Tasks | LATER |
| Generate report / email / slides from the meeting | LATER |
| Offline-safe local recording (buffer locally, upload later) | LATER |
| Audio artifact storage | LATER |
| Delete recording / transcript (right-to-erasure) | LATER |
| Consent capture before recording | LATER |

## 21.2 `MeetingRecord` interface sketch

```typescript
type MeetingStatus = 'recording' | 'processing' | 'ready' | 'failed' | 'deleted';
type TranscribeMode = 'cloud' | 'on-device';

interface MeetingRecord {
  id: string;
  workspaceId: string;
  projectId?: string;                  // optional project binding (inherits context)
  ownerId: string;
  title: string;
  startedAt: Date;
  endedAt?: Date;
  status: MeetingStatus;

  consent: ConsentRecord;              // REQUIRED before recording starts
  capture: { source: 'web' | 'desktop'; mode: 'mic' | 'system' | 'both' };
  transcribeMode: TranscribeMode;      // on-device keeps audio local (privacy)

  audioBlobRef?: string;               // stored audio artifact (BlobStore or local-FS)
  transcript?: Transcript;
  summary?: MeetingSummary;

  derivedTaskIds: string[];            // tasks created from action items
  exports: MeetingExport[];            // report/email/slides artifacts

  retention: { deleteAudioAt?: Date; deleteTranscriptAt?: Date }; // auto-erasure policy
}

interface ConsentRecord {
  capturedAt: Date;
  method: 'in-app-checkbox' | 'verbal-logged' | 'all-parties-notified';
  participantsNotified: boolean;
  note?: string;
}

interface Transcript {
  language: string;
  diarized: boolean;
  segments: TranscriptSegment[];
}
interface TranscriptSegment {
  startMs: number; endMs: number;
  speaker?: string;                    // "Speaker 1" or resolved name (if diarized + mapped)
  text: string;
  confidence?: number;
}

interface MeetingSummary {
  abstract: string;
  decisions: { text: string; context?: string }[];
  actionItems: ActionItem[];
  risks?: string[];
  followUps?: string[];
}
interface ActionItem {
  id: string;
  text: string;
  owner?: string;                      // resolved to a participant/user when possible
  dueDate?: string;
  convertedTaskId?: string;            // set when turned into a Task
}

interface MeetingExport {
  kind: 'report' | 'email' | 'slides';
  blobRef: string;
  createdAt: Date;
}
```

## 21.3 Recording, transcript, diarization flow

1. **Consent first.** Recording cannot start until a `ConsentRecord` is captured (in-app checkbox at minimum; the UI shows a persistent "recording" indicator). This is a hard gate, asserted by test.
2. **Capture.**
   - **Web:** `MediaRecorder` captures mic (and, where the browser allows, tab/system audio) into chunked blobs.
   - **Desktop:** native capture via the Electron main process (mic and/or system audio), enabling **offline-safe local recording** — chunks are written to the user's disk via the sidecar first, so a network drop never loses audio.
3. **Live transcript (best-effort).** When online and `transcribeMode='cloud'`, audio chunks stream to the transcription path and partial `transcript_chunk` events stream over `/chat` to the live meeting view. When offline or `on-device`, transcription is deferred/local and the UI shows "transcribing after upload."
4. **Diarization (when possible).** If the chosen transcription path supports speaker separation, segments carry `speaker`; otherwise `diarized=false` and the summary degrades gracefully (no owner auto-assignment). Never block the pipeline on diarization.
5. **Upload / finalize.** On stop, remaining chunks finalize; in cloud mode audio uploads to `BlobStore` (presigned); in local/on-device mode audio stays on disk and only the transcript (or only the summary) is sent to the cloud per the privacy setting.
6. **Summarize.** The engine (via `LlmProvider`, `claude-opus-4-8`) produces `MeetingSummary` from the transcript using the project's context if `projectId` is set (inherits §17). Long transcripts are **chunked + map-reduced** (reuses the engine's summarization/context management) to control cost; a pre-flight estimate is shown for long meetings.

## 21.4 Notes → Tasks, and exports

- **Action item → Task.** Each `ActionItem` has a one-click "create task" that spawns a Task (in the bound project, inheriting its context), pre-filled with the item text + owner + due date; `convertedTaskId` links back. Bulk "create all" supported. Owners that resolve to workspace members can be CC'd/assigned (ties to §19/§20 collaborator logic).
- **Exports.** "Generate report" (markdown/PDF), "Generate email" (templated recap to participants via the §20 outbound sender), and "Generate slides" (deck) each run as engine tasks producing artifacts in `BlobStore`, recorded in `MeetingRecord.exports`. Slides/report generators are the same deliverable generators from Phase 9; meeting just supplies the structured input.

## 21.5 Privacy, consent, deletion

- **On-device option** (`transcribeMode='on-device'`, desktop): audio never leaves the machine; only the transcript/summary (per setting) reaches the cloud — the local-first differentiator applied to meetings.
- **Delete recording/transcript** is a first-class, irreversible action (right-to-erasure): deletes the audio blob and/or transcript, tombstones the `MeetingRecord` (`status='deleted'`), and cascades to remove transcript text from any cached prompt context. Retention policy (`retention.deleteAudioAt`) can auto-erase audio after N days while keeping the summary.
- **Masking** applies to transcript/summary before any sharing or email export (e.g. spoken card numbers redacted).
- Consent + every delete write audit rows.

## 21.6 Folder / module placement

- `apps/web`: `/meetings`, `/meetings/[id]` (recorder, live transcript, summary, action-items→tasks, exports); MediaRecorder capture.
- `apps/desktop`: native audio capture in main; offline buffer to disk via sidecar.
- `services/api`: `meetings` module (records, consent, summary trigger, exports, delete/retention).
- `services/worker` + `packages/agent-engine`: transcription orchestration + summarization (map-reduce).
- `packages/blob-store`: audio + export artifacts; local-FS adapter for on-device.

## 21.7 Test scenarios & acceptance criteria — Meeting Minutes

| ID | Scenario | Acceptance |
|---|---|---|
| MT-1 | Start recording without consent | Blocked; recording cannot begin until `ConsentRecord` exists (asserted); recording indicator shown while active |
| MT-2 | Record a short meeting (web) | Audio stored as artifact; transcript produced; `status` → `ready` |
| MT-3 | Live transcript online | `transcript_chunk` events stream over `/chat` to the live view; partials coalesce into final segments |
| MT-4 | Diarization available | Segments carry `speaker`; summary can assign action-item owners. When unavailable, `diarized=false` and pipeline still completes |
| MT-5 | Summary structure | `MeetingSummary` has abstract + decisions + actionItems (with owners when known); long transcript is chunked/map-reduced; pre-flight estimate shown |
| MT-6 | Action item → Task | Creates a Task in the bound project (inheriting context), pre-filled; `convertedTaskId` links back; bulk-create works |
| MT-7 | Generate exports | Report/email/slides artifacts created and recorded in `exports`; email recap routes through the §20 outbound sender with masking |
| MT-8 | Offline-safe recording (desktop) | Network drop mid-recording loses no audio (buffered to disk via sidecar); uploads/transcribes on reconnect |
| MT-9 | On-device mode | Audio never leaves the machine; only transcript/summary (per setting) reaches cloud (asserted: BlobStore cloud untouched) |
| MT-10 | Delete recording/transcript | Audio + transcript erased; `status='deleted'`; transcript removed from any cached context; audited; retention auto-erase honored |
| MT-11 | Masking in exports | A spoken sensitive value is redacted in transcript/summary/email export (asserted on a seeded secret) |

---

# Appendix A — Consolidated MVP-vs-LATER tag table

Tags are consistent with `docs/00-scope-and-phases.md` Appendix A (§18 Projects/Skills → Phase 7 with Projects-lite in Phase 1; §19 Collaboration → Phase 7; §20 Mail-to-Task & §21 Meeting → Phase 8).

| Area | Sub-feature | Tag | Phase |
|---|---|---|---|
| **Projects** | Grouping, task history, per-project budget cap, basic system-instructions, default permission profile | **MVP** | 1 |
| Projects | Knowledge base (RAG), memory, integrations, automations, agent settings, templates, clone, export/import, roles | **LATER** | 7 |
| Projects | Context-inheritance resolver (full depth: KB/memory/skills/integrations) | **LATER** | 7 |
| **Skills** | Package format, slash invocation, all import paths, create-from-task, scanning, versioning, progressive disclosure | **LATER** | 7 |
| **Collaboration** | Invite, live shared view, multi-prompt + queue, owner controls, roles, removal, sensitive reset, cost attribution | **LATER** | 7 |
| **Mail-to-Task** | Bot addresses, allowlist, parse, attachments→files, result email, workflow addresses, CC→collaborators, abuse protection, logs | **LATER** | 8 |
| **Meeting Minutes** | Record, live transcript, diarization, summary, notes→tasks, exports, offline-safe, storage, delete, consent | **LATER** | 8 |

**Cross-cutting (inherited from Phase 1 onward, not separate features):** risk-gated approval, audit logging, sensitive-data masking, cost/token metering & attribution, Zod-validated contracts, tenancy/RLS — all already mandated by the pinned docs and reused unchanged by every section above.
