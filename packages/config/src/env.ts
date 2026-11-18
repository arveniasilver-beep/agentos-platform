import { z } from 'zod';

/**
 * Server-only environment schema. This module must NEVER be imported into a client bundle —
 * it is the boundary where secrets (added from Phase 1) are read. Validated at boot, fail-fast.
 */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(4000),

  // Cloud infrastructure — optional in Phase 0, used from Phase 1 onward.
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),

  // Object storage (S3 / R2 / MinIO) — bucket name is generic (no brand literal).
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('artifacts'),

  // Master key for envelope encryption (base64-encoded 32 bytes). Server-only.
  MASTER_ENCRYPTION_KEY: z.string().optional(),

  // Agent runtime. `mock` swaps in a scripted LLM provider so the engine runs without a key
  // (used by e2e/CI); `live` calls Anthropic with the workspace's stored key.
  LLM_MODE: z.enum(['live', 'mock']).default('live'),
  // Base folder under which each task gets an isolated, write-scoped sandbox directory.
  AGENT_SANDBOX_ROOT: z.string().optional(),
  // Task execution backbone. `inline` runs in-process right after the request (no Redis needed);
  // `queue` enqueues to BullMQ and a worker drains it (durable, retryable, survives restarts).
  EXECUTION_MODE: z.enum(['inline', 'queue']).default('inline'),
  // Headless-browser tools (Playwright). On by default; set to "false" to withhold them (e.g. on a
  // host without Chromium). They launch lazily, so tasks that never browse pay nothing.
  ENABLE_BROWSER_TOOLS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Sandboxed code execution (Docker container-per-task). Opt-in (requires a Docker daemon and runs
  // arbitrary code — high risk, approval-gated). Set ENABLE_SANDBOX=true to enable.
  ENABLE_SANDBOX: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  SANDBOX_IMAGE: z.string().default('alpine:3'),
  // "Persistent computer" (local, Manus-style): mount a per-workspace Docker named volume into the
  // sandbox at /persist so files/state survive BETWEEN tasks. OFF by default (each sandbox stays
  // throwaway). Requires ENABLE_SANDBOX. Uses a Docker-managed named volume — never a host path.
  ENABLE_PERSISTENT_WORKSPACE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // "My Computer": let the agent operate on user-APPROVED local folders on the host (read always,
  // write only for folders the user marked writable, and only above the risk ceiling = approval-gated).
  // OFF by default — enable ONLY for a local/desktop deployment where the API runs on the user's
  // machine; a cloud deployment must never expose host files.
  ENABLE_LOCAL_FS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // On boot, mark tasks left in a running state (orphaned by a prior process crash/restart) as
  // failed. On by default; set to "false" for multi-replica deployments (use a lease-based reaper).
  REAP_STALE_TASKS_ON_BOOT: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Durable resume (TICKET-002/003/004). OFF by default: when false, behavior is byte-identical to
  // today — no snapshots are written, lease columns are ignored, the boot reaper fails in-flight
  // tasks, and the engine never receives a resumeFrom. Set true ONLY to opt into crash-resume.
  RESUME_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Multi-turn follow-up (KEYSTONE): a completed/failed task accepts a new user message and CONTINUES the
  // SAME task as a fresh run resumed from the prior conversation. OFF by default: when false the follow-up
  // endpoint 404s, terminal task snapshots are deleted exactly as today, and a finished task is byte-
  // identical (one-shot). Requires the engine's durable snapshot to be preserved across terminal, so the
  // runner only keeps it when this is on. Independent of RESUME_ENABLED's crash-resume.
  FOLLOWUP_TURNS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Hard cap on follow-up turns per task (anti-runaway). Counts persisted user messages.
  FOLLOWUP_MAX_TURNS: z.coerce.number().int().positive().default(20),
  // Worker lease TTL (seconds): a running worker must heartbeat within this window or its task is
  // considered orphaned and may be re-claimed by another worker / the sweep.
  RESUME_LEASE_TTL_SEC: z.coerce.number().int().positive().default(60),
  // How often the running worker extends its lease (must be well under the TTL).
  RESUME_HEARTBEAT_SEC: z.coerce.number().int().positive().default(20),
  // How often a replica sweeps for tasks whose lease expired (crashed worker) to re-enqueue them.
  RESUME_SWEEP_SEC: z.coerce.number().int().positive().default(30),
  // Max times a task may be resumed before it is failed instead of re-enqueued (poison-task guard).
  RESUME_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Durable Artifact Persistence (TICKET-ART). OFF by default: when false, deliverables are served
  // straight from the task sandbox as today and no Artifact rows / blobs are written. Set true to
  // register produced files as durable, versioned, blob-backed Artifacts.
  ARTIFACT_PERSISTENCE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Durable blob store root for the local backend (used when object storage / S3 is not configured).
  // Must be OUTSIDE the throwaway task sandbox so artifacts survive sandbox teardown.
  ARTIFACT_STORE_ROOT: z.string().optional(),
  // Policy engine + approval hardening (TICKET-POLICY). OFF by default: when false, tool gating is the
  // legacy risk-ceiling/approvalRequired gate exactly as before — no capability enforcement, no policy
  // decisions, no enriched approval detail. Set true to enable the policy engine.
  POLICY_ENGINE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Comma-separated capability scopes granted to a run. Unset = ALL scopes granted (capability
  // enforcement is dormant but ACTIVE — a tool requiring a scope not in this set is denied).
  POLICY_GRANTED_SCOPES: z.string().optional(),
  // Per-task cap on consecutive/total policy-denied tool calls before the run is failed (anti deny-loop).
  POLICY_MAX_DENIALS: z.coerce.number().int().positive().default(3),
  // Per-task DEFAULT cost budget (USD) when neither the task DTO nor a project/workspace cap sets one.
  // 0 = no default (unbounded) — keep at 0 to preserve byte-identical legacy behaviour (COST-BUDGET).
  DEFAULT_TASK_COST_BUDGET_USD: z.coerce.number().nonnegative().default(0),
  // Token-aware compaction (COMPACTION): override the engine's compaction trigger budget (input tokens).
  // Unset = derive from the model registry's context window (≈0.6×) with a conservative fallback.
  COMPACT_AT_TOKENS: z.coerce.number().int().positive().optional(),
  // Elevated-approval model: auto = team rules when the workspace has >1 member, else owner break-glass;
  // team = always require a non-self admin/owner; personal = owner break-glass.
  POLICY_ELEVATED_APPROVAL_MODE: z.enum(['auto', 'team', 'personal']).default('auto'),
  // Allow the owner to self-approve an elevated action via break-glass (typed confirmation) in
  // single-user/personal mode. Default on so a solo user is never locked out; set false to forbid.
  POLICY_OWNER_BREAKGLASS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // What the policy decides for an http_fetch to a PUBLIC url (private/loopback/metadata are always
  // denied). 'allow' (net-guard still runs at execution) or 'require_approval'.
  POLICY_HTTP_PUBLIC_EFFECT: z.enum(['allow', 'require_approval']).default('allow'),
  // Coding Workspace / Agent Code Editing Runtime (TICKET-CODING). OFF by default: when false, the
  // coding tools (read_file/write_file/apply_patch/run_*/checkpoint/rollback) are NOT provisioned and
  // behavior is byte-identical to today. Set true to opt into agent code editing.
  CODING_WORKSPACE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Base folder for the SINGLE real coding workspace per (workspace, project): the same host directory
  // used by the edit tools AND bind-mounted into the Docker runner at /work, so edited === tested.
  // Must be OUTSIDE the throwaway task sandbox. Defaults to a folder under the OS temp dir.
  CODING_WORKSPACE_ROOT: z.string().optional(),
  // A file edit whose unified diff changes more than this many lines requires approval (large-diff gate).
  CODING_MAX_DIFF_LINES: z.coerce.number().int().positive().default(400),
  // Durable AutomationRun / Scheduled Tasks (TICKET-AUTOMATION). OFF by default: when false, automations
  // fire exactly as today (create a Task, update lastRunAt/lastTaskId) with NO run-history rows, NO
  // overlap-skip, NO retry — byte-identical. Set true to enable the durable AutomationRun layer.
  AUTOMATION_RUNS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Max run-level retries for a failed automation run before it becomes a terminal failure (anti-loop).
  AUTOMATION_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  // Base backoff (ms) before a run-level retry; multiplied by 2^attempt (exponential).
  AUTOMATION_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(60_000),
  // Project Memory / Context System (TICKET-MEMORY). OFF by default: when false, NO memory is retrieved
  // and the system prompt is byte-identical to today. Set true to retrieve relevant project memory at
  // task start and inject it (redacted, bounded, fenced as DATA) into the system prompt.
  PROJECT_MEMORY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Max memory entries retrieved + injected per task (keeps the context bounded).
  MEMORY_RETRIEVAL_TOPK: z.coerce.number().int().positive().max(50).default(8),
  // Hard char cap on the injected memory block (defense against context bloat).
  MEMORY_BLOCK_MAX_CHARS: z.coerce.number().int().positive().default(4000),
  // Browser Operator Hardening (TICKET-1). OFF by default: when false, NO durable browser session/action
  // tracking, NO web-content fencing, NO URL allow/deny policy, NO payment escalation — browser behavior
  // is byte-identical to today. Set true to durably track + audit + harden agent browser actions.
  BROWSER_OPERATOR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Optional comma-separated host allowlist; when set, the operator only permits navigation to these
  // hosts (suffix match). Empty = no allowlist constraint (SSRF guard still applies).
  BROWSER_URL_ALLOWLIST: z.string().optional().default(''),
  // Optional comma-separated host denylist; navigation to these hosts is blocked even if public.
  BROWSER_URL_DENYLIST: z.string().optional().default(''),
  // Tool Execution Hardening (TICKET-2). OFF by default: when false, tool execution is byte-identical
  // (input validation + timeout only). Set true to validate tool OUTPUT against its schema (controlled
  // tool_error on violation) and serve cached results for repeated idempotent calls (no duplicate
  // side-effects). Tool version is recorded in the trace either way (additive metadata).
  TOOL_EXEC_HARDENING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Sandbox Hardening (TICKET-3). OFF by default: when false, the sandbox container keeps today's
  // writable-root behavior (byte-identical). Set true for read-only rootfs + writable tmpfs scratch
  // (disk quota) + explicit OOM behavior, on top of the always-on caps-drop / no-new-privileges /
  // default-deny network / memory-CPU-PID limits.
  SANDBOX_HARDENING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Skills/Playbooks v2 (TICKET-4). OFF by default: when false, skill run uses the legacy {{input}}
  // template path (byte-identical). Set true for typed-param validation, versioning, and capability/
  // effort passthrough on skill execution.
  SKILLS_PLAYBOOKS_V2_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Device Sync Foundation (TICKET-5). OFF by default: when false, only the httpOnly session cookie
  // authenticates (byte-identical). Set true to also accept long-lived Bearer device tokens, so a
  // registered desktop/Android device can reach the same workspace-scoped APIs (consistent sync).
  DEVICE_SYNC_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Desktop Runner Foundation (TICKET-7). OFF by default: when false, NO desktop-runner registration/
  // heartbeat + NO per-device local-action audit — local-fs (ENABLE_LOCAL_FS) and device sync behave
  // byte-identical. Set true to register desktop runners + audit local actions (content/full-path-free).
  DESKTOP_RUNNER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Workflow Builder (TICKET-8). OFF by default: when false, NO workflow definitions/runs — single-step
  // automations behave byte-identical. Set true for multi-step workflows (steps + conditions + branching
  // + approvals + manual/webhook/schedule triggers).
  WORKFLOW_BUILDER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Connectors v2 (TICKET-9). OFF by default: when false, NO manifest scope-enforcement + NO connector
  // webhook ingestion — the existing OAuth connectors behave byte-identical. Set true for the connector
  // framework (manifest registry, capability-scope enforcement, secure webhook events, health).
  CONNECTORS_V2_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Model Router (TICKET-10). OFF by default: when false the LLM factory builds the single per-workspace
  // brain exactly as before (byte-identical). When true AND a workspace stored a model_route_config, the
  // factory builds a RoutingProvider (capability/effort-based selection across named profiles + fallback).
  MODEL_ROUTER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Comma-separated CORS origin allowlist for production (e.g. "https://app.example.com"). When
  // unset, the API reflects the request origin (convenient for local dev + the desktop shell).
  CORS_ORIGINS: z.string().optional(),
  // Max request body size in bytes (default 1 MiB) — caps oversized-payload abuse.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  // Brute-force protection on auth endpoints: max attempts per window, per IP. The controller-wide
  // limit covers register/me/logout; login is the brute-force target so it gets a tighter cap.
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(100),
  AUTH_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  // Per-IP rate limit on the public /v1 API (caps unauthenticated floods + basic key abuse).
  PUBLIC_API_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  // Max artifact download size in bytes (default 100 MiB) — bounds memory on download.
  MAX_ARTIFACT_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  // The API's externally-reachable origin, used to build OAuth redirect URIs
  // (<PUBLIC_API_BASE_URL>/connectors/<provider>/callback). Must match the OAuth app registration.
  PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:4000'),
  // The web app origin to redirect back to after an OAuth connect completes.
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Allow a workspace's chat "brain" baseUrl to be a private/loopback/LAN host (e.g. a local vLLM/
  // Ollama serving MiMo). Off by default (fails closed against SSRF/key-exfil to internal hosts);
  // set true ONLY when you intend to point the brain at a self-hosted local model server.
  ALLOW_LOCAL_BRAIN_URL: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Trust X-Forwarded-* so req.ip is the real client behind a reverse proxy/load balancer (needed for
  // correct per-IP rate limiting). Enable ONLY when actually behind a trusted proxy — otherwise the
  // header is client-spoofable.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Parse and validate the server environment. Throws a single readable error listing every
 * problem, so misconfiguration is caught at startup rather than at first use.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => ` - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }
  return parsed.data;
}
