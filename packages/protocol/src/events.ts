import { z } from 'zod';
import { riskLevelSchema } from './risk';

/**
 * The agent event ABI: the append-only stream the backend emits and the client renders.
 * Every event is Zod-validated; the same schemas produce the runtime validators and the
 * inferred TypeScript types consumed by both the gateway and the UI.
 */

/** Task lifecycle states (mirrors the engine state machine). */
export const taskStateSchema = z.enum([
  'created',
  'planning',
  'waiting_for_approval',
  'running',
  'paused',
  'retrying',
  'failed',
  'completed',
  'cancelled',
]);
export type TaskState = z.infer<typeof taskStateSchema>;

/** Fields present on every streamed event. `seq` orders events for deterministic replay. */
const base = {
  taskId: z.string().min(1),
  seq: z.number().int().nonnegative(),
};

export const planStepStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);
export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

export const planStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  /** Live status, updated by the agent via the update_plan tool (default pending). */
  status: planStepStatusSchema.default('pending'),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const planEventSchema = z.object({
  type: z.literal('plan'),
  ...base,
  summary: z.string(),
  steps: z.array(planStepSchema).min(1),
});

export const stepStartedEventSchema = z.object({
  type: z.literal('step_started'),
  ...base,
  stepId: z.string().min(1),
});

export const stepCompletedEventSchema = z.object({
  type: z.literal('step_completed'),
  ...base,
  stepId: z.string().min(1),
  ok: z.boolean(),
});

export const toolCallEventSchema = z.object({
  type: z.literal('tool_call'),
  ...base,
  callId: z.string().min(1),
  tool: z.string().min(1),
  riskLevel: riskLevelSchema,
  input: z.unknown(),
  // Tool implementation version (TICKET-2) — additive + optional, so older events stay valid.
  toolVersion: z.string().optional(),
});

export const toolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  ...base,
  callId: z.string().min(1),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export const messageEventSchema = z.object({
  type: z.literal('message'),
  ...base,
  role: z.enum(['assistant', 'system']),
  text: z.string(),
});

/** Policy engine decision effect (TICKET-POLICY). Severity: allow < require_approval <
 * require_elevated_approval < deny. */
export const POLICY_EFFECTS = ['allow', 'require_approval', 'require_elevated_approval', 'deny'] as const;
export const policyEffectSchema = z.enum(POLICY_EFFECTS);
export type PolicyEffect = z.infer<typeof policyEffectSchema>;

/** Structured, SECRET-REDACTED detail of the operation a user is approving. All free-text fields are
 * redacted server-side before this is emitted. Additive: present only when the policy engine is on. */
export const approvalDetailSchema = z.object({
  tool: z.string(),
  requestedScopes: z.array(z.string()).default([]),
  riskReason: z.string().default(''),
  elevated: z.boolean().default(false),
  command: z.string().optional(),
  filePath: z.string().optional(),
  fileAction: z.string().optional(),
  diffPreview: z.string().optional(),
  url: z.string().optional(),
  httpMethod: z.string().optional(),
  browserAction: z.string().optional(),
  formTarget: z.string().optional(),
});
export type ApprovalDetail = z.infer<typeof approvalDetailSchema>;

export const approvalRequestEventSchema = z.object({
  type: z.literal('approval_request'),
  ...base,
  approvalId: z.string().min(1),
  riskLevel: riskLevelSchema,
  action: z.string().min(1),
  reason: z.string().default(''),
  /** Policy engine detail (optional; present only when POLICY_ENGINE_ENABLED). */
  detail: approvalDetailSchema.optional(),
});

export const costEstimateEventSchema = z.object({
  type: z.literal('cost_estimate'),
  ...base,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
  overThreshold: z.boolean(),
});

export const errorEventSchema = z.object({
  type: z.literal('error'),
  ...base,
  message: z.string(),
  recoverable: z.boolean().default(false),
});

export const stoppedEventSchema = z.object({
  type: z.literal('stopped'),
  ...base,
  reason: z.string().default('user_requested'),
});

export const statusEventSchema = z.object({
  type: z.literal('status'),
  ...base,
  state: taskStateSchema,
});

export const finalOutputEventSchema = z.object({
  type: z.literal('final_output'),
  ...base,
  summary: z.string(),
  artifactIds: z.array(z.string()).default([]),
});

/** The discriminated union of every server->client event. */
export const agentEventSchema = z.discriminatedUnion('type', [
  planEventSchema,
  stepStartedEventSchema,
  stepCompletedEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  messageEventSchema,
  approvalRequestEventSchema,
  costEstimateEventSchema,
  errorEventSchema,
  stoppedEventSchema,
  statusEventSchema,
  finalOutputEventSchema,
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];

/* ---------------------------------------------------------------------------------------- */
/* Client -> server control messages                                                         */
/* ---------------------------------------------------------------------------------------- */

export const submitTaskMessageSchema = z.object({
  type: z.literal('submit_task'),
  prompt: z.string().min(1),
  projectId: z.string().optional(),
});

export const approveMessageSchema = z.object({
  type: z.literal('approve'),
  taskId: z.string().min(1),
  approvalId: z.string().min(1),
});

export const denyMessageSchema = z.object({
  type: z.literal('deny'),
  taskId: z.string().min(1),
  approvalId: z.string().min(1),
  reason: z.string().optional(),
});

export const stopMessageSchema = z.object({
  type: z.literal('stop'),
  taskId: z.string().min(1),
});

/** Manual take-over of the live browser: the user clicks/types in the live view, and the input is
 * dispatched to the agent's browser page. Coordinates are FRACTIONS (0..1) of the frame so they map
 * regardless of display size. */
export const browserInputMessageSchema = z.object({
  type: z.literal('browser_input'),
  taskId: z.string().min(1),
  kind: z.enum(['click', 'type', 'key']),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  text: z.string().max(4000).optional(),
  key: z.string().max(40).optional(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  submitTaskMessageSchema,
  approveMessageSchema,
  denyMessageSchema,
  stopMessageSchema,
  browserInputMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

/* ---------------------------------------------------------------------------------------- */
/* Socket.IO typed event maps (consumed by the Nest gateway and the client)                  */
/* ---------------------------------------------------------------------------------------- */

export interface ServerToClientEvents {
  agent_event: (event: AgentEvent) => void;
  /** Live browser screencast frame (base64 JPEG) — transient, not part of the persisted event log. */
  browser_frame: (jpegBase64: string) => void;
}

export interface ClientToServerEvents {
  client_message: (
    message: ClientMessage,
    ack?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
}
