import { describe, it, expect } from 'vitest';
import { MockProvider } from '@agentos/llm';
import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage, LlmMessage } from '@agentos/llm';
import type { AgentEvent } from '@agentos/protocol';
import { AgentEngine } from './engine';
import { RunController } from './controller';
import { InMemoryToolExecutor, type InMemoryTool } from './tool-runtime';
import { deriveCursors, type ResumableState } from './resume';

function tool(name: string, handler: InMemoryTool['handler']): InMemoryTool {
  return {
    descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, riskLevel: 'low', approvalRequired: false },
    handler,
  };
}

// A run that plans, calls a tool twice (two steps), then answers.
function fullScripts() {
  return [
    { text: '1. search\n2. answer', stopReason: 'end_turn' as const },
    { text: '', toolCalls: [{ type: 'tool_use' as const, id: 'u1', name: 'web_search', input: { q: 'a' } }], stopReason: 'tool_use' as const },
    { text: '', toolCalls: [{ type: 'tool_use' as const, id: 'u2', name: 'web_search', input: { q: 'b' } }], stopReason: 'tool_use' as const },
    { text: 'The answer is 42.', stopReason: 'end_turn' as const },
  ];
}

describe('AgentEngine durable resume', () => {
  it('invokes checkpoint at step boundaries with monotonic step + seq', async () => {
    const provider = new MockProvider(fullScripts());
    let calls = 0;
    const tools = new InMemoryToolExecutor([tool('web_search', () => { calls += 1; return { ok: true, output: { r: calls } }; })]);
    const snaps: ResumableState[] = [];
    const res = await new AgentEngine().run({
      taskId: 't1', prompt: 'find it', provider, tools, controller: new RunController(),
      emit: () => {},
      checkpoint: (s) => { snaps.push(s); },
    });
    expect(res.state).toBe('completed');
    // initial(step0) + after step0(step1) + after step1(step2)
    expect(snaps.map((s) => s.step)).toEqual([0, 1, 2]);
    // seq strictly non-decreasing across snapshots; planned true once past planning
    expect(snaps.every((s) => s.planned)).toBe(true);
    for (let i = 1; i < snaps.length; i++) expect(snaps[i]!.seq).toBeGreaterThanOrEqual(snaps[i - 1]!.seq);
    // counters advance: after one tool, callCounter 1; after two, 2
    expect(snaps[1]!.callCounter).toBe(1);
    expect(snaps[2]!.callCounter).toBe(2);
  });

  it('resumeFrom skips planning, continues conversation, and carries counters/usage', async () => {
    const resume: ResumableState = {
      v: 1, seq: 50, step: 1, planned: true,
      messages: [{ role: 'user', content: 'find it' }, { role: 'assistant', content: 'partial' }],
      runningSummary: '', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
      callCounter: 1, approvalCounter: 0, toolCallCount: 1, toolErrors: 0,
    };
    const provider = new MockProvider([{ text: 'done now', stopReason: 'end_turn' }]);
    const tools = new InMemoryToolExecutor([tool('web_search', () => ({ ok: true, output: {} }))]);
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't1', prompt: 'find it', provider, tools, controller: new RunController(),
      emit: (e) => { events.push(e); }, resumeFrom: resume,
    });
    expect(res.state).toBe('completed');
    // No planning call was made (only the single act-loop call).
    expect(provider.calls.length).toBe(1);
    expect(events.find((e) => e.type === 'plan')).toBeUndefined();
    // seq continues from the resume cursor (first emitted event is status:running at seq 50).
    expect(events[0]!.seq).toBe(50);
    // carried usage is included in the final total (prior 0.5 + this run's cost).
    expect(res.usage.costUsd).toBeGreaterThan(0.5);
    // carried toolCallCount preserved (no new tool ran this turn).
    expect(res.toolCalls).toBe(1);
  });

  it('interrupted run resumed from snapshot produces the SAME final result as an uninterrupted run', async () => {
    // Baseline: full uninterrupted run.
    const baseTools = new InMemoryToolExecutor([tool('web_search', () => ({ ok: true, output: { ok: 1 } }))]);
    const baseline = await new AgentEngine().run({
      taskId: 't1', prompt: 'find it', provider: new MockProvider(fullScripts()), tools: baseTools,
      controller: new RunController(), emit: () => {},
    });
    expect(baseline.state).toBe('completed');
    expect(baseline.finalText).toBe('The answer is 42.');
    expect(baseline.toolCalls).toBe(2);

    // Interrupted: stop right after step 0 completes (graceful crash at a step boundary), capturing
    // the snapshot taken for step 1.
    const ctl = new RunController();
    let snapAtStep1: ResumableState | undefined;
    const interruptedEvents: AgentEvent[] = [];
    const intRes = await new AgentEngine().run({
      taskId: 't1', prompt: 'find it', provider: new MockProvider(fullScripts()),
      tools: new InMemoryToolExecutor([tool('web_search', () => ({ ok: true, output: { ok: 1 } }))]),
      controller: ctl, emit: (e) => { interruptedEvents.push(e); },
      checkpoint: (s) => { if (s.step === 1) { snapAtStep1 = s; ctl.requestStop(); } },
    });
    expect(intRes.state).toBe('stopped');
    expect(snapAtStep1).toBeDefined();
    const lastSeqBefore = Math.max(...interruptedEvents.map((e) => e.seq));

    // Mirror the task-runner: overlay seq + id counters from the LIVE persisted log onto the
    // snapshot, so newly-emitted seq/callIds never collide with anything already persisted (e.g. the
    // `stopped` event that consumed snapshot.seq after the checkpoint).
    const cursors = deriveCursors(interruptedEvents);
    const resumeState: ResumableState = {
      ...snapAtStep1!,
      seq: cursors.seq,
      callCounter: Math.max(snapAtStep1!.callCounter, cursors.callCounter),
      approvalCounter: Math.max(snapAtStep1!.approvalCounter, cursors.approvalCounter),
    };

    // Resume: fresh engine + the overlaid snapshot + a provider scripted for the REMAINING steps.
    const resumeEvents: AgentEvent[] = [];
    let resumeToolCalls = 0;
    const resumed = await new AgentEngine().run({
      taskId: 't1', prompt: 'find it',
      // Remaining model turns from step 1 onward: one tool call, then the final answer.
      provider: new MockProvider([fullScripts()[2]!, fullScripts()[3]!]),
      tools: new InMemoryToolExecutor([tool('web_search', () => { resumeToolCalls += 1; return { ok: true, output: { ok: 1 } }; })]),
      controller: new RunController(), emit: (e) => { resumeEvents.push(e); }, resumeFrom: resumeState,
    });

    expect(resumed.state).toBe('completed');
    expect(resumed.finalText).toBe(baseline.finalText); // SAME final result
    expect(resumed.toolCalls).toBe(2); // 1 carried in snapshot + 1 executed on resume
    expect(resumeToolCalls).toBe(1); // step 0's tool was NOT re-run (only step 1's)
    // seq continued monotonically past the interruption (no overlap/rewind).
    expect(Math.min(...resumeEvents.map((e) => e.seq))).toBe(lastSeqBefore + 1);
    // No duplicate planning on resume.
    expect(resumeEvents.find((e) => e.type === 'plan')).toBeUndefined();
  });

  it('COMPACTION across resume: a resumed run preserves runningSummary and a new compaction FOLDS it (no summary-of-summary)', async () => {
    // ChatGPT's resume-stability concern: after a crash-resume, a fresh compaction must SUPERSEDE the prior
    // summary (fold it in), not nest a summary-of-summary, and must keep the context bounded. Build a long
    // history (> COMPACT_AT_MESSAGES) carrying a prior summary, resume it, and force a compaction.
    const manyMessages: LlmMessage[] = [{ role: 'user', content: 'find it' }];
    for (let i = 1; i <= 44; i += 1) manyMessages.push({ role: i % 2 === 1 ? 'assistant' : 'user', content: `turn ${i}` });
    const resume: ResumableState = {
      v: 1, seq: 10, step: 5, planned: true,
      messages: manyMessages, // 45 messages -> the message-count failsafe fires on the first resumed loop
      runningSummary: 'PRIOR-SUMMARY-MARKER',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      callCounter: 5, approvalCounter: 0, toolCallCount: 0, toolErrors: 0,
    };

    let summaryTranscript = '';
    class CompactingProvider implements LlmProvider {
      readonly model = 'mock';
      summaryCalls = 0;
      maxMainMessages = 0;
      async complete(req: LlmRequest): Promise<LlmResponse> {
        const usage: LlmUsage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        const base = { usage, costUsd: 0, model: this.model };
        if (req.system?.includes('compress')) {
          this.summaryCalls += 1;
          const m0 = req.messages[0]!.content;
          summaryTranscript = typeof m0 === 'string' ? m0 : JSON.stringify(m0);
          return { text: 'NEW-SUMMARY', toolCalls: [], stopReason: 'end_turn', ...base };
        }
        this.maxMainMessages = Math.max(this.maxMainMessages, req.messages.length);
        return { text: 'done', toolCalls: [], stopReason: 'end_turn', ...base };
      }
      async countTokens(): Promise<number> {
        return 1;
      }
    }

    const provider = new CompactingProvider();
    const res = await new AgentEngine().run({
      taskId: 'r1', prompt: 'find it', provider,
      tools: new InMemoryToolExecutor([]), controller: new RunController(),
      resumeFrom: resume, emit: () => {},
    });

    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('done');
    expect(provider.summaryCalls).toBeGreaterThanOrEqual(1); // compaction fired on the resumed run
    // The PRIOR summary was folded into the new summary's input (PREVIOUS SUMMARY) -> preserved, not lost,
    // and superseded rather than nested.
    expect(summaryTranscript).toContain('PRIOR-SUMMARY-MARKER');
    // ...and the post-compaction prompt the act loop sees is bounded (well under the 45 it resumed with).
    expect(provider.maxMainMessages).toBeLessThan(40);
  });

  it('default behavior unchanged: no checkpoint callback => never throws, runs as before', async () => {
    const res = await new AgentEngine().run({
      taskId: 't1', prompt: 'hi', provider: new MockProvider([{ text: 'answer', stopReason: 'end_turn' }]),
      tools: new InMemoryToolExecutor([]), controller: new RunController(), skipPlanning: true, emit: () => {},
    });
    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('answer');
  });
});
