# AgentOS — Database Schema Draft (§32)

> **Status:** Planning only. SQL/Prisma sketches pin the data contracts; they are not final migrations.
> **Engine:** PostgreSQL 16 (single primary, system of record) — per `01-stack-and-system-architecture.md` §6.7.
> **ORM:** Prisma (primary) + raw SQL / Kysely escape hatch for vector KNN, event-window, and usage-aggregation queries — §6.8.
> **Vector:** pgvector (HNSW) **inside** the primary Postgres — §6.9. Columns typed `Unsupported("vector(N)")` in Prisma, indexed via raw SQL in migrations.
> **Secrets:** envelope encryption (KMS master key wraps per-row AES-256-GCM data keys) — §6.20. Ciphertext only at rest; decrypt is server-only.
> **Phase tags** conform to `00-scope-and-phases.md`: **MVP** = Phases 0–4 (`secrets`, `api_keys`, audit, usage, cost, RO local-first land in P1–P4); **LATER** = Phases 5–13.
> **Brand:** no product-name literal appears in schema; identifiers are generic. Renaming is a `packages/brand` edit only (§34.6).

---

## 0. Conventions

- **PK:** every table has `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` (pgcrypto/`gen_random_uuid`), unless a natural composite key is noted.
- **Timestamps:** `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()` (app-maintained on write). Soft-deletable tables add `deleted_at timestamptz NULL`.
- **Tenancy:** every tenant-owned row carries `workspace_id uuid NOT NULL` for scoping; Postgres **Row-Level Security (RLS)** is enabled as a backstop (§7.7). App-level guards are primary; RLS is defense-in-depth.
- **Money/usage:** monetary amounts stored as `numeric(14,6)` USD; token counts `bigint`.
- **JSON:** flexible payloads use `jsonb` (GIN-indexed where queried).
- **Enums:** declared as native Postgres `ENUM` types (mirrored as Prisma `enum`). Listed in §1.
- **FK policy:** `ON DELETE CASCADE` for child rows wholly owned by a parent (e.g. `task_steps` → `tasks`); `ON DELETE RESTRICT` for references that must not orphan audited history; `ON DELETE SET NULL` for soft references (e.g. `audit_logs.actor_user_id`).
- **Append-only tables** (`task_logs`, `audit_logs`, `usage_records`, `cost_records`, event-stream rows): no `UPDATE`/`DELETE` in app paths; **range-partitioned by `created_at` (monthly)** for cheap retention/replay (§6.7).
- **Naming:** snake_case tables/columns in SQL; Prisma models PascalCase with `@@map`.

### Migration approach
- **Tool:** `prisma migrate` for schema/relations; **raw SQL migration files** (committed alongside) for: pgvector extension + HNSW indexes, native `ENUM` creation, RLS policies, partition setup, and `pg_trgm`/GIN indexes Prisma can't express. Order: `CREATE EXTENSION` → enums → tables → indexes → RLS → partitions.
- **Extensions:** `CREATE EXTENSION IF NOT EXISTS pgcrypto;` (UUIDs), `vector;` (pgvector), `pg_trgm;` (fuzzy search on names/logs).
- **Reversibility:** every migration ships an `up` + `down`; CI asserts apply-then-rollback is clean (Phase 1 acceptance criterion).
- **Partitioning:** parent tables declared `PARTITION BY RANGE (created_at)`; a scheduled job pre-creates next-month partitions; cold partitions are detachable/archivable to object storage (Later).
- **Seeding:** a deterministic seed creates a system workspace, the built-in tool-registry rows mirror of `packages/tool-abi` (read-only reflection), and risk-policy defaults.

---

## 1. Enums

```prisma
enum RiskLevel        { low medium high critical }            // §00 hard rule; tool-abi source of truth
enum TaskStatus       { pending planning awaiting_approval running paused verifying completed failed stopped }
enum StepStatus       { pending running awaiting_approval succeeded failed skipped stopped }
enum ApprovalStatus   { pending approved denied expired auto_approved }
enum MemberRole       { owner admin member viewer }           // workspace & project membership
enum SecretType       { llm_api_key oauth_client_secret connector_token sidecar_token webhook_secret generic }
enum IntegrationKind  { slack github gmail gdrive notion linear webhook custom }
enum AutomationTrigger{ cron event_mail event_webhook manual }
enum JobStatus        { queued active completed failed delayed paused stalled }
enum ArtifactKind     { report spreadsheet file image slide site_bundle transcript dataset other }
enum NotificationKind { approval_request task_done agent_question system billing }
enum SandboxStatus    { provisioning ready idle reaping terminated error }
enum BrowserKind      { cloud_headless local_preferred }      // preferred_browsers + browser_sessions
enum SessionMode      { cloud local_first }                   // §7.5 execution path
enum SkillVisibility  { private workspace public }
enum TriggerKind      { schedule mail webhook event }         // workflow_triggers
enum CostScope        { task workspace user month }
```

---

## 2. Table catalog (phase tags)

| # | Table | Domain | Phase |
|---|---|---|---|
| 1 | `users` | identity | **MVP** P1 |
| 2 | `workspaces` | tenancy | **MVP** P1 |
| 3 | `workspace_members` | tenancy/RBAC | **MVP** P1 |
| 4 | `projects` | grouping | **MVP-lite** P1 |
| 5 | `project_members` | grouping/RBAC | LATER P7 |
| 6 | `project_files` | grouping | **MVP-lite** P1 |
| 7 | `project_instructions` | grouping | LATER P7 |
| 8 | `tasks` | agent core | **MVP** P2 |
| 9 | `task_steps` | agent core | **MVP** P2 |
| 10 | `task_logs` | agent core / event stream | **MVP** P2 |
| 11 | `tool_calls` | tools | **MVP** P2 |
| 12 | `browser_sessions` | browser | **MVP** P2 (cloud) / P5 (preferred) |
| 13 | `preferred_browsers` | browser | LATER P5 |
| 14 | `files` | files/artifacts | **MVP** P2 |
| 15 | `file_chunks` | files/RAG | **MVP** P2 (chunking) / vector P1+ |
| 16 | `artifacts` | artifacts | **MVP-lite** P2 |
| 17 | `artifact_versions` | artifacts | **MVP-lite** P2 |
| 18 | `automations` | automations | LATER P6 |
| 19 | `automation_runs` | automations | LATER P6 |
| 20 | `integrations` | connectors | LATER P7 (OAuth P10) |
| 21 | `mcp_connectors` | MCP | LATER P10 |
| 22 | `skills` | skills | LATER P7 |
| 23 | `secrets` | security | **MVP** P1 |
| 24 | `api_keys` | security / public-API | **MVP** P1 (LLM key) / public P10 |
| 25 | `audit_logs` | security | **MVP** P1 |
| 26 | `notifications` | platform | **MVP-lite** P3 (approvals) |
| 27 | `usage_records` | metering | **MVP** P2 |
| 28 | `cost_records` | metering | **MVP** P2 |
| 29 | `memory_items` | memory | LATER P7 |
| 30 | `vector_documents` | memory/RAG | **MVP-lite** P1 (minimal) / P7 |
| 31 | `workers` | infra | **MVP** P2 |
| 32 | `queue_jobs` | infra | **MVP** P2 |
| 33 | `collaboration_sessions` | collaboration | LATER P7 |
| 34 | `collaborators` | collaboration | LATER P7 |
| 35 | `mail_tasks` | ingestion | LATER P8 |
| 36 | `meeting_records` | ingestion | LATER P8 |
| 37 | `data_providers` | connectors/data | LATER P10 |
| 38 | `workflow_triggers` | automations | LATER P6 |

---

## 3. Identity & tenancy

### 3.1 `users` — **MVP P1**
```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  emailVerified DateTime?
  displayName   String
  avatarUrl     String?
  passwordHash  String?              // argon2id; null if SSO-only (Later)
  status        String   @default("active") // active|suspended|deleted
  lastLoginAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?

  memberships   WorkspaceMember[]
  projectMembers ProjectMember[]
  auditLogs     AuditLog[]          @relation("actor")
  notifications Notification[]
  @@index([email])
  @@map("users")
}
```
- **Indexes:** unique `email`; `pg_trgm` GIN on `display_name` for admin search (Later).

### 3.2 `workspaces` — **MVP P1**
```prisma
model Workspace {
  id              String   @id @default(uuid())
  name            String
  slug            String   @unique
  ownerUserId     String
  planTier        String   @default("free")  // free|team|enterprise (billing Later)
  budgetCapUsd    Decimal? @db.Decimal(14,6)  // hard monthly cap (§00 cost rule)
  costThresholdUsd Decimal? @db.Decimal(14,6) // pre-flight estimate gate
  defaultRiskPolicy Json?                      // per-risk-level approval policy
  settings        Json?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  deletedAt       DateTime?

  members         WorkspaceMember[]
  projects        Project[]
  tasks           Task[]
  @@map("workspaces")
}
```

### 3.3 `workspace_members` — **MVP P1**
```prisma
model WorkspaceMember {
  id          String     @id @default(uuid())
  workspaceId String
  userId      String
  role        MemberRole @default(member)
  invitedBy   String?
  joinedAt    DateTime?
  createdAt   DateTime   @default(now())

  workspace   Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user        User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([workspaceId, userId])
  @@index([userId])
  @@map("workspace_members")
}
```

---

## 4. Projects (grouping)

### 4.1 `projects` — **MVP-lite P1** (depth LATER P7)
```prisma
model Project {
  id            String   @id @default(uuid())
  workspaceId   String
  name          String
  description   String?
  budgetCapUsd  Decimal? @db.Decimal(14,6)  // per-project cap (§C9 differentiator)
  permissionProfile Json?                    // per-tool permission scopes
  archivedAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  workspace     Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  members       ProjectMember[]
  files         ProjectFile[]
  instructions  ProjectInstruction[]
  tasks         Task[]
  @@index([workspaceId])
  @@map("projects")
}
```

### 4.2 `project_members` — **LATER P7**
```prisma
model ProjectMember {
  id        String     @id @default(uuid())
  projectId String
  userId    String
  role      MemberRole @default(member)
  createdAt DateTime   @default(now())
  project   Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user      User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([projectId, userId])
  @@map("project_members")
}
```

### 4.3 `project_files` — **MVP-lite P1**
```prisma
model ProjectFile {
  id        String   @id @default(uuid())
  projectId String
  fileId    String                       // → files.id (shared project context)
  addedBy   String?
  createdAt DateTime @default(now())
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  file      File     @relation(fields: [fileId], references: [id], onDelete: Cascade)
  @@unique([projectId, fileId])
  @@map("project_files")
}
```

### 4.4 `project_instructions` — **LATER P7**
```prisma
model ProjectInstruction {
  id        String   @id @default(uuid())
  projectId String
  title     String
  body      String                       // standing instructions injected into prompts
  enabled   Boolean  @default(true)
  position  Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@index([projectId])
  @@map("project_instructions")
}
```

---

## 5. Agent core (tasks, steps, logs, tool calls)

### 5.1 `tasks` — **MVP P2**
The unit of work. A task carries a plan, steps, an event log, artifacts, audit, and a verified deliverable.
```prisma
model Task {
  id            String     @id @default(uuid())
  workspaceId   String
  projectId     String?
  createdByUserId String
  title         String
  prompt        String                       // original natural-language task
  status        TaskStatus @default(pending)
  mode          SessionMode @default(cloud)  // §7.5
  plan          Json?                         // decomposed plan snapshot
  riskCeiling   RiskLevel  @default(high)     // max auto-allowed without approval
  stepBudget    Int        @default(50)
  tokenBudget   BigInt?                       // hard token budget
  costBudgetUsd Decimal?   @db.Decimal(14,6)
  estTokens     BigInt?                       // pre-flight estimate
  estCostUsd    Decimal?   @db.Decimal(14,6)
  killRequested Boolean    @default(false)    // instant-stop flag, polled between steps
  epoch         Int        @default(0)        // epoch guard for stop/replan
  result        Json?                         // final_output summary + artifact refs
  startedAt     DateTime?
  finishedAt    DateTime?
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  workspace     Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  project       Project?   @relation(fields: [projectId], references: [id], onDelete: SetNull)
  steps         TaskStep[]
  logs          TaskLog[]
  toolCalls     ToolCall[]
  artifacts     Artifact[]
  usage         UsageRecord[]
  costs         CostRecord[]
  @@index([workspaceId, status])
  @@index([projectId])
  @@index([createdAt])
  @@map("tasks")
}
```
- **Indexes:** `(workspace_id, status)` for dashboards; `created_at` for replay/history; partial index `WHERE status IN ('running','awaiting_approval','paused')` for the active-run scanner.

### 5.2 `task_steps` — **MVP P2**
```prisma
model TaskStep {
  id          String     @id @default(uuid())
  taskId      String
  index       Int                            // ordinal in plan
  title       String
  description String?
  status      StepStatus @default(pending)
  risk        RiskLevel  @default(low)
  parentStepId String?                       // sub-steps / replanned branches
  toolName    String?
  attempt     Int        @default(1)         // retry counter (error recovery)
  startedAt   DateTime?
  finishedAt  DateTime?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  task        Task       @relation(fields: [taskId], references: [id], onDelete: Cascade)
  toolCalls   ToolCall[]
  approvals   Approval[]
  @@index([taskId, index])
  @@map("task_steps")
}
```

### 5.3 `approvals` (risk-gate record) — **MVP P2** *(supporting table; gating is a hard rule)*
```prisma
model Approval {
  id          String         @id @default(uuid())
  taskId      String
  stepId      String?
  toolCallId  String?
  workspaceId String
  action      String                         // human-readable action description
  risk        RiskLevel
  status      ApprovalStatus @default(pending)
  detail      Json?                          // masked payload preview
  scopeGrant  Json?                          // e.g. folder rw grant on approve
  requestedAt DateTime       @default(now())
  decidedAt   DateTime?
  decidedBy   String?
  expiresAt   DateTime?
  task        Task           @relation(fields: [taskId], references: [id], onDelete: Cascade)
  step        TaskStep?      @relation(fields: [stepId], references: [id], onDelete: SetNull)
  @@index([taskId, status])
  @@index([workspaceId, status])
  @@map("approvals")
}
```

### 5.4 `task_logs` — **MVP P2** (append-only event stream; replayable)
This is the persisted, replayable event stream (§7.4): `plan`/`message`/`tool_call`/`tool_result`/`approval_request`/`cost_estimate`/`status`/`final_output`.
```prisma
model TaskLog {
  id          String   @id @default(uuid())
  taskId      String
  workspaceId String
  seq         BigInt                         // monotonic per-task ordering for replay
  type        String                         // protocol event type
  payload     Json                           // masked/redacted at write
  risk        RiskLevel?
  redacted    Boolean  @default(false)
  createdAt   DateTime @default(now())
  task        Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  @@unique([taskId, seq])
  @@index([taskId, createdAt])
  @@map("task_logs")
}
```
- **Partitioned by `created_at` monthly.** High-write: gateway batches/coalesces partials before bulk insert (§7.8).
- **Index:** `(task_id, seq)` unique drives deterministic replay; GIN on `payload` only if event search is needed (Later).

### 5.5 `tool_calls` — **MVP P2**
```prisma
model ToolCall {
  id          String    @id @default(uuid())
  taskId      String
  stepId      String?
  workspaceId String
  callId      String                          // correlates tool_call ↔ tool_result on the wire
  toolName    String
  surface     String                          // cloud|local|either (tool-abi)
  risk        RiskLevel
  args        Json                            // masked
  output      Json?                           // masked; redacted flag below
  ok          Boolean?
  redacted    Boolean   @default(false)
  errorText   String?
  durationMs  Int?
  sandboxSessionId String?                    // → workers/sandbox correlation
  startedAt   DateTime?
  finishedAt  DateTime?
  createdAt   DateTime  @default(now())
  task        Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)
  step        TaskStep? @relation(fields: [stepId], references: [id], onDelete: SetNull)
  @@unique([taskId, callId])
  @@index([workspaceId, toolName])
  @@map("tool_calls")
}
```

---

## 6. Browser

### 6.1 `browser_sessions` — **MVP P2 (cloud headless)** / extends P5
```prisma
model BrowserSession {
  id          String      @id @default(uuid())
  taskId      String?
  workspaceId String
  kind        BrowserKind @default(cloud_headless)
  sandboxSessionId String?                    // cloud Playwright context
  preferredBrowserId String?                  // local profile (Later)
  startUrl    String?
  status      String      @default("active")  // active|closed|takeover|error
  tracePath   String?                         // object-storage key for Playwright trace
  vncUrl      String?                         // takeover/VNC (Later)
  createdAt   DateTime    @default(now())
  closedAt    DateTime?
  @@index([taskId])
  @@index([workspaceId])
  @@map("browser_sessions")
}
```

### 6.2 `preferred_browsers` — **LATER P5**
Approved local browser profiles the agent may drive (Takeover, per-domain consent).
```prisma
model PreferredBrowser {
  id          String   @id @default(uuid())
  workspaceId String
  userId      String
  deviceId    String                           // bound to a sidecar device
  browser     String                           // chrome|edge|firefox
  profilePath String
  label       String?
  allowedDomains Json?                          // per-domain consent allowlist
  enabled     Boolean  @default(false)
  createdAt   DateTime @default(now())
  @@index([workspaceId, userId])
  @@map("preferred_browsers")
}
```

---

## 7. Files & artifacts

### 7.1 `files` — **MVP P2**
A logical file (uploaded, generated, or local-first reference). Bytes live in object storage (`BlobStore`) or, in local-first mode, on the user's disk via the sidecar (§6.16) — `storage` distinguishes.
```prisma
model File {
  id          String   @id @default(uuid())
  workspaceId String
  taskId      String?
  uploadedBy  String?
  name        String
  mimeType    String?
  sizeBytes   BigInt?
  storage     String   @default("blob")        // blob|local_fs
  blobKey     String?                           // object-storage key (presigned)
  localPath   String?                           // canonicalized path (local-first)
  sha256      String?                           // content hash (content-addressed)
  sensitivity String   @default("sensitive")    // operational|sensitive|critical
  createdAt   DateTime @default(now())
  deletedAt   DateTime?
  chunks      FileChunk[]
  projectLinks ProjectFile[]
  @@index([workspaceId])
  @@index([sha256])
  @@map("files")
}
```

### 7.2 `file_chunks` — **MVP P2 (chunking)** / vector embeddings P1+
Chunked file content for context management / RAG. **Carries a pgvector embedding column.**
```prisma
model FileChunk {
  id          String  @id @default(uuid())
  fileId      String
  workspaceId String
  index       Int
  content     String
  tokenCount  Int?
  // pgvector — declared via raw SQL migration; Prisma sees Unsupported:
  embedding   Unsupported("vector(1536)")?
  metadata    Json?
  createdAt   DateTime @default(now())
  file        File     @relation(fields: [fileId], references: [id], onDelete: Cascade)
  @@unique([fileId, index])
  @@map("file_chunks")
}
```
- **Vector index (raw SQL):** `CREATE INDEX file_chunks_embedding_hnsw ON file_chunks USING hnsw (embedding vector_cosine_ops);`
- **Tenancy on KNN:** every similarity query filters `WHERE workspace_id = $1` (no cross-tenant leakage — §6.9).
- **Dimension** `1536` is a placeholder constant sourced from the LLM/embeddings planning doc; one constant, not scattered.

### 7.3 `artifacts` — **MVP-lite P2**
The deliverable store (content-addressed, audit-linked, versioned — §C12).
```prisma
model Artifact {
  id          String       @id @default(uuid())
  workspaceId String
  taskId      String?
  projectId   String?
  kind        ArtifactKind @default(report)
  title       String
  currentVersionId String?
  isPublic    Boolean      @default(false)     // public share (Later)
  shareSlug   String?      @unique             // replay/share link (Later)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  task        Task?        @relation(fields: [taskId], references: [id], onDelete: SetNull)
  versions    ArtifactVersion[]
  @@index([workspaceId, kind])
  @@map("artifacts")
}
```

### 7.4 `artifact_versions` — **MVP-lite P2**
```prisma
model ArtifactVersion {
  id          String   @id @default(uuid())
  artifactId  String
  version     Int                              // 1..N
  blobKey     String                           // object-storage key
  sha256      String
  sizeBytes   BigInt?
  createdBy   String?
  notes       String?
  createdAt   DateTime @default(now())
  artifact    Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  @@unique([artifactId, version])
  @@map("artifact_versions")
}
```

---

## 8. Automations & triggers — **LATER P6**

### 8.1 `automations`
```prisma
model Automation {
  id            String            @id @default(uuid())
  workspaceId   String
  projectId     String?
  name          String
  triggerType   AutomationTrigger
  cronExpr      String?                         // for cron triggers (BullMQ repeatable)
  promptTemplate String                          // task spawned on fire
  approvalPolicy Json?                           // per-automation approval policy
  dryRun        Boolean           @default(false)
  enabled       Boolean           @default(true)
  lastRunAt     DateTime?
  nextRunAt     DateTime?
  createdBy     String
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt
  runs          AutomationRun[]
  triggers      WorkflowTrigger[]
  @@index([workspaceId, enabled])
  @@map("automations")
}
```

### 8.2 `automation_runs`
```prisma
model AutomationRun {
  id           String     @id @default(uuid())
  automationId String
  taskId       String?                          // task created by this run
  status       JobStatus  @default(queued)
  wasDryRun    Boolean    @default(false)
  triggeredBy  TriggerKind
  payload      Json?                            // mail/webhook/event payload (masked)
  startedAt    DateTime?
  finishedAt   DateTime?
  createdAt    DateTime   @default(now())
  automation   Automation @relation(fields: [automationId], references: [id], onDelete: Cascade)
  @@index([automationId, createdAt])
  @@map("automation_runs")
}
```

### 8.3 `workflow_triggers` — **LATER P6**
Generic trigger registry reused by automations, mail-to-task, and webhooks.
```prisma
model WorkflowTrigger {
  id           String      @id @default(uuid())
  workspaceId  String
  automationId String?
  kind         TriggerKind
  config       Json                              // cron expr | mail allowlist | webhook secret ref | event filter
  secretId     String?                           // → secrets (webhook signing)
  enabled      Boolean     @default(true)
  createdAt    DateTime    @default(now())
  automation   Automation? @relation(fields: [automationId], references: [id], onDelete: Cascade)
  @@index([workspaceId, kind])
  @@map("workflow_triggers")
}
```

---

## 9. Integrations, MCP, skills, data providers

### 9.1 `integrations` (connectors) — **LATER P7** (OAuth P10)
```prisma
model Integration {
  id          String          @id @default(uuid())
  workspaceId String
  kind        IntegrationKind
  displayName String
  status      String          @default("connected") // connected|revoked|error
  scopes      Json?
  accountRef  String?                                // external account id (non-secret)
  tokenSecretId String?                              // → secrets (brokered server-side)
  createdBy   String
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt
  @@index([workspaceId, kind])
  @@map("integrations")
}
```

### 9.2 `mcp_connectors` — **LATER P10**
User-installed MCP servers exposed through the tool registry with risk tags + per-server scopes.
```prisma
model McpConnector {
  id          String   @id @default(uuid())
  workspaceId String
  name        String
  transport   String                                  // stdio|http|ws
  endpoint    String?
  command     String?                                 // for stdio servers (sandboxed exec)
  permissionScopes Json?                              // per-server allow/deny
  toolRiskOverrides Json?                             // risk tag per exposed tool
  enabled     Boolean  @default(false)
  createdBy   String
  createdAt   DateTime @default(now())
  @@index([workspaceId])
  @@map("mcp_connectors")
}
```

### 9.3 `skills` — **LATER P7**
Reusable parameterized task graphs (§C14).
```prisma
model Skill {
  id          String          @id @default(uuid())
  workspaceId String
  name        String
  description String?
  graph       Json                                    // parameterized step graph
  parameters  Json                                    // typed input params (Zod-mirrored)
  visibility  SkillVisibility @default(private)
  version     Int             @default(1)
  createdBy   String
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt
  @@index([workspaceId, visibility])
  @@map("skills")
}
```

### 9.4 `data_providers` — **LATER P10**
Configured external data sources the agent can query (read-scoped).
```prisma
model DataProvider {
  id          String   @id @default(uuid())
  workspaceId String
  name        String
  kind        String                                  // sql|rest|gsheet|s3|warehouse
  config      Json                                    // non-secret connection config
  secretId    String?                                 // → secrets (credentials)
  readOnly    Boolean  @default(true)
  enabled     Boolean  @default(false)
  createdBy   String
  createdAt   DateTime @default(now())
  @@index([workspaceId])
  @@map("data_providers")
}
```

---

## 10. Security: secrets, API keys, audit

### 10.1 `secrets` — **MVP P1** *(envelope-encrypted)*
The **only** store of critical material (LLM key, OAuth secrets, connector/sidecar/webhook tokens). Ciphertext at rest; decrypt is server-only (§6.20, §7.7).
```prisma
model Secret {
  id            String     @id @default(uuid())
  workspaceId   String
  type          SecretType
  label         String
  ciphertext    Bytes                                 // AES-256-GCM payload
  iv            Bytes                                  // GCM nonce
  authTag       Bytes                                 // GCM auth tag
  wrappedDataKey Bytes                                 // per-row data key, KMS-wrapped (envelope)
  kmsKeyId      String                                 // master key id / version (rotation)
  lastFour      String?                                // masked display only (e.g. "…aB3x")
  createdBy     String
  rotatedAt     DateTime?
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt
  @@index([workspaceId, type])
  @@map("secrets")
}
```
- **Encryption note:** never store plaintext; `last_four` is the only thing safe to render. Decryption happens **only** inside the API/engine process boundary. CI bundle scan asserts no secret reaches any client artifact (§F1).
- **Rotation:** changing the master key re-wraps `wrappedDataKey` only — data ciphertext untouched.
- **RLS:** strict `workspace_id` policy; `secrets` is never returned by any list endpoint with ciphertext fields — only `id`, `type`, `label`, `last_four`.

### 10.2 `api_keys` — **MVP P1 (LLM/BYO key pointer)** / public-API keys **LATER P10**
Two roles: (a) reference to the workspace's LLM/provider key (stored in `secrets`); (b) issued **public API** keys for programmatic access (Later).
```prisma
model ApiKey {
  id          String   @id @default(uuid())
  workspaceId String
  purpose     String                                  // llm_provider | public_api
  provider    String?                                 // anthropic (default), ... (LATER)
  secretId    String?                                 // → secrets (the actual key material)
  // public-API key fields (LATER P10):
  publicId    String?  @unique                          // visible key id (e.g. ak_live_...)
  hashedKey   String?                                   // argon2/sha256 of the public secret (never plaintext)
  scopes      Json?                                     // tasks:read, tasks:write, files:read ...
  rateLimitTier String? @default("standard")
  lastUsedAt  DateTime?
  expiresAt   DateTime?
  revokedAt   DateTime?
  createdBy   String
  createdAt   DateTime @default(now())
  @@index([workspaceId, purpose])
  @@map("api_keys")
}
```
- **Encryption note:** public-API keys are stored **hashed** (`hashedKey`) and only shown in plaintext once at creation; the LLM provider key material lives in `secrets` (envelope-encrypted), referenced by `secretId`.

### 10.3 `audit_logs` — **MVP P1** (append-only, partitioned)
Every privileged mutation / important action (§00 hard rule). Tamper-evident; exportable (Later P7).
```prisma
model AuditLog {
  id           String    @id @default(uuid())
  workspaceId  String
  actorUserId  String?                                 // null = system/agent
  actorType    String    @default("user")              // user|agent|system|api_key
  action       String                                  // verb.noun, e.g. task.stop, secret.create
  targetType   String?
  targetId     String?
  risk         RiskLevel?
  metadata     Json?                                   // masked
  prevHash     String?                                 // hash chain for tamper-evidence
  hash         String?                                 // sha256(prevHash + row)
  ip           String?
  userAgent    String?
  createdAt    DateTime  @default(now())
  actor        User?     @relation("actor", fields: [actorUserId], references: [id], onDelete: SetNull)
  @@index([workspaceId, createdAt])
  @@index([action])
  @@map("audit_logs")
}
```
- **Partitioned by `created_at` monthly.** Hash chain (`prevHash`→`hash`) makes the log tamper-evident for export.

### 10.4 `notifications` — **MVP-lite P3** (approvals) / full LATER
```prisma
model Notification {
  id          String           @id @default(uuid())
  workspaceId String
  userId      String
  kind        NotificationKind
  title       String
  body        String?
  taskId      String?
  approvalId  String?
  readAt      DateTime?
  createdAt   DateTime         @default(now())
  user        User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, readAt])
  @@map("notifications")
}
```

---

## 11. Metering: usage & cost

### 11.1 `usage_records` — **MVP P2** (append-only, partitioned)
Raw token usage per LLM call; rolls up into `cost_records`.
```prisma
model UsageRecord {
  id            String   @id @default(uuid())
  workspaceId   String
  taskId        String?
  userId        String?
  provider      String   @default("anthropic")
  model         String   @default("claude-opus-4-8")
  inputTokens   BigInt   @default(0)
  outputTokens  BigInt   @default(0)
  cacheReadTokens  BigInt @default(0)               // prompt-caching accounting
  cacheWriteTokens BigInt @default(0)
  toolCallId    String?
  createdAt     DateTime @default(now())
  task          Task?    @relation(fields: [taskId], references: [id], onDelete: SetNull)
  @@index([workspaceId, createdAt])
  @@index([taskId])
  @@map("usage_records")
}
```

### 11.2 `cost_records` — **MVP P2**
Computed/aggregated cost per scope (task / workspace / user / month).
```prisma
model CostRecord {
  id          String    @id @default(uuid())
  workspaceId String
  scope       CostScope                                 // task|workspace|user|month
  taskId      String?
  userId      String?
  periodMonth String?                                   // 'YYYY-MM' for month scope
  amountUsd   Decimal   @db.Decimal(14,6)
  tokenCount  BigInt    @default(0)
  computedAt  DateTime  @default(now())
  task        Task?     @relation(fields: [taskId], references: [id], onDelete: SetNull)
  @@unique([workspaceId, scope, taskId, userId, periodMonth])
  @@index([workspaceId, periodMonth])
  @@map("cost_records")
}
```
- **Pre-flight estimate** writes a provisional `cost_records`/`tasks.est_cost_usd` row before expensive runs (§00 cost rule).

---

## 12. Memory & vector store

### 12.1 `memory_items` — **LATER P7**
User/workspace memory, preferences, playbooks (privacy-controlled — what reaches the model).
```prisma
model MemoryItem {
  id          String   @id @default(uuid())
  workspaceId String
  userId      String?
  kind        String                                    // preference|fact|playbook|note
  content     String
  shareToModel Boolean @default(true)                    // privacy control (§00)
  source      String?                                    // task id / manual / import
  vectorDocId String?                                    // → vector_documents
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([workspaceId, kind])
  @@map("memory_items")
}
```

### 12.2 `vector_documents` — **MVP-lite P1 (minimal)** / depth LATER P7
Generic embedded-document store for RAG over memory, knowledge, and imported docs. **Carries the pgvector column.**
```prisma
model VectorDocument {
  id          String   @id @default(uuid())
  workspaceId String
  ownerType   String                                    // memory|knowledge|file|skill
  ownerId     String?
  content     String
  // pgvector — raw-SQL HNSW index in migration:
  embedding   Unsupported("vector(1536)")?
  metadata    Json?
  createdAt   DateTime @default(now())
  @@index([workspaceId, ownerType])
  @@map("vector_documents")
}
```
- **Vector index (raw SQL):** `CREATE INDEX vector_documents_embedding_hnsw ON vector_documents USING hnsw (embedding vector_cosine_ops);`
- **Tenancy on KNN:** mandatory `WHERE workspace_id = $1` filter; HNSW + filter keeps retrieval tenant-scoped (§6.9).

---

## 13. Infra: workers & queue

### 13.1 `workers` — **MVP P2**
Registry/heartbeat of BullMQ worker instances + active sandbox sessions (ops visibility, kill-switch reconciliation).
```prisma
model Worker {
  id           String        @id @default(uuid())
  hostname     String
  pid          Int?
  status       String        @default("online")          // online|draining|offline
  capabilities Json?                                       // tool/sandbox capabilities
  activeJobs   Int           @default(0)
  sandboxSessionId String?
  sandboxStatus SandboxStatus?
  lastHeartbeatAt DateTime    @default(now())
  startedAt    DateTime      @default(now())
  @@index([status])
  @@map("workers")
}
```

### 13.2 `queue_jobs` — **MVP P2**
Postgres-side mirror of BullMQ jobs (system of record is Postgres; Redis is the coordinator — §6.10). Enables resume-from-state after a Redis loss.
```prisma
model QueueJob {
  id          String    @id @default(uuid())
  workspaceId String?
  taskId      String?
  queueName   String                                      // agent-run|artifact|deploy|scheduled
  bullJobId   String?   @unique                            // BullMQ job id
  status      JobStatus @default(queued)
  attempts    Int       @default(0)
  maxAttempts Int       @default(3)
  payload     Json?                                         // masked
  lastError   String?
  priority    Int       @default(0)
  scheduledFor DateTime?
  startedAt   DateTime?
  finishedAt  DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  @@index([queueName, status])
  @@index([taskId])
  @@map("queue_jobs")
}
```

---

## 14. Collaboration — **LATER P7**

### 14.1 `collaboration_sessions`
Live shared viewing/editing of a task workspace (presence, comments).
```prisma
model CollaborationSession {
  id          String   @id @default(uuid())
  workspaceId String
  taskId      String?
  projectId   String?
  hostUserId  String
  status      String   @default("active")                  // active|ended
  startedAt   DateTime @default(now())
  endedAt     DateTime?
  collaborators Collaborator[]
  @@index([workspaceId])
  @@map("collaboration_sessions")
}
```

### 14.2 `collaborators`
```prisma
model Collaborator {
  id           String     @id @default(uuid())
  sessionId    String
  userId       String
  role         MemberRole @default(viewer)                  // permission-scoped sharing
  presence     String     @default("offline")               // online|idle|offline
  lastSeenAt   DateTime?
  joinedAt     DateTime   @default(now())
  session      CollaborationSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@unique([sessionId, userId])
  @@map("collaborators")
}
```

---

## 15. Ingestion — **LATER P8**

### 15.1 `mail_tasks`
Inbound email → task, with sender allowlist + approval-before-execute (§C27).
```prisma
model MailTask {
  id          String   @id @default(uuid())
  workspaceId String
  fromAddress String
  toAddress   String                                        // inbound routing address
  subject     String?
  bodyRef     String?                                        // object-storage key (raw mail)
  allowlisted Boolean  @default(false)
  taskId      String?                                        // created task (if approved)
  status      String   @default("pending")                   // pending|approved|rejected|spam
  receivedAt  DateTime @default(now())
  @@index([workspaceId, status])
  @@index([fromAddress])
  @@map("mail_tasks")
}
```

### 15.2 `meeting_records`
Transcript ingestion → action items/tasks (consent-gated; on-device option).
```prisma
model MeetingRecord {
  id           String   @id @default(uuid())
  workspaceId  String
  title        String?
  source       String?                                       // upload|integration
  transcriptRef String?                                       // object-storage key
  consentGiven Boolean  @default(false)
  actionItems  Json?                                          // extracted items → tasks
  createdTaskIds Json?
  startedAt    DateTime?
  durationSec  Int?
  createdAt    DateTime @default(now())
  @@index([workspaceId])
  @@map("meeting_records")
}
```

---

## 16. Relationship map (summary)

```
users ─< workspace_members >─ workspaces ─< projects ─< project_members
                                   │            ├─< project_files >─ files
                                   │            └─< project_instructions
                                   ├─< tasks ─< task_steps ─< tool_calls
                                   │     ├─< task_logs            (append-only, partitioned)
                                   │     ├─< approvals
                                   │     ├─< artifacts ─< artifact_versions
                                   │     ├─< usage_records ─rollup→ cost_records
                                   │     └─< browser_sessions
                                   ├─< secrets ◄── api_keys / integrations / data_providers / workflow_triggers
                                   ├─< automations ─< automation_runs / workflow_triggers
                                   ├─< mcp_connectors / skills
                                   ├─< memory_items ─ vector_documents (pgvector)
                                   ├─< files ─< file_chunks (pgvector)
                                   ├─< collaboration_sessions ─< collaborators
                                   ├─< mail_tasks / meeting_records
                                   ├─< notifications / audit_logs (partitioned)
                                   └─ workers / queue_jobs (infra; loosely workspace-scoped)
```

## 17. Index & RLS summary (high-value)

| Table | Key indexes | RLS |
|---|---|---|
| `tasks` | `(workspace_id,status)`, `created_at`, partial active-run | workspace |
| `task_logs` | unique `(task_id,seq)`, `(task_id,created_at)`, monthly partition | workspace |
| `tool_calls` | unique `(task_id,call_id)`, `(workspace_id,tool_name)` | workspace |
| `file_chunks` | unique `(file_id,index)`, **HNSW `embedding`** | workspace |
| `vector_documents` | `(workspace_id,owner_type)`, **HNSW `embedding`** | workspace |
| `audit_logs` | `(workspace_id,created_at)`, `action`, monthly partition, hash chain | workspace |
| `usage_records` | `(workspace_id,created_at)`, `task_id`, monthly partition | workspace |
| `cost_records` | unique `(workspace_id,scope,task_id,user_id,period_month)` | workspace |
| `secrets` | `(workspace_id,type)` | workspace (strict; ciphertext never listed) |
| `workspace_members` | unique `(workspace_id,user_id)`, `user_id` | workspace |

---

## 18. Test scenarios & acceptance criteria (schema scope)

- **DB1 — migrate up/down clean.** `prisma migrate` apply then rollback on a fresh DB. **Accept:** schema matches this table list; rollback leaves no residue; CI gate (P1 criterion).
- **DB2 — tenancy isolation.** User in workspace A queries workspace B rows. **Accept:** app guard denies; RLS backstop returns zero rows even on a raw query (§7.7).
- **DB3 — secret at rest.** Store an LLM key via settings. **Accept:** row holds only ciphertext/iv/authTag/wrappedDataKey; `last_four` is the only renderable field; a DB dump yields no plaintext (§F1).
- **DB4 — vector KNN tenant-scoped.** Seed embeddings in two workspaces; run KNN. **Accept:** results never cross `workspace_id`; HNSW index used (EXPLAIN).
- **DB5 — replay determinism.** Re-read `task_logs` ordered by `(task_id, seq)`. **Accept:** reproduces the exact event stream (§B1).
- **DB6 — append-only audit.** Attempt `UPDATE`/`DELETE` on `audit_logs` via app role. **Accept:** denied; hash chain verifies on export.
- **DB7 — cost reconciliation.** Sum `usage_records` → compare `cost_records`. **Accept:** task/workspace/month totals reconcile within rounding (§Phase 2 criterion).
- **DB8 — partition rollover.** Insert across a month boundary. **Accept:** rows land in the correct monthly partition; next-month partition auto-exists.

---

*End of DATABASE.md — 38 listed tables (+ `approvals` supporting table). Later-phase tables tagged inline and in §2.*
