import type { AgentEvent, ApprovalDetail, PlanStep, RiskLevel, TaskState } from '@agentos/protocol';

/** A tool invocation folded from its tool_call + tool_result events. */
export interface ToolCallView {
  callId: string;
  tool: string;
  riskLevel: RiskLevel;
  input: unknown;
  status: 'running' | 'ok' | 'error';
  output?: unknown;
  error?: string;
}

/** A pending or resolved approval request. */
export interface ApprovalView {
  approvalId: string;
  action: string;
  riskLevel: RiskLevel;
  reason: string;
  resolved: boolean;
  /** Policy engine (TICKET-POLICY): redacted operation detail + whether it needs an elevated approval. */
  detail?: ApprovalDetail;
  elevated: boolean;
}

export interface MessageView {
  seq: number;
  role: 'assistant' | 'system';
  text: string;
}

export interface CostView {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  overThreshold: boolean;
}

/** The full UI model derived purely from the event stream — deterministic and replayable. */
export interface TaskView {
  status: TaskState | null;
  planSummary: string;
  planSteps: PlanStep[];
  messages: MessageView[];
  toolCalls: ToolCallView[];
  approvals: ApprovalView[];
  cost: CostView | null;
  finalOutput: string | null;
  /** Durable artifact ids from the final_output event (TICKET-ART) — empty unless any were produced. */
  artifactIds: string[];
  stoppedReason: string | null;
  errors: string[];
  /** Highest event seq applied — lets the reducer ignore re-delivered events on reconnect. */
  lastSeq: number;
}

export function emptyTaskView(): TaskView {
  return {
    status: null,
    planSummary: '',
    planSteps: [],
    messages: [],
    toolCalls: [],
    approvals: [],
    cost: null,
    finalOutput: null,
    artifactIds: [],
    stoppedReason: null,
    errors: [],
    lastSeq: -1,
  };
}

/**
 * Fold a single event into the view (immutably). Events are globally seq-ordered per task, so any
 * event whose seq was already applied is ignored — this makes a Socket.IO reconnect (which replays
 * the whole backlog from seq 0) idempotent instead of duplicating messages / reopening approvals.
 */
export function applyEvent(view: TaskView, event: AgentEvent): TaskView {
  if (event.seq <= view.lastSeq) return view; // already applied (reconnect replay)
  const v: TaskView = { ...view, lastSeq: event.seq };
  switch (event.type) {
    case 'status':
      return { ...v, status: event.state };
    case 'plan':
      return { ...v, planSummary: event.summary, planSteps: event.steps };
    case 'message':
      return {
        ...v,
        messages: [...v.messages, { seq: event.seq, role: event.role, text: event.text }],
      };
    case 'tool_call':
      return {
        ...v,
        toolCalls: [
          ...v.toolCalls,
          {
            callId: event.callId,
            tool: event.tool,
            riskLevel: event.riskLevel,
            input: event.input,
            status: 'running',
          },
        ],
      };
    case 'tool_result':
      return {
        ...v,
        toolCalls: v.toolCalls.map((tc) =>
          tc.callId === event.callId
            ? { ...tc, status: event.ok ? 'ok' : 'error', output: event.output, error: event.error }
            : tc,
        ),
      };
    case 'approval_request':
      return {
        ...v,
        approvals: [
          ...v.approvals,
          {
            approvalId: event.approvalId,
            action: event.action,
            riskLevel: event.riskLevel,
            reason: event.reason,
            resolved: false,
            ...(event.detail ? { detail: event.detail } : {}),
            elevated: event.detail?.elevated ?? false,
          },
        ],
      };
    case 'cost_estimate':
      return {
        ...v,
        cost: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedUsd: event.estimatedUsd,
          overThreshold: event.overThreshold,
        },
      };
    case 'final_output':
      return { ...v, finalOutput: event.summary, artifactIds: event.artifactIds ?? [] };
    case 'stopped':
      return { ...v, stoppedReason: event.reason };
    case 'error':
      return { ...v, errors: [...v.errors, event.message] };
    default:
      return v;
  }
}

/** Mark an approval resolved once the user has decided (optimistic UI). */
export function resolveApproval(view: TaskView, approvalId: string): TaskView {
  return {
    ...view,
    approvals: view.approvals.map((a) => (a.approvalId === approvalId ? { ...a, resolved: true } : a)),
  };
}

/** Fold a whole (ordered) event list into a view. Ignores out-of-union payloads defensively. */
export function reduceEvents(events: AgentEvent[]): TaskView {
  return events.reduce(applyEvent, emptyTaskView());
}
