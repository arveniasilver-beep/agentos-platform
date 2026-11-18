import {
  RISK_ORDER,
  requiresApproval,
  type AgentEvent,
  type ApprovalDetail,
  type PolicyEffect,
  type RiskLevel,
  type TaskState as WireTaskState,
} from '@agentos/protocol';
import type {
  LlmProvider,
  LlmContentBlock,
  LlmMessage,
  LlmResponse,
  LlmToolDef,
  LlmUsage,
} from '@agentos/llm';
import { getModel } from '@agentos/llm';
import { RunController } from './controller';
import type { ToolExecutor } from './tool-runtime';
import { parsePlanSteps } from './plan';
import { RESUMABLE_STATE_VERSION, type ResumableState } from './resume';

/** Engine-internal lifecycle (richer than the wire state). */
export type EngineState = 'completed' | 'failed' | 'stopped';

const PLAN_SYSTEM =
  'You are an autonomous task-planning agent. Produce a short, numbered plan (3-6 steps) to ' +
  'accomplish the user task. Output only the plan as a numbered list.';

/** Nudge (appended to whatever system prompt a run uses) telling the agent to keep its plan live. */
export const PLAN_TRACKING_NUDGE =
  'You have an update_plan tool. Early in the task, call it once with your full checklist of steps ' +
  '(each pending). As you work, call it again to mark the current step in_progress and finished steps ' +
  'completed (or failed). Keep the checklist accurate so the user can follow your progress.';

const DEFAULT_SYSTEM =
  "You are an autonomous agent. Use the available tools to accomplish the user's task. Call a " +
  'tool when you need it; when the task is complete, respond with the final answer and stop.\n\n' +
  PLAN_TRACKING_NUDGE;

/** Built-in tool name the engine handles directly (not delegated to the tool executor). */
const UPDATE_PLAN_TOOL = 'update_plan';

const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;

/** Cap a tool output before it enters the model history, so big outputs don't overflow the context
 * window over a long task. The UI still receives the full output separately. */
const MAX_TOOL_RESULT_HISTORY_CHARS = 8000;
function capForHistory(output: unknown): string {
  const s = JSON.stringify(output ?? null);
  if (s.length <= MAX_TOOL_RESULT_HISTORY_CHARS) return s;
  return (
    s.slice(0, MAX_TOOL_RESULT_HISTORY_CHARS) +
    `…[truncated ${s.length - MAX_TOOL_RESULT_HISTORY_CHARS} chars — full output is shown in the UI]`
  );
}

// Context compaction: on a long task the message history grows unbounded and eventually overflows the
// model's context window. The PRIMARY trigger is token-aware — the last prompt's REAL input tokens vs a
// budget derived from the model's context window (≈0.6×window). COMPACT_AT_MESSAGES stays as a coarse
// FAILSAFE so a huge resumed history (where lastInputTokens starts at 0) still compacts, and so a model
// whose window we don't know is still bounded. When triggered, the oldest turns (everything except the
// task prompt and the most recent COMPACT_KEEP_RECENT messages) are summarized into a compact note folded
// into the prompt — so the agent keeps the thread without re-sending every step.
const COMPACT_AT_MESSAGES = 40;
const COMPACT_KEEP_RECENT = 14;
const COMPACT_CONTEXT_FRACTION = 0.6; // compact once the prompt passes ~60% of the context window
const COMPACT_AT_TOKENS_FALLBACK = 76_800; // ≈0.6 × a conservative 128k when the window is unknown

/** Conservative pre-call estimate of the CURRENT prompt's token count (chars / 4). Used as a PROACTIVE
 * compaction guard: the reactive lastInputTokens reflects the PREVIOUS request, so a single huge tool_result
 * appended this turn would otherwise overflow the NEXT call before the reactive trigger ever sees it. No
 * provider call — just measures the message bytes we are about to send. */
function approxPromptTokens(messages: LlmMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

/** Flatten a span of messages into a plain-text transcript for the summarizer (bounded). */
function renderForSummary(messages: LlmMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      parts.push(`${m.role.toUpperCase()}: ${m.content}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') {
        if (b.text.trim()) parts.push(`${m.role.toUpperCase()}: ${b.text}`);
      } else if (b.type === 'tool_use') {
        parts.push(`TOOL_CALL ${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 400)})`);
      } else {
        parts.push(`TOOL_RESULT${b.isError ? ' (error)' : ''}: ${b.content.slice(0, 800)}`);
      }
    }
  }
  return parts.join('\n').slice(0, 24_000);
}

/** The model-facing schema for the built-in update_plan tool. */
const UPDATE_PLAN_TOOL_DEF = {
  name: UPDATE_PLAN_TOOL,
  description:
    'Maintain a live checklist of your plan so the user can follow progress. Pass the FULL ordered ' +
    'list of steps each time, setting each step\'s status. Call it early with all steps pending, then ' +
    'again as you advance to mark steps in_progress/completed/failed.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short step label.' },
            status: { type: 'string', enum: [...PLAN_STEP_STATUSES] },
          },
          required: ['title', 'status'],
        },
      },
      summary: { type: 'string', description: 'Optional one-line summary of the overall plan.' },
    },
    required: ['steps'],
  },
} as const;

interface UpdatePlanInput {
  steps: { title: string; status: string }[];
  summary?: string;
}

/** Validate + normalize an update_plan tool input; returns null if it is malformed. */
function parseUpdatePlan(input: unknown): { summary: string; steps: { id: string; title: string; description: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }[] } | null {
  const obj = input as UpdatePlanInput | null;
  if (!obj || !Array.isArray(obj.steps) || obj.steps.length === 0) return null;
  const steps = obj.steps.slice(0, 30).map((s, i) => {
    const status = (PLAN_STEP_STATUSES as readonly string[]).includes(s?.status)
      ? (s.status as 'pending' | 'in_progress' | 'completed' | 'failed')
      : 'pending';
    const title = typeof s?.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 200) : `Step ${i + 1}`;
    return { id: `s${i + 1}`, title, description: '', status };
  });
  const summary = typeof obj.summary === 'string' ? obj.summary.slice(0, 500) : 'Plan';
  return { summary, steps };
}

export interface RunBudgets {
  maxSteps: number;
  maxCostUsd?: number;
  maxToolErrors: number;
  /** Anti deny-loop: max policy-denied tool calls before the run is failed (TICKET-POLICY). */
  maxPolicyDenials: number;
}

const DEFAULT_BUDGETS: RunBudgets = { maxSteps: 12, maxToolErrors: 4, maxPolicyDenials: 3 };

/** Policy decision plumbing (TICKET-POLICY). The engine stays decoupled from the policy service — it
 * only calls this optional callback and merges the result with its own legacy gate. */
export interface EnginePolicyCall {
  tool: string;
  riskLevel: RiskLevel;
  permissions: string[];
  input: unknown;
}
export interface EnginePolicyDecision {
  effect: PolicyEffect;
  reason: string;
  detail?: ApprovalDetail;
}

const POLICY_SEVERITY: Record<PolicyEffect, number> = {
  allow: 0,
  require_approval: 1,
  require_elevated_approval: 2,
  deny: 3,
};
/** Combine two effects, returning the MORE restrictive — so policy never relaxes the legacy gate. */
function mostRestrictive(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
  return POLICY_SEVERITY[a] >= POLICY_SEVERITY[b] ? a : b;
}

export interface RunInput {
  taskId: string;
  prompt: string;
  provider: LlmProvider;
  tools: ToolExecutor;
  controller: RunController;
  emit: (event: AgentEvent) => void | Promise<void>;
  system?: string;
  budgets?: Partial<RunBudgets>;
  /** Tools with risk above this auto-require approval (default 'medium'). */
  riskCeiling?: RiskLevel;
  /** Skip the planning phase and go straight to the act loop (e.g. chat / single-turn modes). */
  skipPlanning?: boolean;
  /** Always-on preamble (personalization) prepended to the act-loop system prompt. */
  systemPrefix?: string;
  /** Reasoning effort tier passed to the provider on every model turn (default provider 'high'). */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Task capability mode (slides|document|website|chart|image|chat|…) passed to the provider on every
   * model turn so the Model Router can route to a capability-appropriate profile. Advisory; ignored by
   * single-provider setups. */
  capability?: string;
  /** Durable resume (TICKET-002): continue a crashed run from a prior snapshot / reduced state
   * instead of starting fresh. When omitted, the run starts normally (byte-identical to before). */
  resumeFrom?: ResumableState;
  /** Durable resume (TICKET-003): invoked at each step boundary with the serializable engine state
   * so the caller can persist a snapshot. Best-effort; the engine ignores what it returns/throws is
   * the caller's concern. When omitted, no snapshots are taken (default). */
  checkpoint?: (state: ResumableState) => void | Promise<void>;
  /** Policy engine (TICKET-POLICY): consulted before each tool call; its decision is merged with the
   * legacy gate, taking the MORE restrictive. When omitted, only the legacy gate applies (unchanged). */
  policy?: (call: EnginePolicyCall) => Promise<EnginePolicyDecision>;
  /** Token-aware compaction (COMPACTION): override the compaction trigger budget (input tokens). When
   * omitted, it is derived from the model registry's context window (≈0.6×) with a conservative fallback.
   * The caller wires an env override (e.g. COMPACT_AT_TOKENS) here so the engine stays env-free. */
  compactAtTokens?: number;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Per-model usage breakdown (COST-ATTRIBUTION): keyed by the model that ACTUALLY answered each call, so a
 * routed/multi-model run attributes cost to the right model instead of the default routing profile. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  calls: number;
}

export interface RunResult {
  state: EngineState;
  finalText: string;
  usage: RunUsage;
  steps: number;
  toolCalls: number;
  /** Per-answering-model usage. Present ONLY when the run spanned >1 distinct model (a routed run), so a
   * single-provider run stays byte-identical (field absent). For a resumed run it covers the post-resume
   * segment; the full-run resume carry-over is the deferred resume-v2 piece. */
  usageByModel?: Record<string, ModelUsage>;
}

// Distributes Omit over the AgentEvent union so each variant keeps its own fields.
// (Distribution requires a naked type PARAMETER — a bare `AgentEvent extends ...` would not distribute.)
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventInput = DistributiveOmit<AgentEvent, 'taskId' | 'seq'>;

export class AgentEngine {
  async run(input: RunInput): Promise<RunResult> {
    const { taskId, prompt, provider, tools, controller } = input;
    const budgets: RunBudgets = { ...DEFAULT_BUDGETS, ...input.budgets };
    const riskCeiling: RiskLevel = input.riskCeiling ?? 'medium';
    const baseSystem = input.system ?? DEFAULT_SYSTEM;
    // Personalization preamble (if any) is prepended to BOTH the planning and act-loop system prompts
    // so the workspace's profile / custom instructions / remembered facts steer every model turn of
    // the run (e.g. "always answer in Turkish" must shape the plan, not just the execution).
    const withPrefix = (s: string): string => (input.systemPrefix ? `${input.systemPrefix}\n\n${s}` : s);
    const system = withPrefix(baseSystem);
    const planSystem = withPrefix(PLAN_SYSTEM);
    const skipPlanning = input.skipPlanning ?? false;
    const effort = input.effort;
    const capability = input.capability;
    // Durable resume: when present, the run continues from this state instead of starting fresh.
    const resume = input.resumeFrom;

    let seq = resume?.seq ?? 0;
    let callCounter = resume?.callCounter ?? 0;
    let approvalCounter = resume?.approvalCounter ?? 0;
    let toolCallCount = resume?.toolCallCount ?? 0;
    let toolErrors = resume?.toolErrors ?? 0;
    let policyDenials = 0;
    let finalText = '';
    // Token-aware compaction budget (COMPACTION): explicit override (caller's env hook) > registry window ×
    // fraction > conservative fallback. Resolved once — the model doesn't change mid-run.
    const compactAtTokens =
      input.compactAtTokens ??
      (() => {
        const win = getModel(input.provider.model)?.contextWindowTokens;
        return win ? Math.floor(win * COMPACT_CONTEXT_FRACTION) : COMPACT_AT_TOKENS_FALLBACK;
      })();
    // The LAST main-loop prompt's real input tokens (from provider usage), the primary compaction signal.
    // Starts at 0 on (re)start so a freshly resumed huge history relies on the message-count failsafe until
    // the first live response lands. Not the cumulative `usage.inputTokens`.
    let lastInputTokens = 0;
    let compactionGeneration = 0;

    const usage: RunUsage = resume
      ? { ...resume.usage }
      : {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        };

    const emit = async (event: EventInput): Promise<void> => {
      await input.emit({ ...event, taskId, seq: seq++ } as AgentEvent);
    };
    const status = (state: WireTaskState) => emit({ type: 'status', state });
    // Per-answering-model usage (COST-ATTRIBUTION). Keyed by resp.model — the model that actually answered,
    // which under a RoutingProvider may differ from the default profile. Supplementary to the cumulative
    // `usage`; surfaced in RunResult only when the run spanned >1 model.
    const usageByModel = new Map<string, ModelUsage>();
    const account = (resp: { usage: LlmUsage; costUsd: number; model: string }) => {
      usage.inputTokens += resp.usage.inputTokens;
      usage.outputTokens += resp.usage.outputTokens;
      usage.cacheReadTokens += resp.usage.cacheReadTokens;
      usage.cacheWriteTokens += resp.usage.cacheWriteTokens;
      usage.costUsd += resp.costUsd;
      const m = usageByModel.get(resp.model) ?? {
        model: resp.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0,
      };
      m.inputTokens += resp.usage.inputTokens;
      m.outputTokens += resp.usage.outputTokens;
      m.cacheReadTokens += resp.usage.cacheReadTokens;
      m.cacheWriteTokens += resp.usage.cacheWriteTokens;
      m.costUsd += resp.costUsd;
      m.calls += 1;
      usageByModel.set(resp.model, m);
    };
    // Live cost meter: emit the running token/USD usage so the UI updates as the run progresses and,
    // crucially, has a value on the success path (failOverBudget emits its own overThreshold:true).
    const emitCost = (overThreshold: boolean) =>
      emit({
        type: 'cost_estimate',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd: usage.costUsd,
        overThreshold,
      });
    const overBudget = () =>
      budgets.maxCostUsd !== undefined && usage.costUsd >= budgets.maxCostUsd;
    // Guarded LLM call: a provider error after the SDK's own retries (sustained overload, 4xx/5xx)
    // must not crash the run — emit a recoverable error and return null so the caller fails the task
    // gracefully (preserving the usage/cost already accounted), instead of throwing out of the engine.
    // In-loop provider retry (Ticket-04): a TRANSIENT model error (rate-limit 429, 5xx, or a network blip
    // with no status) must not kill a long run — retry a couple times with exponential backoff before
    // giving up. A deterministic 4xx (bad request / auth) is NOT retried. Honors a stop mid-backoff.
    const MAX_LLM_RETRIES = 2;
    const isTransient = (err: unknown): boolean => {
      const status = (err as { status?: number } | null)?.status;
      return status === undefined || status === 429 || (typeof status === 'number' && status >= 500);
    };
    const safeComplete = async (req: Parameters<LlmProvider['complete']>[0]): Promise<LlmResponse | null> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
        try {
          return await provider.complete(req);
        } catch (err) {
          lastErr = err;
          if (!isTransient(err) || attempt === MAX_LLM_RETRIES || controller.isStopped()) break;
          await emit({ type: 'error', message: `LLM request failed (transient), retrying: ${err instanceof Error ? err.message : String(err)}`, recoverable: true });
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // 0.5s, 1s
        }
      }
      await emit({
        type: 'error',
        message: `LLM request failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        recoverable: false,
      });
      return null;
    };
    const result = (state: EngineState, steps: number): RunResult => ({
      state,
      finalText,
      usage,
      steps,
      toolCalls: toolCallCount,
      // Byte-identical for a single-model run: the field is absent unless >1 distinct model answered.
      ...(usageByModel.size > 1 ? { usageByModel: Object.fromEntries(usageByModel) } : {}),
    });
    const failOverBudget = async (steps: number): Promise<RunResult> => {
      await emit({
        type: 'cost_estimate',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd: usage.costUsd,
        overThreshold: true,
      });
      await emit({ type: 'error', message: 'cost budget exceeded', recoverable: false });
      await status('failed');
      return result('failed', steps);
    };

    if (controller.isStopped()) {
      await emit({ type: 'stopped', reason: 'user_requested' });
      return result('stopped', 0);
    }

    // ---- Plan ---- (skipped in single-turn modes like chat, and on resume once already planned)
    if (!skipPlanning && !resume?.planned) {
      await status('planning');
      const planResp = await safeComplete({
        system: planSystem,
        messages: [{ role: 'user', content: prompt }],
        ...(effort ? { effort } : {}),
        ...(capability ? { capability } : {}),
      });
      if (!planResp) {
        await status('failed');
        return result('failed', 0);
      }
      account(planResp);
      lastInputTokens = planResp.usage.inputTokens;
      // A stop arriving during the (possibly long) planning call is observed here, before we emit the
      // plan and enter the running phase.
      if (controller.isStopped()) {
        await emit({ type: 'stopped', reason: 'user_requested' });
        return result('stopped', 0);
      }
      const steps = parsePlanSteps(planResp.text, taskId);
      await emit({ type: 'plan', summary: planResp.text.slice(0, 500) || 'Plan', steps });
      await emitCost(false);
      if (overBudget()) return failOverBudget(0);
    }

    // ---- Act / observe loop ----
    await status('running');
    const descriptors = tools.list();
    const toolDefs: LlmToolDef[] = descriptors.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    }));
    // Live plan tracking is a planning-phase feature: offer the update_plan tool only when the run
    // plans (single-turn/chat modes skip planning and stay tool-free).
    if (!skipPlanning) toolDefs.push(UPDATE_PLAN_TOOL_DEF as unknown as LlmToolDef);
    // On resume, continue the prior conversation; otherwise seed with the task prompt.
    const messages: LlmMessage[] = resume ? [...resume.messages] : [{ role: 'user', content: prompt }];
    // Running compaction summary of older turns (folded into the prompt; supersedes the prior one so
    // the head never grows unbounded). Empty until the first compaction.
    let runningSummary = resume?.runningSummary ?? '';

    // Durable resume (TICKET-003): serialize the current engine state at a step boundary so the
    // caller can persist a snapshot. No-op when no checkpoint callback was provided (default).
    const checkpoint = async (nextStep: number): Promise<void> => {
      if (!input.checkpoint) return;
      await input.checkpoint({
        v: RESUMABLE_STATE_VERSION,
        seq,
        step: nextStep,
        planned: true,
        messages: [...messages],
        runningSummary,
        usage: { ...usage },
        callCounter,
        approvalCounter,
        toolCallCount,
        toolErrors,
      });
    };

    const startStep = resume?.step ?? 0;
    // Initial boundary snapshot (right after planning / at resume entry) so a crash during the first
    // step can still resume from a snapshot rather than only from the event-log fallback.
    await checkpoint(startStep);

    for (let step = startStep; step < budgets.maxSteps; step += 1) {
      if (controller.isStopped()) {
        await emit({ type: 'stopped', reason: 'user_requested' });
        return result('stopped', step);
      }

      // Compact when the prompt grows large. Three triggers, OR'd:
      //  - REACTIVE: the last request's real billed input tokens passed the budget (accurate, no estimate);
      //  - PRE-CALL GUARD: the CURRENT prompt we're about to send already estimates over budget — catches a
      //    single huge tool_result appended this turn that the reactive signal (previous request) would miss,
      //    so the next call can't overflow before we react (the "post-factum" hole);
      //  - FAILSAFE: message count, for a huge resumed history (lastInputTokens still 0) or unknown window.
      // The `> COMPACT_KEEP_RECENT + 2` floor keeps the splice valid when a token trigger fires with
      // few-but-huge messages.
      if (
        (lastInputTokens > compactAtTokens ||
          approxPromptTokens(messages) > compactAtTokens ||
          messages.length > COMPACT_AT_MESSAGES) &&
        messages.length > COMPACT_KEEP_RECENT + 2
      ) {
        let cut = messages.length - COMPACT_KEEP_RECENT;
        // Snap forward to an assistant turn so the kept tail starts cleanly (tool_results keep their
        // matching tool_use; the head is followed by an assistant message — both API-valid).
        while (cut < messages.length && messages[cut]!.role !== 'assistant') cut += 1;
        if (cut > 1 && cut < messages.length) {
          const transcript =
            (runningSummary ? `PREVIOUS SUMMARY:\n${runningSummary}\n\n` : '') +
            renderForSummary(messages.slice(1, cut));
          const sum = await safeComplete({
            system:
              "You compress an AI agent's working history. Produce a terse bullet list capturing what " +
              'was done, key findings, decisions, and any IDs/URLs/paths needed to continue. No preamble.',
            messages: [{ role: 'user', content: transcript }],
          });
          if (sum) {
            account(sum);
            await emitCost(false);
            if (overBudget()) return failOverBudget(step + 1);
            // A stop arriving during the (possibly long) summary call is honored BEFORE we mutate the
            // history — mirroring the post-planning stop check.
            if (controller.isStopped()) {
              await emit({ type: 'stopped', reason: 'user_requested' });
              return result('stopped', step);
            }
            // Only apply compaction when the summary is clean: a refusal or a max_tokens-truncated
            // half-summary would corrupt the running history, so keep the full messages that round.
            if (sum.text.trim() && sum.stopReason !== 'refusal' && sum.stopReason !== 'max_tokens') {
              runningSummary = sum.text.trim();
              compactionGeneration += 1;
              // Drop the summarized middle; rebuild the head = pristine prompt + current summary. The prior
              // summary was folded INTO this one (PREVIOUS SUMMARY above), so the head supersedes rather
              // than nests — no summary-of-summary growth across generations.
              messages.splice(0, cut, {
                role: 'user',
                content: `${prompt}\n\n[Earlier progress — summarized (gen ${compactionGeneration})]\n${runningSummary}`,
              });
              // Reset the token signal: the prompt just shrank, so don't immediately re-trigger next loop.
              lastInputTokens = 0;
            }
          }
        }
      }

      const resp = await safeComplete({ system, messages, tools: toolDefs, ...(effort ? { effort } : {}), ...(capability ? { capability } : {}) });
      if (!resp) {
        await status('failed');
        return result('failed', step + 1);
      }
      account(resp);
      lastInputTokens = resp.usage.inputTokens;
      await emitCost(false);
      if (overBudget()) return failOverBudget(step + 1);

      // A safety refusal is a failure, not a successful "answer".
      if (resp.stopReason === 'refusal') {
        await emit({ type: 'error', message: 'the model refused to complete this request', recoverable: false });
        await status('failed');
        return result('failed', step + 1);
      }
      // A final answer truncated at max_tokens must not be reported as a clean completion.
      if (resp.stopReason === 'max_tokens' && resp.toolCalls.length === 0) {
        if (resp.text) await emit({ type: 'message', role: 'assistant', text: resp.text });
        await emit({
          type: 'error',
          message: 'response truncated (max_tokens); increase the token budget or narrow the task',
          recoverable: false,
        });
        await status('failed');
        return result('failed', step + 1);
      }

      if (resp.toolCalls.length === 0) {
        // pause_turn (server-tool/long-thinking continuation) is NOT the end — resume the loop.
        if (resp.stopReason === 'pause_turn') {
          if (resp.text) {
            await emit({ type: 'message', role: 'assistant', text: resp.text });
            messages.push({ role: 'assistant', content: [{ type: 'text', text: resp.text }] });
          }
          continue;
        }
        finalText = resp.text;
        // An empty completion (no text, no tools) is not a real answer — fail rather than report
        // a green task with the literal "Done".
        if (!finalText.trim()) {
          await emit({ type: 'error', message: 'the model produced no output', recoverable: false });
          await status('failed');
          return result('failed', step + 1);
        }
        // Terminal turn: emit only final_output (no duplicate assistant `message`).
        await emit({ type: 'final_output', summary: finalText, artifactIds: [] });
        await status('completed');
        return result('completed', step + 1);
      }

      // Intermediate assistant chatter alongside tool calls.
      if (resp.text) await emit({ type: 'message', role: 'assistant', text: resp.text });

      // Append the assistant turn (text + tool_use blocks) so tool_results can reference them.
      const assistantContent: LlmContentBlock[] = [];
      if (resp.text) assistantContent.push({ type: 'text', text: resp.text });
      for (const tc of resp.toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      const resultBlocks: LlmContentBlock[] = [];
      for (const tc of resp.toolCalls) {
        if (controller.isStopped()) {
          await emit({ type: 'stopped', reason: 'user_requested' });
          return result('stopped', step);
        }

        // Built-in: the agent maintains its live plan checklist. Handled in-engine (not delegated to
        // the executor) — re-emit the `plan` event with the updated step statuses. Kept out of the
        // tool_call/tool_result stream so it surfaces only as the checklist, but still answered with a
        // tool_result block so the assistant turn is well-formed.
        if (tc.name === UPDATE_PLAN_TOOL) {
          const parsed = parseUpdatePlan(tc.input);
          if (parsed) {
            await emit({ type: 'plan', summary: parsed.summary, steps: parsed.steps });
            resultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: 'plan updated' });
          } else {
            resultBlocks.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content: 'invalid update_plan input: provide a non-empty steps array of {title, status}',
              isError: true,
            });
          }
          continue;
        }

        const callId = `${taskId}-c${callCounter++}`;
        const descriptor = descriptors.find((d) => d.name === tc.name);

        if (!descriptor) {
          await emit({ type: 'tool_call', callId, tool: tc.name, riskLevel: 'low', input: tc.input });
          await emit({ type: 'tool_result', callId, ok: false, error: `unknown tool: ${tc.name}` });
          resultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: `unknown tool: ${tc.name}`, isError: true });
          toolErrors += 1;
          // Unknown-tool errors count against the same budget as failed executions, so a model that
          // keeps hallucinating tool names trips the limit instead of only being bounded by maxSteps.
          if (toolErrors > budgets.maxToolErrors) {
            await emit({ type: 'error', message: 'too many tool errors', recoverable: false });
            await status('failed');
            return result('failed', step + 1);
          }
          continue;
        }

        // Gate: legacy gate (riskCeiling + per-tool approvalRequired) MERGED with the policy engine,
        // taking the MORE restrictive — the policy can tighten but NEVER relaxes the legacy gate.
        // SECURITY FIX: also honor the system's own risk contract — `high`/`critical` actions ALWAYS
        // require approval (risk.ts: requiresApproval), regardless of the ceiling. Previously the gate was
        // only `risk > ceiling`, so with the default task ceiling `high` a high-risk action (shell exec,
        // deploy, sub-agent spawn) slipped through ungated (high > high = false). `requiresApproval` only
        // covers high+, so routine medium tools (browser click/type, file write) are NOT over-gated.
        const legacyEffect: PolicyEffect =
          descriptor.approvalRequired ||
          RISK_ORDER[descriptor.riskLevel] > RISK_ORDER[riskCeiling] ||
          requiresApproval(descriptor.riskLevel)
            ? 'require_approval'
            : 'allow';
        let effect: PolicyEffect = legacyEffect;
        let gateReason = `Tool "${tc.name}" requires approval (risk: ${descriptor.riskLevel})`;
        let detail: ApprovalDetail | undefined;
        if (input.policy) {
          const pd = await input.policy({
            tool: tc.name,
            riskLevel: descriptor.riskLevel,
            permissions: descriptor.permissions ?? [],
            input: tc.input,
          });
          effect = mostRestrictive(legacyEffect, pd.effect);
          if (pd.reason) gateReason = pd.reason;
          detail = pd.detail ? { ...pd.detail, elevated: effect === 'require_elevated_approval' } : undefined;
        }

        if (effect === 'deny') {
          await emit({ type: 'tool_call', callId, tool: tc.name, riskLevel: descriptor.riskLevel, input: tc.input, ...(descriptor.version ? { toolVersion: descriptor.version } : {}) });
          await emit({ type: 'tool_result', callId, ok: false, error: `denied by policy: ${gateReason}` });
          resultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: `denied by policy: ${gateReason}`, isError: true });
          policyDenials += 1;
          // Anti deny-loop: a model that keeps calling forbidden tools fails the run instead of spinning.
          if (policyDenials >= budgets.maxPolicyDenials) {
            await emit({ type: 'error', message: 'too many policy-denied tool calls', recoverable: false });
            await status('failed');
            return result('failed', step + 1);
          }
          continue;
        }

        if (effect === 'require_approval' || effect === 'require_elevated_approval') {
          const approvalId = `${taskId}-a${approvalCounter++}`;
          await emit({
            type: 'approval_request',
            approvalId,
            riskLevel: descriptor.riskLevel,
            action: tc.name,
            reason: gateReason,
            ...(detail ? { detail } : {}),
          });
          await status('waiting_for_approval');
          const decision = await controller.awaitApproval(approvalId);
          if (controller.isStopped()) {
            await emit({ type: 'stopped', reason: 'user_requested' });
            return result('stopped', step);
          }
          await status('running');
          if (decision === 'deny') {
            await emit({ type: 'tool_call', callId, tool: tc.name, riskLevel: descriptor.riskLevel, input: tc.input, ...(descriptor.version ? { toolVersion: descriptor.version } : {}) });
            await emit({ type: 'tool_result', callId, ok: false, error: 'denied by user' });
            resultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: 'denied by user', isError: true });
            continue;
          }
        }

        await emit({ type: 'tool_call', callId, tool: tc.name, riskLevel: descriptor.riskLevel, input: tc.input, ...(descriptor.version ? { toolVersion: descriptor.version } : {}) });
        toolCallCount += 1;
        let exec;
        try {
          exec = await tools.execute(tc.name, tc.input);
        } catch (err) {
          exec = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        if (exec.ok) {
          await emit({ type: 'tool_result', callId, ok: true, output: exec.output });
          // Cap what enters the MODEL HISTORY (the UI got the full output above). Large tool outputs
          // (page text, file reads, search dumps) otherwise accumulate across turns and overflow the
          // context window on long multi-step tasks.
          resultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: capForHistory(exec.output) });
        } else {
          await emit({ type: 'tool_result', callId, ok: false, error: exec.error });
          resultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: exec.error ?? 'error', isError: true });
          toolErrors += 1;
          if (toolErrors > budgets.maxToolErrors) {
            await emit({ type: 'error', message: 'too many tool errors', recoverable: false });
            await status('failed');
            return result('failed', step + 1);
          }
        }
      }

      messages.push({ role: 'user', content: resultBlocks });
      // Step boundary: this step's full tool turn is now in `messages`. Snapshot so a crash resumes
      // from here (the next step) rather than re-running this completed step.
      await checkpoint(step + 1);
    }

    await emit({ type: 'error', message: 'step budget exhausted', recoverable: false });
    await status('failed');
    return result('failed', budgets.maxSteps);
  }
}
