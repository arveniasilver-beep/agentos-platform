import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Prisma, TaskStatus, type PrismaClient, type RiskLevel } from '@agentos/db';
import type { AgentEvent, TaskState } from '@agentos/protocol';
import type { LlmProvider } from '@agentos/llm';
import {
  AgentEngine,
  deriveCursors,
  reduceEvents,
  type EnginePolicyCall,
  type EnginePolicyDecision,
  type ResumableState,
  type RunController,
  type ToolExecutor,
} from '@agentos/agent-engine';
import { loadServerEnv } from '@agentos/config';
import { AuditService } from '../audit/audit.service';
import { redactDeep } from '../policy/redact';
import { BrowserOperatorService } from '../browser/browser-operator.service';
import { DesktopRunnerService } from '../desktop/desktop-runner.service';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';

// Statuses a crashed task can be resumed from (its in-memory RunController died). Mirrors
// TasksService.RUNNING_STATES; kept local so the durable runner has no service dependency.
const RESUMABLE_STATUSES: TaskStatus[] = [
  TaskStatus.planning,
  TaskStatus.running,
  TaskStatus.awaiting_approval,
  TaskStatus.paused,
  TaskStatus.verifying,
];

export interface RunnableTask {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  prompt: string;
  riskCeiling: RiskLevel;
  stepBudget: number;
  costBudgetUsd: number | null;
  /** Capability-mode system prompt (undefined = engine default / general mode). */
  system?: string;
  /** Skip planning (single-turn modes like chat). */
  skipPlanning?: boolean;
  /** Personalization preamble prepended to the system prompt (undefined = none). */
  systemPrefix?: string;
  /** Reasoning effort tier (undefined = engine/provider default). */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Capability mode (slides|document|image|chat|…) — passed to the engine/Model Router for capability-
   * based routing (TICKET-10). undefined = no capability hint. */
  capability?: string;
}

// EXHAUSTIVE map from the wire ABI's TaskState to the DB TaskStatus. Typed as Record<TaskState,...>
// so TypeScript forces every wire state to be handled — a new/renamed ABI state can no longer be
// silently dropped at the persist path. `null` = intentionally not persisted (no DB equivalent /
// transient): `created` is the pre-run state (the row starts `pending`); `retrying` is a transient
// sub-state of running.
const STATUS_MAP: Record<TaskState, TaskStatus | null> = {
  created: null,
  planning: TaskStatus.planning,
  waiting_for_approval: TaskStatus.awaiting_approval,
  running: TaskStatus.running,
  paused: TaskStatus.paused,
  retrying: null,
  failed: TaskStatus.failed,
  completed: TaskStatus.completed,
  cancelled: TaskStatus.stopped,
};

/**
 * Runs the agent engine for a task and persists every event, tool call, approval, usage and cost
 * record to the database. Streaming/queueing is layered on top; this is the durable core.
 */
export class TaskRunner {
  private readonly logger = new Logger(TaskRunner.name);
  constructor(private readonly prisma: PrismaClient) {}

  // Lazily-built browser operator (TICKET-1) — only constructed when first needed, so the minimal
  // `new TaskRunner(prisma)` construction (tests/eval/service) stays unchanged.
  private _browserOp?: BrowserOperatorService;
  private get browserOp(): BrowserOperatorService {
    return (this._browserOp ??= new BrowserOperatorService(this.prisma as never, new AuditService(this.prisma as never)));
  }

  // Lazily-built desktop runner (TICKET-7) — same minimal-construction principle as browserOp.
  private _desktopRunner?: DesktopRunnerService;
  private get desktopRunner(): DesktopRunnerService {
    return (this._desktopRunner ??= new DesktopRunnerService(this.prisma as never, new AuditService(this.prisma as never)));
  }

  // Lazily-built connector registry (TICKET-9) — capability-scope enforcement for connector tool calls.
  private _connectorRegistry?: ConnectorRegistryService;
  private get connectorRegistry(): ConnectorRegistryService {
    return (this._connectorRegistry ??= new ConnectorRegistryService(this.prisma as never, new AuditService(this.prisma as never)));
  }

  async run(opts: {
    task: RunnableTask;
    provider: LlmProvider;
    tools: ToolExecutor;
    controller: RunController;
    /** Optional side-channel called after each event is persisted (e.g. live streaming). */
    sink?: (event: AgentEvent) => void;
    /**
     * Optional post-run deliberation (automated judge/debate): given the agent's final answer, a peer
     * model critiques it and the brain produces a revised final answer. Returns the cost spent (always
     * billed, folded into estCostUsd) plus a revision to apply, or revision:null to keep the original
     * (e.g. an empty judge output). Returns null overall if nothing ran. Best-effort — a thrown error
     * keeps the original answer.
     */
    deliberate?: (finalText: string) => Promise<{
      costUsd: number;
      revision: { finalText: string; critique: string; peerModel: string } | null;
    } | null>;
    /**
     * Durable Artifact Persistence (TICKET-ART): after a successful run, register the produced files
     * as durable Artifacts and return their ids (for final_output.artifactIds). Best-effort — a
     * failure must not undo the completed task. No-op / returns [] when the flag is off.
     */
    registerArtifacts?: () => Promise<string[]>;
    /** Policy engine hook (TICKET-POLICY): consulted per tool call; forwarded to the engine, which
     * merges it with the legacy gate (more restrictive). Omitted when POLICY_ENGINE_ENABLED is off. */
    policy?: (call: EnginePolicyCall) => Promise<EnginePolicyDecision>;
  }): Promise<void> {
    const { task, provider, tools, controller, sink } = opts;
    const env = loadServerEnv();
    const resumeEnabled = env.RESUME_ENABLED;
    // Multi-turn follow-up (KEYSTONE) also needs the engine's step-boundary snapshot (the conversation
    // messages[]) preserved, so snapshots are written whenever EITHER crash-resume OR follow-up is on.
    const followupEnabled = env.FOLLOWUP_TURNS_ENABLED;
    const snapshotEnabled = resumeEnabled || followupEnabled;
    const ttlMs = env.RESUME_LEASE_TTL_SEC * 1000;
    // A process-unique owner id for this run, used for lease ownership + fencing.
    const workerId = randomUUID();

    // Atomically claim the task. FRESH path (pending -> running) is the idempotency guard for
    // at-least-once delivery: if another delivery already claimed it, count===0 and (without resume)
    // we bail so we never run twice / append a second usage+cost row.
    const leaseData = resumeEnabled
      ? { leaseOwner: workerId, leaseExpiresAt: new Date(Date.now() + ttlMs), fencingToken: { increment: 1 } }
      : {};
    const fresh = await this.prisma.task.updateMany({
      where: { id: task.id, status: TaskStatus.pending },
      data: { status: TaskStatus.running, startedAt: new Date(), ...leaseData },
    });

    let isResume = false;
    if (fresh.count === 0) {
      // Not claimable as a fresh pending task. Without resume this is today's behavior: bail.
      if (!resumeEnabled) return;
      // RESUME path: re-claim a crashed in-flight task whose lease is gone/expired. The lease guard
      // (count===0 when a live lease is held) ensures the SAME task is never run by two workers, and
      // fencingToken increments so the prior (stale) worker can detect it lost the lease.
      const reclaim = await this.prisma.task.updateMany({
        where: {
          id: task.id,
          status: { in: RESUMABLE_STATUSES },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
        },
        data: {
          status: TaskStatus.running,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(Date.now() + ttlMs),
          fencingToken: { increment: 1 },
          resumeCount: { increment: 1 },
        },
      });
      if (reclaim.count === 0) return; // a live lease is held elsewhere, or the task is terminal.
      isResume = true;
    }

    // Read back the fencing token we now own (drives heartbeat fencing + poison guard).
    const claimed = await this.prisma.task.findUnique({
      where: { id: task.id },
      select: { fencingToken: true, resumeCount: true, prompt: true },
    });
    const myToken = claimed?.fencingToken ?? 0;
    // Poison-task guard: a task that keeps crashing must not resume forever — fail it controlled.
    if (isResume && (claimed?.resumeCount ?? 0) > env.RESUME_MAX_ATTEMPTS) {
      await this.prisma.task
        .update({
          where: { id: task.id },
          data: {
            status: TaskStatus.failed,
            errorText: `Exceeded ${env.RESUME_MAX_ATTEMPTS} resume attempts.`,
            finishedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        })
        .catch(() => undefined);
      return;
    }

    // Build the resume state (only on the resume path): prefer the latest snapshot, fall back to
    // folding the event log; overlay seq + id counters from the live log so newly-emitted ids never
    // collide with anything a partial (post-snapshot) step already persisted.
    let resumeFrom: ResumableState | undefined;
    // Resume path (crash) builds it; a follow-up turn is a FRESH-claimed task that carries a preserved
    // snapshot, so build it whenever follow-up is on too (buildResumeState returns undefined for a brand-
    // new task with no snapshot/log — so a normal first run is unaffected).
    if (isResume || followupEnabled) {
      resumeFrom = await this.buildResumeState(task.id, claimed?.prompt ?? task.prompt);
    }

    // Track the highest event seq so a post-run deliberation can append a follow-up event gap-free.
    let lastSeq = -1;
    // `sideEffect:false` persists + streams the event WITHOUT firing applySideEffect — used for the
    // deliberation's synthetic final_output, whose notification would duplicate the engine's own.
    const persist = async (event: AgentEvent, sideEffect: boolean): Promise<void> => {
      lastSeq = Math.max(lastSeq, event.seq);
      // Secret redaction at rest (Ticket-07): scrub credentials from the durable TRACE + the live UI
      // stream + the recorded tool args. A secret that flows through a tool call/result (a key in an arg,
      // a token echoed in output) must never be persisted or shown raw. redactDeep preserves shape/type,
      // only stripping credential patterns, so seq/type/ids/structure are intact (replay/cursors unaffected).
      // The engine's in-memory resume conversation (the snapshot messages[]) is a SEPARATE channel and is
      // intentionally not redacted here — redacting it would corrupt the model's continuation context.
      const safe = redactDeep(event);
      await this.prisma.taskLog.create({
        data: {
          taskId: task.id,
          workspaceId: task.workspaceId,
          seq: safe.seq,
          type: safe.type,
          payload: safe as unknown as Prisma.InputJsonValue,
        },
      });
      if (sideEffect) await this.applySideEffect(task, safe);
      if (sink) {
        try {
          sink(safe);
        } catch {
          // a misbehaving subscriber must never break the run
        }
      }
    };
    const emit = (event: AgentEvent): Promise<void> => persist(event, true);

    // Step-boundary snapshot (TICKET-003): one latest row per task, upserted. Best-effort — a failed
    // snapshot only means resume falls back to an earlier snapshot or the event-log reducer.
    const checkpoint = async (state: ResumableState): Promise<void> => {
      await this.prisma.taskSnapshot
        .upsert({
          where: { taskId: task.id },
          create: {
            taskId: task.id,
            workspaceId: task.workspaceId,
            seq: state.seq,
            state: state as unknown as Prisma.InputJsonValue,
          },
          update: { seq: state.seq, state: state as unknown as Prisma.InputJsonValue },
        })
        .catch(() => undefined);
    };

    // Heartbeat (TICKET-004): extend our lease on a timer. The update is FENCED on (leaseOwner,
    // fencingToken) — if another worker re-claimed the task (incrementing the token), our update hits
    // 0 rows and we stop this stale run. unref so it never keeps the process alive on its own.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (resumeEnabled) {
      heartbeat = setInterval(() => {
        void this.prisma.task
          .updateMany({
            where: { id: task.id, leaseOwner: workerId, fencingToken: myToken },
            data: { leaseExpiresAt: new Date(Date.now() + ttlMs) },
          })
          .then((r) => {
            if (r.count === 0) controller.requestStop(); // lost the lease → unwind
          })
          .catch(() => undefined);
      }, env.RESUME_HEARTBEAT_SEC * 1000);
      heartbeat.unref?.();
    }

    let result;
    try {
      result = await new AgentEngine().run({
        taskId: task.id,
        prompt: task.prompt,
        provider,
        tools,
        controller,
        emit,
        riskCeiling: task.riskCeiling,
        ...(task.system ? { system: task.system } : {}),
        ...(task.skipPlanning ? { skipPlanning: task.skipPlanning } : {}),
        ...(task.systemPrefix ? { systemPrefix: task.systemPrefix } : {}),
        ...(task.effort ? { effort: task.effort } : {}),
        ...(task.capability ? { capability: task.capability } : {}),
        ...(resumeFrom ? { resumeFrom } : {}),
        ...(snapshotEnabled ? { checkpoint } : {}),
        ...(opts.policy ? { policy: opts.policy } : {}),
        // Token-aware compaction (COMPACTION): pass the operator's env override through; when unset the
        // engine derives the budget from the model registry's context window.
        ...(env.COMPACT_AT_TOKENS ? { compactAtTokens: env.COMPACT_AT_TOKENS } : {}),
        budgets: {
          maxSteps: task.stepBudget,
          ...(task.costBudgetUsd !== null ? { maxCostUsd: task.costBudgetUsd } : {}),
          // Policy engine (TICKET-POLICY): wire the deny-loop budget from config so a model that keeps
          // requesting forbidden tools is stopped after POLICY_MAX_DENIALS denials.
          maxPolicyDenials: env.POLICY_MAX_DENIALS,
        },
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    // Multi-turn follow-up (KEYSTONE): result.usage is CUMULATIVE across a resumed run (the engine seeds
    // its accumulator from resumeFrom.usage). On a FOLLOW-UP run — i.e. a prior run already wrote its cost
    // — record only THIS turn's delta so old tokens aren't double-billed. A crash-resume (no prior cost
    // row) or a first run records the full value, exactly as before (flag-off byte-identical).
    let recordUsage = result.usage;
    if (followupEnabled && resumeFrom && (await this.prisma.costRecord.count({ where: { taskId: task.id } })) > 0) {
      const base = resumeFrom.usage;
      recordUsage = {
        inputTokens: Math.max(0, result.usage.inputTokens - base.inputTokens),
        outputTokens: Math.max(0, result.usage.outputTokens - base.outputTokens),
        cacheReadTokens: Math.max(0, result.usage.cacheReadTokens - base.cacheReadTokens),
        cacheWriteTokens: Math.max(0, result.usage.cacheWriteTokens - base.cacheWriteTokens),
        costUsd: Math.max(0, result.usage.costUsd - base.costUsd),
      };
    }
    await this.prisma.usageRecord.create({
      data: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        model: provider.model,
        inputTokens: BigInt(Math.round(recordUsage.inputTokens)),
        outputTokens: BigInt(Math.round(recordUsage.outputTokens)),
        cacheReadTokens: BigInt(Math.round(recordUsage.cacheReadTokens)),
        cacheWriteTokens: BigInt(Math.round(recordUsage.cacheWriteTokens)),
      },
    });
    await this.prisma.costRecord.create({
      data: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        amountUsd: recordUsage.costUsd,
        // All token classes the cost was computed from (incl. cache), so tokenCount and amountUsd
        // stay consistent for any cost-per-token reconciliation.
        tokenCount: BigInt(
          Math.round(recordUsage.inputTokens + recordUsage.outputTokens + recordUsage.cacheReadTokens + recordUsage.cacheWriteTokens),
        ),
      },
    });

    const finalStatus =
      result.state === 'completed'
        ? TaskStatus.completed
        : result.state === 'stopped'
          ? TaskStatus.stopped
          : TaskStatus.failed;

    // Automated deliberation (judge/debate): only for a successful run with a real answer, and only
    // when the cost budget (if any) is not already spent — the deliberation makes 2 extra billed
    // calls, so it must not run once the ceiling is reached. Best-effort: any failure keeps the
    // original answer. Its cost is always folded into estCostUsd.
    let finalText = result.finalText;
    let deliberation: { peerModel: string; critique: string; original: string } | undefined;
    let deliberationCostUsd = 0;
    let revised = false;
    const budgetHeadroom = task.costBudgetUsd === null || result.usage.costUsd < task.costBudgetUsd;
    if (opts.deliberate && result.state === 'completed' && finalText.trim() !== '' && budgetHeadroom) {
      try {
        const d = await opts.deliberate(finalText);
        if (d) {
          deliberationCostUsd = d.costUsd;
          if (d.revision && d.revision.finalText.trim() !== '') {
            deliberation = { peerModel: d.revision.peerModel, critique: d.revision.critique, original: finalText };
            finalText = d.revision.finalText;
            revised = true;
          }
        }
      } catch {
        // keep the original answer
      }
    }

    // Durable Artifact Persistence (TICKET-ART): register the files the run produced and capture their
    // ids for final_output.artifactIds. Best-effort — a completed task is never undone by a registration
    // failure. No-op / [] when the feature flag is off.
    let artifactIds: string[] = [];
    if (result.state === 'completed' && opts.registerArtifacts) {
      try {
        artifactIds = await opts.registerArtifacts();
      } catch (err) {
        this.logger.warn(`artifact registration failed for task ${task.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ONE authoritative follow-up final_output (gap-free, no duplicate "task done" notification),
    // written ONLY when there is something new beyond the engine's own final_output: a revised answer
    // and/or the resolved artifactIds. The UI/replay reads the LAST final_output event.
    if (revised || artifactIds.length > 0) {
      await persist(
        { type: 'final_output', taskId: task.id, seq: lastSeq + 1, summary: finalText, artifactIds } as AgentEvent,
        false,
      );
    }

    await this.prisma.task.update({
      where: { id: task.id },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
        estCostUsd: result.usage.costUsd + deliberationCostUsd,
        // Terminal: release the lease so the row is clean (terminal status is not resume-claimable
        // anyway, but this avoids a dangling owner/expiry).
        ...(resumeEnabled ? { leaseOwner: null, leaseExpiresAt: null } : {}),
        result: {
          summary: finalText,
          steps: result.steps,
          toolCalls: result.toolCalls,
          ...(deliberation ? { deliberation } : {}),
          ...(artifactIds.length > 0 ? { artifactIds } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    // Multi-turn follow-up (KEYSTONE): PRESERVE the snapshot across terminal so a follow-up turn can
    // resume the conversation, and COMPLETE it with the final assistant answer — the engine emits the
    // answer as final_output but never appends it to messages[] (engine.ts), so without this the next
    // turn's history would end on a user/tool turn with the answer missing. When follow-up is off, the
    // snapshot is dropped on terminal exactly as today (byte-identical).
    if (followupEnabled) {
      const assistantText = finalText.trim() || 'The previous attempt did not produce a result.';
      const snap = await this.prisma.taskSnapshot.findUnique({ where: { taskId: task.id } });
      if (snap) {
        const state = snap.state as unknown as ResumableState;
        const messages = [...state.messages, { role: 'assistant' as const, content: assistantText }];
        // The last step-boundary checkpoint does NOT include the final answer's model call (it returns
        // before a post-step checkpoint), so its usage/step are partial. Overwrite with the run's TRUE
        // cumulative usage + final step so the next follow-up turn seeds the accumulator correctly (and
        // the per-turn cost delta is exact).
        const completed: ResumableState = { ...state, messages, usage: result.usage, step: result.steps, planned: true };
        await this.prisma.taskSnapshot
          .update({ where: { taskId: task.id }, data: { state: completed as unknown as Prisma.InputJsonValue } })
          .catch(() => undefined);
      }
      // Persist the conversation turns for the chat thread. On the FIRST terminal, backfill the original
      // user prompt (seq 0); then append this run's assistant answer. Follow-up user turns are written by
      // sendFollowup, so here we only ever add the assistant side (+ the one-time prompt backfill).
      try {
        const existing = await this.prisma.taskMessage.count({ where: { taskId: task.id } });
        let seq = existing;
        if (existing === 0) {
          await this.prisma.taskMessage.create({ data: { taskId: task.id, workspaceId: task.workspaceId, role: 'user', seq: seq++, content: task.prompt } });
        }
        await this.prisma.taskMessage.create({ data: { taskId: task.id, workspaceId: task.workspaceId, role: 'assistant', seq: seq++, content: assistantText } });
      } catch {
        /* best-effort: the chat thread is a view convenience, never blocks task completion */
      }
    } else if (resumeEnabled) {
      // The run is terminal — drop its snapshot (best-effort; cascade would also remove it on delete).
      await this.prisma.taskSnapshot.deleteMany({ where: { taskId: task.id } }).catch(() => undefined);
    }
  }

  /**
   * Build the engine resume state for a crashed task: prefer the latest snapshot (authoritative,
   * holds the real messages[]), else fold the event log (reducer fallback). In both cases overlay
   * seq + callId/approvalId counters from the LIVE event log so newly-emitted ids never collide with
   * ids a partial (post-snapshot) step already persisted (append-only safe).
   */
  private async buildResumeState(taskId: string, prompt: string): Promise<ResumableState | undefined> {
    const [snapRow, logs] = await Promise.all([
      this.prisma.taskSnapshot.findUnique({ where: { taskId } }),
      this.prisma.taskLog.findMany({
        where: { taskId },
        orderBy: { seq: 'asc' },
        select: { payload: true },
      }),
    ]);
    const events = logs.map((l) => l.payload as unknown as AgentEvent);
    if (snapRow) {
      const cursors = deriveCursors(events);
      const state = snapRow.state as unknown as ResumableState;
      return {
        ...state,
        seq: Math.max(state.seq, cursors.seq),
        callCounter: Math.max(state.callCounter, cursors.callCounter),
        approvalCounter: Math.max(state.approvalCounter, cursors.approvalCounter),
      };
    }
    if (events.length > 0) return reduceEvents(events, prompt);
    return undefined; // nothing persisted yet — engine starts fresh from the prompt.
  }

  private async applySideEffect(task: RunnableTask, event: AgentEvent): Promise<void> {
    if (event.type === 'tool_call') {
      await this.prisma.toolCall
        .create({
          data: {
            taskId: task.id,
            workspaceId: task.workspaceId,
            callId: event.callId,
            toolName: event.tool,
            // TICKET-2: record the tool version in the trace (additive metadata; present once the engine
            // emits it). Harmless + inert when absent.
            ...(event.toolVersion ? { toolVersion: event.toolVersion } : {}),
            risk: event.riskLevel as RiskLevel,
            args: (event.input ?? {}) as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
      // Browser Operator Hardening (TICKET-1): durably record + audit browser actions. Flag-gated +
      // best-effort — flag-off => byte-identical (no session/action rows, no browser audit).
      if (loadServerEnv().BROWSER_OPERATOR_ENABLED && event.tool?.startsWith('browser_')) {
        const input = (event.input ?? {}) as Record<string, unknown>;
        await this.browserOp
          .onAction({
            workspaceId: task.workspaceId,
            taskId: task.id,
            callId: event.callId,
            tool: event.tool,
            url: typeof input.url === 'string' ? input.url : null,
            target: typeof input.selector === 'string' ? input.selector : typeof input.text === 'string' ? input.text : null,
            submit: input.submit === true,
          })
          .catch(() => undefined);
      }
      // Desktop Runner Foundation (TICKET-7): content-free, full-path-free local-action audit attributed
      // to the workspace's active desktop runner. Flag-gated + best-effort — flag-off => no local audit.
      if (loadServerEnv().DESKTOP_RUNNER_ENABLED && event.tool && /^local_(read|write|list)$/.test(event.tool)) {
        const input = (event.input ?? {}) as Record<string, unknown>;
        const action = event.tool.replace(/^local_/, '');
        await this.desktopRunner
          .recordLocalAction(task.workspaceId, {
            folderLabel: typeof input.folder === 'string' ? input.folder : '',
            relativePath: typeof input.path === 'string' ? input.path : '',
            action,
            risk: action === 'write' ? 'high' : 'medium',
          })
          .catch(() => undefined);
      }
      // Connectors v2 (TICKET-9): capability-scope enforcement for connector tool calls. Flag-gated +
      // best-effort — checkAction records an audit when a connector action's required scopes aren't
      // granted by the connection. Flag-off => no connector scope-checking.
      if (loadServerEnv().CONNECTORS_V2_ENABLED && event.tool) {
        const provider = /^github_/.test(event.tool) ? 'github' : /^notion_/.test(event.tool) ? 'notion' : /^(google_|gmail_)/.test(event.tool) ? 'google' : /^outlook_/.test(event.tool) ? 'outlook' : null;
        if (provider) await this.connectorRegistry.checkAction(task.workspaceId, provider, event.tool).catch(() => undefined);
      }
    } else if (event.type === 'tool_result') {
      // Best-effort like the other side effects (the durable taskLog row already captured the
      // event): a failed result-update must not abort an otherwise-healthy run mid-flight.
      await this.prisma.toolCall
        .updateMany({
          where: { taskId: task.id, callId: event.callId },
          data: {
            ok: event.ok,
            errorText: event.error ?? null,
            ...(event.output !== undefined ? { output: event.output as Prisma.InputJsonValue } : {}),
          },
        })
        .catch(() => undefined);
      // Browser Operator Hardening (TICKET-1): record the action outcome (ok/denied/error) by callId.
      // No-ops for non-browser calls (no matching browser_action row). Flag-gated + best-effort.
      if (loadServerEnv().BROWSER_OPERATOR_ENABLED) {
        await this.browserOp
          .onResult({ workspaceId: task.workspaceId, callId: event.callId, ok: event.ok, error: event.error ?? undefined })
          .catch(() => undefined);
      }
    } else if (event.type === 'approval_request') {
      await this.prisma.approval
        .create({
          data: {
            taskId: task.id,
            workspaceId: task.workspaceId,
            approvalId: event.approvalId,
            action: event.action,
            risk: event.riskLevel as RiskLevel,
            // Policy engine (TICKET-POLICY): persist whether this needs an elevated approval + why,
            // so the decide endpoint can enforce admin/owner + non-self / break-glass.
            elevated: event.detail?.elevated ?? false,
            policyReason: event.detail?.riskReason ?? null,
          },
        })
        .catch(() => undefined);
      // In-app notification (the header bell): the run is parked waiting for a human.
      await this.notify(task, {
        kind: 'approval_request',
        title: 'Approval needed',
        body: `Tool "${event.action}" needs approval.`,
        approvalId: event.approvalId,
      });
    } else if (event.type === 'final_output') {
      await this.notify(task, { kind: 'task_done', title: 'Task completed' });
    } else if (event.type === 'error' && !event.recoverable) {
      // Persist the failure reason so a failed task carries WHY (e.g. "cost budget exceeded") — surfaced
      // in the UI and propagated to an AutomationRun's failureReason (TICKET-AUTOMATION).
      await this.prisma.task.update({ where: { id: task.id }, data: { errorText: event.message } }).catch(() => undefined);
      await this.notify(task, { kind: 'task_done', title: 'Task failed', body: event.message });
    } else if (event.type === 'status') {
      const mapped = STATUS_MAP[event.state];
      if (mapped) {
        await this.prisma.task
          .update({ where: { id: task.id }, data: { status: mapped } })
          .catch(() => undefined);
      }
    }
  }

  /** Best-effort in-app notification for the task's owner (the header bell). Never breaks the run. */
  private async notify(
    task: RunnableTask,
    n: { kind: string; title: string; body?: string; approvalId?: string },
  ): Promise<void> {
    await this.prisma.notification
      .create({
        data: {
          workspaceId: task.workspaceId,
          userId: task.createdByUserId,
          kind: n.kind,
          title: n.title,
          body: n.body ?? null,
          taskId: task.id,
          ...(n.approvalId ? { approvalId: n.approvalId } : {}),
        },
      })
      .catch(() => undefined);
  }
}
