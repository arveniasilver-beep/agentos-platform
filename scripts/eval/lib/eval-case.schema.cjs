/* EvalCase schema (TICKET-EVAL). Declarative, version-controlled eval cases live as JSON fixtures and
 * are validated against this Zod schema. No DB model, no migration — cases are test artifacts. */
const path = require('node:path');
const { createRequire } = require('node:module');

const apiRequire = createRequire(path.join(__dirname, '..', '..', '..', 'services', 'api', 'package.json'));
const { z } = apiRequire('zod');

const RISK = z.enum(['low', 'medium', 'high', 'critical']);
const EFFECT = z.enum(['allow', 'require_approval', 'require_elevated_approval', 'deny']);

const toolCallSchema = z.object({ name: z.string(), input: z.unknown().optional() });
const scriptStepSchema = z.object({
  text: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  stopReason: z.string().optional(),
});
const toolDefSchema = z.object({
  name: z.string(),
  riskLevel: RISK.default('low'),
  approvalRequired: z.boolean().default(false),
  permissions: z.array(z.string()).default([]),
});

const expectSchema = z
  .object({
    status: z.enum(['completed', 'failed', 'stopped']).optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    toolsCalled: z.array(z.string()).optional(),
    toolsNotCalled: z.array(z.string()).optional(),
    toolRan: z.record(z.boolean()).optional(),
    policy: z.array(z.object({ tool: z.string(), effect: EFFECT })).optional(),
    auditActionsInclude: z.array(z.string()).optional(),
    artifacts: z
      .object({
        minCount: z.number().int().nonnegative().optional(),
        artifactIdsFilled: z.boolean().optional(),
        sha256Valid: z.boolean().optional(),
      })
      .optional(),
    cost: z.object({ baselineKey: z.string(), tolerancePct: z.number().default(5) }).optional(),
    approvalDetail: z.object({ hasFields: z.array(z.string()) }).optional(),
    noSecretLeak: z.array(z.string()).optional(),
    genCase: z
      .object({ needsReview: z.boolean().optional(), schemaValid: z.boolean().optional(), finalStatusCaptured: z.boolean().optional() })
      .optional(),
  })
  .default({});

const evalCaseSchema = z.object({
  id: z.string().min(1),
  category: z.enum(['tool-use', 'policy', 'artifact', 'resume', 'cost', 'security', 'meta', 'automation', 'memory', 'browser', 'tool-exec', 'sandbox', 'skill', 'device', 'desktop', 'workflow', 'connector', 'model-router']),
  description: z.string(),
  kind: z.enum(['run', 'resume', 'gencase', 'automation', 'memory', 'browser', 'tool-exec', 'sandbox', 'skill', 'device', 'desktop', 'workflow', 'connector', 'model-router']).default('run'),
  // Process-local env overrides applied for THIS case only, then restored. Never product config.
  env: z.record(z.string()).default({}),
  task: z
    .object({
      prompt: z.string().default('eval task'),
      riskCeiling: RISK.default('high'),
      stepBudget: z.number().int().positive().default(12),
      costBudgetUsd: z.number().nullable().default(null),
    })
    .default({}),
  toolset: z.enum(['stub', 'deliverable', 'coding']).default('stub'),
  tools: z.array(toolDefSchema).default([]),
  script: z.array(scriptStepSchema).default([]),
  approvals: z.object({ autoDecision: z.enum(['approve', 'deny']).nullable().default(null) }).default({}),
  // resume cases: a short script the engine runs AFTER resuming from the captured snapshot.
  resume: z.object({ scriptAfterResume: z.array(scriptStepSchema).default([]) }).optional(),
  // gencase cases: a synthetic failed-task seed (incl. a secret) the generator must redact.
  gencase: z
    .object({ seedSecret: z.string().optional(), seedScript: z.array(z.record(z.unknown())).default([]), seedStatus: z.string().default('failed') })
    .optional(),
  // automation cases (TICKET-AUTOMATION): exercise the durable AutomationRun layer deterministically
  // (real DB + TaskRunner, no BullMQ). 'success' = one-time run completes; 'overlap' = second fire skipped.
  automation: z.object({ scenario: z.enum(['success', 'overlap']).default('success') }).optional(),
  // memory cases (TICKET-MEMORY): exercise Project Memory store + deterministic retrieval + safe
  // injection (real DB, no embeddings). retrieved | injection-safety | cross-workspace.
  memory: z
    .object({ scenario: z.enum(['retrieved', 'injection-safety', 'cross-workspace']).default('retrieved'), seedContent: z.string().optional(), seedKind: z.string().optional(), prompt: z.string().optional() })
    .optional(),
  // browser cases (TICKET-1): exercise the Browser Operator hardening (classification, content fencing,
  // durable session isolation) deterministically (real DB, no Playwright).
  browser: z
    .object({ scenario: z.enum(['readonly-allowed', 'payment-elevated', 'content-fenced', 'cross-workspace']).default('readonly-allowed') })
    .optional(),
  // tool-exec cases (TICKET-2): exercise the ToolRegistryExecutor hardening (output validation,
  // idempotency cache) deterministically — pure, no DB.
  toolExec: z.object({ scenario: z.enum(['output-validation', 'idempotency']).default('output-validation') }).optional(),
  // sandbox cases (TICKET-3): assert the container HostConfig hardening deterministically (no Docker).
  sandbox: z.object({ scenario: z.enum(['hardened-config', 'flag-off-unchanged']).default('hardened-config') }).optional(),
  // skill cases (TICKET-4): typed-param validation + rendering — pure, deterministic.
  skill: z.object({ scenario: z.enum(['params-valid', 'params-invalid']).default('params-valid') }).optional(),
  // device cases (TICKET-5): device lifecycle + sync snapshot minimality — real DB.
  device: z.object({ scenario: z.enum(['register-resolve-revoke', 'snapshot-minimal', 'snapshot-consistency', 'revoked-blocked']).default('register-resolve-revoke') }).optional(),
  // desktop cases (TICKET-7): runner lifecycle + content/full-path-free local-action audit + path safety.
  desktop: z.object({ scenario: z.enum(['register-revoked', 'local-audit-safe', 'path-traversal']).default('register-revoked') }).optional(),
  // workflow cases (TICKET-8): multi-step drive (task->condition->task->end) + invalid/webhook security.
  workflow: z.object({ scenario: z.enum(['multistep', 'invalid-webhook']).default('multistep') }).optional(),
  // connector cases (TICKET-9): manifest validation + capability-scope enforcement — pure registry.
  connector: z.object({ scenario: z.enum(['scope-enforced', 'manifest-valid']).default('scope-enforced') }).optional(),
  // model-router cases (TICKET-10): effort/capability route selection + provider fallback — pure.
  modelRouter: z.object({ scenario: z.enum(['effort-routing', 'fallback']).default('effort-routing') }).optional(),
  expect: expectSchema,
  // documentation / generated-fixture metadata (kept, not asserted unless referenced).
  needsReview: z.boolean().optional(),
  sourceTaskId: z.string().optional(),
  notes: z.string().optional(),
});

function validateCase(raw) {
  return evalCaseSchema.parse(raw);
}

module.exports = { evalCaseSchema, validateCase };
