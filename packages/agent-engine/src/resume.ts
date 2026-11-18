import type { AgentEvent } from '@agentos/protocol';
import type { LlmMessage } from '@agentos/llm';
import type { RunUsage } from './engine';

/**
 * Durable resume (TICKET-002). The serializable engine state needed to continue a crashed run.
 *
 * Design: resume granularity is the STEP BOUNDARY. The authoritative source is the periodic
 * SNAPSHOT (TICKET-003) the engine serializes at each boundary — it holds the real conversation
 * `messages[]` (with the provider's own tool_use ids), exact usage, and counters. This pure
 * `reduceEvents` reducer is the EVENT-SOURCED foundation: it folds the append-only TaskLog into the
 * same shape. It is used (a) as the fallback when no snapshot exists yet (a crash before the first
 * step boundary — i.e. during planning or step 0, where the correct resume is simply to restart at
 * step 0 with `messages = [prompt]`), and (b) to derive the seq + callId/approvalId counter cursor
 * that is overlaid onto a loaded snapshot so newly-emitted ids never collide with ids already
 * persisted by a partial (post-snapshot) step. The reducer is pure and deterministic.
 *
 * What the reducer CANNOT recover from events alone (and why it does not need to): the original
 * prompt is not an event (it is passed in); cache token classes are not in cost_estimate (so the
 * fallback reports them as 0 — a cosmetic under-count only; the snapshot path is exact); and mid-run
 * tool-turn messages are intentionally NOT reconstructed — resume always restarts at a step
 * boundary, so any completed step's messages live in the snapshot and any interrupted step is
 * re-run from its model call.
 */
export interface ResumableState {
  /** Schema version of this serialized shape. */
  v: number;
  /** Next event seq the engine should emit (monotonic; = last persisted seq + 1). */
  seq: number;
  /** Next act-loop step index to run. */
  step: number;
  /** Whether the planning phase already completed (skip re-planning on resume). */
  planned: boolean;
  /** Reconstructed conversation history fed back into the act loop. */
  messages: LlmMessage[];
  /** Rolling compaction summary (empty unless a compaction ran). */
  runningSummary: string;
  /** Cumulative token/cost usage so far. */
  usage: RunUsage;
  /** Next callId index (callId = `${taskId}-c${callCounter}`). */
  callCounter: number;
  /** Next approvalId index (approvalId = `${taskId}-a${approvalCounter}`). */
  approvalCounter: number;
  /** Successful tool executions so far. */
  toolCallCount: number;
  /** Failed tool executions so far (counts toward maxToolErrors). */
  toolErrors: number;
}

export const RESUMABLE_STATE_VERSION = 1;

/** Parse the trailing integer of an id like `${taskId}-c12` or `${taskId}-a3`; -1 if it doesn't match. */
function trailingIndex(id: string, sep: string): number {
  const i = id.lastIndexOf(sep);
  if (i < 0) return -1;
  const n = Number(id.slice(i + sep.length));
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/** Counters derived purely from the event log: the next seq and the next callId/approvalId indices.
 * Used both standalone (to overlay onto a snapshot) and inside `reduceEvents`. */
export function deriveCursors(events: AgentEvent[]): {
  seq: number;
  callCounter: number;
  approvalCounter: number;
} {
  let lastSeq = -1;
  let maxCall = -1;
  let maxApproval = -1;
  for (const e of events) {
    if (e.seq > lastSeq) lastSeq = e.seq;
    if (e.type === 'tool_call') maxCall = Math.max(maxCall, trailingIndex(e.callId, '-c'));
    if (e.type === 'approval_request') maxApproval = Math.max(maxApproval, trailingIndex(e.approvalId, '-a'));
  }
  return { seq: lastSeq + 1, callCounter: maxCall + 1, approvalCounter: maxApproval + 1 };
}

/**
 * Fold the append-only TaskLog into a ResumableState (no-snapshot fallback). Pure + deterministic:
 * the same (events, prompt) always yields the same state, and ordering is normalized by seq.
 */
export function reduceEvents(events: AgentEvent[], prompt: string): ResumableState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  const usage: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  let planned = false;
  let toolCallCount = 0;
  let toolErrors = 0;

  for (const e of ordered) {
    switch (e.type) {
      case 'plan':
        planned = true;
        break;
      case 'status':
        // Reaching running / waiting_for_approval / a terminal state means planning is done.
        if (e.state !== 'created' && e.state !== 'planning') planned = true;
        break;
      case 'cost_estimate':
        // The latest cumulative meter wins (events are seq-ordered). cache classes aren't in the
        // event, so the fallback leaves them at 0 (snapshot path carries the exact values).
        usage.inputTokens = e.inputTokens;
        usage.outputTokens = e.outputTokens;
        usage.costUsd = e.estimatedUsd;
        break;
      case 'tool_result':
        if (e.ok) toolCallCount += 1;
        else toolErrors += 1;
        break;
      default:
        break;
    }
  }

  const cursors = deriveCursors(ordered);
  return {
    v: RESUMABLE_STATE_VERSION,
    seq: cursors.seq,
    // No snapshot ⇒ we are before the first completed step boundary ⇒ restart at step 0 with the
    // raw prompt; the (uncompleted) interrupted step is re-run from its model call.
    step: 0,
    planned,
    messages: [{ role: 'user', content: prompt }],
    runningSummary: '',
    usage,
    callCounter: cursors.callCounter,
    approvalCounter: cursors.approvalCounter,
    toolCallCount,
    toolErrors,
  };
}
