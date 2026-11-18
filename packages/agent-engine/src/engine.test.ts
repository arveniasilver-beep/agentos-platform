import { describe, it, expect } from 'vitest';
import { MockProvider } from '@agentos/llm';
import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage } from '@agentos/llm';
import type { AgentEvent } from '@agentos/protocol';
import { AgentEngine } from './engine';
import { RunController } from './controller';
import { InMemoryToolExecutor, type InMemoryTool } from './tool-runtime';

function tool(
  name: string,
  riskLevel: InMemoryTool['descriptor']['riskLevel'],
  approvalRequired: boolean,
  handler: InMemoryTool['handler'],
): InMemoryTool {
  return {
    descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, riskLevel, approvalRequired },
    handler,
  };
}

describe('AgentEngine', () => {
  it('plans, calls a tool, and delivers a verified final answer', async () => {
    const provider = new MockProvider([
      { text: '1. search\n2. answer', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'web_search', input: { query: 'x' } }], stopReason: 'tool_use' },
      { text: 'The answer is 42.', stopReason: 'end_turn' },
    ]);
    const tools = new InMemoryToolExecutor([
      tool('web_search', 'low', false, () => ({ ok: true, output: { results: ['a', 'b'] } })),
    ]);
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't1',
      prompt: 'find the answer',
      provider,
      tools,
      controller: new RunController(),
      emit: (e) => {
        events.push(e);
      },
    });

    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('The answer is 42.');
    expect(res.toolCalls).toBe(1);

    const types = events.map((e) => e.type);
    expect(types).toContain('plan');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('final_output');
    // seq is monotonic from 0
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('skipPlanning runs a single-turn answer with no plan phase (chat mode)', async () => {
    const provider = new MockProvider([
      { text: 'Paris is the capital of France.', stopReason: 'end_turn' },
    ]);
    const tools = new InMemoryToolExecutor([]);
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 'chat1',
      prompt: 'What is the capital of France?',
      provider,
      tools,
      controller: new RunController(),
      system: 'You are a helpful assistant.',
      skipPlanning: true,
      emit: (e) => {
        events.push(e);
      },
    });

    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('Paris is the capital of France.');
    // No planning happened: no plan event and the run never entered the 'planning' status.
    expect(events.some((e) => e.type === 'plan')).toBe(false);
    expect(events.some((e) => e.type === 'status' && e.state === 'planning')).toBe(false);
    // A live cost estimate is emitted on the success path (not only on over-budget failure).
    expect(events.some((e) => e.type === 'cost_estimate' && e.overThreshold === false)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('prepends systemPrefix (personalization) to both the plan and act-loop system prompts', async () => {
    const provider = new MockProvider([
      { text: '1. answer', stopReason: 'end_turn' }, // plan call
      { text: 'Done.', stopReason: 'end_turn' }, // act call
    ]);
    const tools = new InMemoryToolExecutor([]);
    await new AgentEngine().run({
      taskId: 'p1',
      prompt: 'do it',
      provider,
      tools,
      controller: new RunController(),
      system: 'BASE_SYSTEM',
      systemPrefix: 'PERSONA_PREAMBLE',
      emit: () => {},
    });
    const planCall = provider.calls[0]!;
    const actCall = provider.calls[1]!;
    // The preamble steers BOTH the plan and the act loop, ahead of each base prompt.
    expect(planCall.system).toContain('PERSONA_PREAMBLE');
    expect(actCall.system).toContain('PERSONA_PREAMBLE');
    expect(actCall.system).toContain('BASE_SYSTEM');
    expect(actCall.system!.indexOf('PERSONA_PREAMBLE')).toBeLessThan(actCall.system!.indexOf('BASE_SYSTEM'));
  });

  it('update_plan re-emits the plan with live step statuses (no tool_call clutter)', async () => {
    const provider = new MockProvider([
      { text: '1. do', stopReason: 'end_turn' }, // plan
      {
        text: '',
        toolCalls: [
          {
            type: 'tool_use',
            id: 'u1',
            name: 'update_plan',
            input: {
              summary: 'My plan',
              steps: [
                { title: 'Research', status: 'completed' },
                { title: 'Write', status: 'in_progress' },
                { title: 'Review', status: 'pending' },
              ],
            },
          },
        ],
        stopReason: 'tool_use',
      },
      { text: 'All done.', stopReason: 'end_turn' }, // final
    ]);
    const tools = new InMemoryToolExecutor([]);
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 'up1',
      prompt: 'do work',
      provider,
      tools,
      controller: new RunController(),
      emit: (e) => {
        events.push(e);
      },
    });

    expect(res.state).toBe('completed');
    // Two plan events: the initial plan + the update_plan re-emit with statuses.
    const plans = events.filter((e) => e.type === 'plan');
    expect(plans.length).toBe(2);
    const updated = plans[1] as Extract<AgentEvent, { type: 'plan' }>;
    expect(updated.summary).toBe('My plan');
    expect(updated.steps.map((s) => s.status)).toEqual(['completed', 'in_progress', 'pending']);
    // update_plan is handled in-engine: it does NOT surface as a tool_call/tool_result event.
    expect(events.some((e) => e.type === 'tool_call' && e.tool === 'update_plan')).toBe(false);
  });

  it('does not offer update_plan when planning is skipped (chat mode)', async () => {
    const provider = new MockProvider([{ text: 'Hi.', stopReason: 'end_turn' }]);
    const tools = new InMemoryToolExecutor([]);
    await new AgentEngine().run({
      taskId: 'up2',
      prompt: 'hello',
      provider,
      tools,
      controller: new RunController(),
      skipPlanning: true,
      emit: () => {},
    });
    // The single act-loop call advertised no tools at all (chat is tool-free).
    const actCall = provider.calls[0]!;
    expect(actCall.tools ?? []).toHaveLength(0);
  });

  it('passes the effort tier to the provider on every model turn', async () => {
    const provider = new MockProvider([
      { text: '1. answer', stopReason: 'end_turn' },
      { text: 'Done.', stopReason: 'end_turn' },
    ]);
    await new AgentEngine().run({
      taskId: 'eff1',
      prompt: 'do it',
      provider,
      tools: new InMemoryToolExecutor([]),
      controller: new RunController(),
      effort: 'low',
      emit: () => {},
    });
    expect(provider.calls.every((c) => c.effort === 'low')).toBe(true);
  });

  it('pauses for approval on a high-risk tool and runs it once approved', async () => {
    const provider = new MockProvider([
      { text: '1. delete', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'fs_delete', input: { path: '/x' } }], stopReason: 'tool_use' },
      { text: 'deleted', stopReason: 'end_turn' },
    ]);
    const tools = new InMemoryToolExecutor([
      tool('fs_delete', 'critical', true, () => ({ ok: true, output: { deleted: true } })),
    ]);
    const events: AgentEvent[] = [];
    const controller = new RunController();
    const res = await new AgentEngine().run({
      taskId: 't2',
      prompt: 'delete x',
      provider,
      tools,
      controller,
      emit: (e) => {
        events.push(e);
        if (e.type === 'approval_request') {
          queueMicrotask(() => controller.decideApproval(e.approvalId, 'approve'));
        }
      },
    });

    expect(res.state).toBe('completed');
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.state === 'waiting_for_approval')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call' && e.tool === 'fs_delete')).toBe(true);
    expect(res.toolCalls).toBe(1);
  });

  it('records a denial and does not execute the tool', async () => {
    const provider = new MockProvider([
      { text: '1. delete', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'fs_delete', input: { path: '/x' } }], stopReason: 'tool_use' },
      { text: 'aborted', stopReason: 'end_turn' },
    ]);
    let executed = false;
    const tools = new InMemoryToolExecutor([
      tool('fs_delete', 'critical', true, () => {
        executed = true;
        return { ok: true, output: {} };
      }),
    ]);
    const events: AgentEvent[] = [];
    const controller = new RunController();
    const res = await new AgentEngine().run({
      taskId: 't3',
      prompt: 'delete x',
      provider,
      tools,
      controller,
      emit: (e) => {
        events.push(e);
        if (e.type === 'approval_request') {
          queueMicrotask(() => controller.decideApproval(e.approvalId, 'deny'));
        }
      },
    });

    expect(res.state).toBe('completed');
    expect(executed).toBe(false);
    expect(res.toolCalls).toBe(0);
    expect(events.some((e) => e.type === 'tool_result' && e.ok === false && e.error === 'denied by user')).toBe(true);
  });

  it('stops instantly when requested, before any tool runs', async () => {
    const provider = new MockProvider([
      { text: '1. step', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'web_search', input: {} }], stopReason: 'tool_use' },
    ]);
    const tools = new InMemoryToolExecutor([
      tool('web_search', 'low', false, () => ({ ok: true, output: {} })),
    ]);
    const events: AgentEvent[] = [];
    const controller = new RunController();
    const res = await new AgentEngine().run({
      taskId: 't4',
      prompt: 'go',
      provider,
      tools,
      controller,
      emit: (e) => {
        events.push(e);
        if (e.type === 'plan') controller.requestStop();
      },
    });

    expect(res.state).toBe('stopped');
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(res.toolCalls).toBe(0);
  });

  it('stops when the cost budget is exceeded', async () => {
    const provider = new MockProvider([{ text: '1. step', stopReason: 'end_turn' }]);
    const tools = new InMemoryToolExecutor([]);
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't5',
      prompt: 'go',
      provider,
      tools,
      controller: new RunController(),
      budgets: { maxCostUsd: 0 },
      emit: (e) => {
        events.push(e);
      },
    });

    expect(res.state).toBe('failed');
    expect(events.some((e) => e.type === 'cost_estimate' && e.overThreshold === true)).toBe(true);
  });

  it('recovers from a tool error and completes (error fed back to the model)', async () => {
    const provider = new MockProvider([
      { text: '1. try', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'flaky', input: {} }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u2', name: 'flaky', input: {} }], stopReason: 'tool_use' },
      { text: 'recovered', stopReason: 'end_turn' },
    ]);
    let calls = 0;
    const tools = new InMemoryToolExecutor([
      tool('flaky', 'low', false, () => {
        calls += 1;
        return calls === 1 ? { ok: false, error: 'boom' } : { ok: true, output: { done: true } };
      }),
    ]);
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't6',
      prompt: 'do it',
      provider,
      tools,
      controller: new RunController(),
      emit: (e) => {
        events.push(e);
      },
    });

    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('recovered');
    expect(res.toolCalls).toBe(2);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.some((e) => e.type === 'tool_result' && e.ok === false)).toBe(true);
    expect(results.some((e) => e.type === 'tool_result' && e.ok === true)).toBe(true);
  });

  it('trips the error budget on repeated unknown-tool calls (not only on real failures)', async () => {
    // The model keeps hallucinating a tool name; with maxToolErrors=2 the run must fail rather than
    // looping until maxSteps.
    const provider = new MockProvider([
      { text: '1. go', stopReason: 'end_turn' },
      ...Array.from({ length: 6 }, (_, i) => ({
        text: '',
        toolCalls: [{ type: 'tool_use' as const, id: `u${i}`, name: 'ghost_tool', input: {} }],
        stopReason: 'tool_use' as const,
      })),
    ]);
    const res = await new AgentEngine().run({
      taskId: 't7',
      prompt: 'do it',
      provider,
      tools: new InMemoryToolExecutor([]),
      controller: new RunController(),
      emit: () => undefined,
      budgets: { maxToolErrors: 2 },
    });
    expect(res.state).toBe('failed');
    expect(res.toolCalls).toBe(0); // unknown tools never executed
  });
});

describe('AgentEngine stop reasons', () => {
  const run = (responses: ConstructorParameters<typeof MockProvider>[0]) => {
    const events: AgentEvent[] = [];
    return new AgentEngine()
      .run({
        taskId: 'tsr',
        prompt: 'go',
        provider: new MockProvider(responses),
        tools: new InMemoryToolExecutor([]),
        controller: new RunController(),
        emit: (e) => {
          events.push(e);
        },
      })
      .then((res) => ({ res, events }));
  };

  it('fails on a refusal instead of reporting it as a completed answer', async () => {
    const { res, events } = await run([
      { text: '1. step', stopReason: 'end_turn' },
      { text: '', stopReason: 'refusal' },
    ]);
    expect(res.state).toBe('failed');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'final_output')).toBe(false);
  });

  it('fails on a max_tokens truncation instead of reporting the partial text as success', async () => {
    const { res, events } = await run([
      { text: '1. step', stopReason: 'end_turn' },
      { text: 'half a sentence that got cut o', stopReason: 'max_tokens' },
    ]);
    expect(res.state).toBe('failed');
    expect(events.some((e) => e.type === 'final_output')).toBe(false);
  });

  it('fails on an empty completion rather than emitting "Done"', async () => {
    const { res, events } = await run([
      { text: '1. step', stopReason: 'end_turn' },
      { text: '', stopReason: 'end_turn' },
    ]);
    expect(res.state).toBe('failed');
    expect(events.some((e) => e.type === 'final_output')).toBe(false);
  });

  it('resumes on pause_turn instead of terminating', async () => {
    const { res } = await run([
      { text: '1. step', stopReason: 'end_turn' },
      { text: 'thinking...', stopReason: 'pause_turn' },
      { text: 'the final answer', stopReason: 'end_turn' },
    ]);
    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('the final answer');
  });

  it('does not emit the final text twice (no duplicate message + final_output)', async () => {
    const { events } = await run([
      { text: '1. step', stopReason: 'end_turn' },
      { text: 'unique-final-text', stopReason: 'end_turn' },
    ]);
    const finalish = events.filter(
      (e) =>
        (e.type === 'message' && e.text === 'unique-final-text') ||
        (e.type === 'final_output' && e.summary === 'unique-final-text'),
    );
    expect(finalish).toHaveLength(1);
    expect(finalish[0]?.type).toBe('final_output');
  });

  it('compacts long histories so the context window stays bounded, then still completes', async () => {
    // A provider that drives many tool steps before answering, and serves the compaction summary call
    // (distinguished by its "compress" system prompt). It records the largest message-history length
    // the MAIN act loop ever sees — compaction (which runs before each act call) must keep it bounded.
    class LongRunProvider implements LlmProvider {
      readonly model = 'mock';
      step = 0;
      summaryCalls = 0;
      maxMainMessages = 0;
      constructor(private readonly toolSteps: number) {}
      async complete(req: LlmRequest): Promise<LlmResponse> {
        const usage: LlmUsage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        const base = { usage, costUsd: 0, model: this.model };
        if (req.system?.includes('compress')) {
          this.summaryCalls += 1;
          return { text: '- progress so far\n- keep going', toolCalls: [], stopReason: 'end_turn', ...base };
        }
        this.maxMainMessages = Math.max(this.maxMainMessages, req.messages.length);
        this.step += 1;
        if (this.step <= this.toolSteps) {
          return {
            text: '',
            toolCalls: [{ type: 'tool_use', id: `u${this.step}`, name: 'noop', input: {} }],
            stopReason: 'tool_use',
            ...base,
          };
        }
        return { text: 'All done.', toolCalls: [], stopReason: 'end_turn', ...base };
      }
      async countTokens(): Promise<number> {
        return 1;
      }
    }

    const provider = new LongRunProvider(25);
    const tools = new InMemoryToolExecutor([tool('noop', 'low', false, () => ({ ok: true, output: { ok: 1 } }))]);
    const res = await new AgentEngine().run({
      taskId: 'long1',
      prompt: 'a long task',
      provider,
      tools,
      controller: new RunController(),
      skipPlanning: true,
      budgets: { maxSteps: 30, maxToolErrors: 50 },
      emit: () => {},
    });

    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('All done.');
    // Compaction fired at least once and kept the act-loop history at/under the trigger threshold.
    expect(provider.summaryCalls).toBeGreaterThanOrEqual(1);
    expect(provider.maxMainMessages).toBeLessThanOrEqual(40);
  });

  it('token-aware trigger: compacts on high input tokens BEFORE the 40-message failsafe (COMPACTION)', async () => {
    // Every main-loop prompt reports a LARGE input-token count (50k) against a small test budget (10k). With
    // only ~10 tool steps the history never reaches COMPACT_AT_MESSAGES (40), so a message-count-only engine
    // would NEVER compact here — if compaction fires, it is unambiguously the TOKEN trigger.
    class HeavyPromptProvider implements LlmProvider {
      readonly model = 'mock';
      step = 0;
      summaryCalls = 0;
      maxMainMessages = 0;
      msgsAtFirstSummary = -1;
      constructor(private readonly toolSteps: number) {}
      async complete(req: LlmRequest): Promise<LlmResponse> {
        if (req.system?.includes('compress')) {
          this.summaryCalls += 1;
          if (this.msgsAtFirstSummary < 0) this.msgsAtFirstSummary = this.maxMainMessages;
          const usage: LlmUsage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
          return { text: '- did stuff', toolCalls: [], stopReason: 'end_turn', usage, costUsd: 0, model: this.model };
        }
        this.maxMainMessages = Math.max(this.maxMainMessages, req.messages.length);
        this.step += 1;
        const usage: LlmUsage = { inputTokens: 50_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        const base = { usage, costUsd: 0, model: this.model };
        if (this.step <= this.toolSteps) {
          return { text: '', toolCalls: [{ type: 'tool_use', id: `u${this.step}`, name: 'noop', input: {} }], stopReason: 'tool_use', ...base };
        }
        return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', ...base };
      }
      async countTokens(): Promise<number> {
        return 50_000;
      }
    }

    const provider = new HeavyPromptProvider(10);
    const tools = new InMemoryToolExecutor([tool('noop', 'low', false, () => ({ ok: true, output: { ok: 1 } }))]);
    const res = await new AgentEngine().run({
      taskId: 'tok1',
      prompt: 'a heavy task',
      provider,
      tools,
      controller: new RunController(),
      skipPlanning: true,
      compactAtTokens: 10_000, // budget below the provider's 50k/turn -> token trigger fires early
      budgets: { maxSteps: 20, maxToolErrors: 50 },
      emit: () => {},
    });

    expect(res.state).toBe('completed');
    expect(res.finalText).toBe('Done.');
    expect(provider.summaryCalls).toBeGreaterThanOrEqual(1); // compaction fired despite < 40 messages
    expect(provider.msgsAtFirstSummary).toBeLessThan(40); // ...via the TOKEN trigger, not the failsafe
  });

  it('PRE-CALL guard: big tool_results compact BEFORE the next call overflows (reactive usage stays low)', async () => {
    // ChatGPT's catch: resp.usage.inputTokens is REACTIVE (the previous request). If a turn appends a large
    // tool_result, the NEXT request can overflow before the reactive trigger sees it. Here the provider
    // ALWAYS reports a tiny inputTokens (100) and the history never reaches 40 messages — so neither the
    // reactive trigger nor the message-count failsafe can fire. The big tool_results inflate the CURRENT
    // prompt, so only the PRE-CALL guard (approxPromptTokens) can trigger compaction.
    class LowUsageBigResultProvider implements LlmProvider {
      readonly model = 'mock';
      step = 0;
      summaryCalls = 0;
      maxMainMessages = 0;
      maxReportedInputTokens = 0;
      constructor(private readonly toolSteps: number) {}
      async complete(req: LlmRequest): Promise<LlmResponse> {
        if (req.system?.includes('compress')) {
          this.summaryCalls += 1;
          const usage: LlmUsage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
          return { text: '- did stuff', toolCalls: [], stopReason: 'end_turn', usage, costUsd: 0, model: this.model };
        }
        this.maxMainMessages = Math.max(this.maxMainMessages, req.messages.length);
        this.step += 1;
        // Deliberately UNDER-report usage so the reactive trigger can never fire — only the pre-call estimate can.
        const usage: LlmUsage = { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        this.maxReportedInputTokens = Math.max(this.maxReportedInputTokens, usage.inputTokens);
        const base = { usage, costUsd: 0, model: this.model };
        if (this.step <= this.toolSteps) {
          return { text: '', toolCalls: [{ type: 'tool_use', id: `u${this.step}`, name: 'big', input: {} }], stopReason: 'tool_use', ...base };
        }
        return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', ...base };
      }
      async countTokens(): Promise<number> {
        return 100;
      }
    }

    const provider = new LowUsageBigResultProvider(16); // 16 steps -> ~33 messages, below the 40 failsafe
    const bigOutput = 'x'.repeat(3000); // ~3000 chars/tool_result -> the prompt inflates fast
    const tools = new InMemoryToolExecutor([tool('big', 'low', false, () => ({ ok: true, output: { data: bigOutput } }))]);
    const res = await new AgentEngine().run({
      taskId: 'pre1',
      prompt: 'a task with large tool outputs',
      provider,
      tools,
      controller: new RunController(),
      skipPlanning: true,
      compactAtTokens: 8_000, // ~32k chars -> crossed by the accumulating big results
      budgets: { maxSteps: 30, maxToolErrors: 50 },
      emit: () => {},
    });

    expect(res.state).toBe('completed');
    expect(provider.maxReportedInputTokens).toBe(100); // reactive trigger COULD never fire (always < budget)
    expect(provider.maxMainMessages).toBeLessThan(40); // message-count failsafe COULD never fire
    expect(provider.summaryCalls).toBeGreaterThanOrEqual(1); // => only the PRE-CALL guard compacted
  });

  it('COST-ATTRIBUTION: usageByModel attributes per ANSWERING model on a multi-model run', async () => {
    // A routing-like provider that answers as a different model on each call. Usage/cost must attribute to
    // the model that actually answered, not a single default.
    class RoutingishProvider implements LlmProvider {
      readonly model = 'default-profile';
      n = 0;
      async complete(): Promise<LlmResponse> {
        this.n += 1;
        const model = this.n === 1 ? 'model-a' : 'model-b';
        const usage: LlmUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
        if (this.n === 1) {
          return { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], stopReason: 'tool_use', usage, costUsd: 0.01, model };
        }
        return { text: 'done', toolCalls: [], stopReason: 'end_turn', usage, costUsd: 0.02, model };
      }
      async countTokens(): Promise<number> {
        return 1;
      }
    }
    const res = await new AgentEngine().run({
      taskId: 'ca1', prompt: 'go', provider: new RoutingishProvider(), skipPlanning: true,
      tools: new InMemoryToolExecutor([tool('noop', 'low', false, () => ({ ok: true, output: {} }))]),
      controller: new RunController(), emit: () => {},
    });
    expect(res.state).toBe('completed');
    expect(res.usageByModel).toBeDefined();
    expect(Object.keys(res.usageByModel!).sort()).toEqual(['model-a', 'model-b']);
    expect(res.usageByModel!['model-a']!.calls).toBe(1);
    expect(res.usageByModel!['model-b']!.calls).toBe(1);
    expect(res.usageByModel!['model-a']!.costUsd).toBeCloseTo(0.01, 6);
    expect(res.usageByModel!['model-b']!.costUsd).toBeCloseTo(0.02, 6);
    // per-model costs reconcile with the cumulative total
    const sum = Object.values(res.usageByModel!).reduce((s, m) => s + m.costUsd, 0);
    expect(sum).toBeCloseTo(res.usage.costUsd, 6);
  });

  it('COST-ATTRIBUTION: a single-model run OMITS usageByModel (byte-identical)', async () => {
    class SoloProvider implements LlmProvider {
      readonly model = 'solo';
      async complete(): Promise<LlmResponse> {
        return { text: 'answer', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, model: 'solo' };
      }
      async countTokens(): Promise<number> {
        return 1;
      }
    }
    const res = await new AgentEngine().run({
      taskId: 'ca2', prompt: 'go', provider: new SoloProvider(), skipPlanning: true,
      tools: new InMemoryToolExecutor([]), controller: new RunController(), emit: () => {},
    });
    expect(res.state).toBe('completed');
    expect(res.usageByModel).toBeUndefined(); // one model -> field absent (no behavior change)
  });

  it('compaction never breaks tool_use<->tool_result pairing (multi-tool turns)', async () => {
    // Validates the central correctness property of compaction: at EVERY act-loop call, the message
    // history is structurally valid for the Anthropic API — every tool_use has its matching
    // tool_result and vice-versa (no orphan from the splice/snap), even with 2 tool calls per turn.
    class PairingProvider implements LlmProvider {
      readonly model = 'mock';
      step = 0;
      summaryCalls = 0;
      readonly violations: string[] = [];
      constructor(private readonly toolSteps: number) {}
      async complete(req: LlmRequest): Promise<LlmResponse> {
        const usage: LlmUsage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        const base = { usage, costUsd: 0, model: this.model };
        if (req.system?.includes('compress')) {
          this.summaryCalls += 1;
          return { text: '- did things', toolCalls: [], stopReason: 'end_turn', ...base };
        }
        // Structural check on the history handed to the model.
        const uses = new Set<string>();
        const results = new Set<string>();
        let prevRole = '';
        for (const m of req.messages) {
          if (m.role === prevRole) this.violations.push(`consecutive ${m.role}`);
          prevRole = m.role;
          if (typeof m.content === 'string') continue;
          for (const b of m.content) {
            if (b.type === 'tool_use') uses.add(b.id);
            if (b.type === 'tool_result') results.add(b.toolUseId);
          }
        }
        for (const r of results) if (!uses.has(r)) this.violations.push(`orphan tool_result ${r}`);
        for (const u of uses) if (!results.has(u)) this.violations.push(`unmatched tool_use ${u}`);

        this.step += 1;
        if (this.step <= this.toolSteps) {
          return {
            text: '',
            toolCalls: [
              { type: 'tool_use', id: `u${this.step}a`, name: 'noop', input: {} },
              { type: 'tool_use', id: `u${this.step}b`, name: 'noop', input: {} },
            ],
            stopReason: 'tool_use',
            ...base,
          };
        }
        return { text: 'Done.', toolCalls: [], stopReason: 'end_turn', ...base };
      }
      async countTokens(): Promise<number> {
        return 1;
      }
    }

    const provider = new PairingProvider(20);
    const tools = new InMemoryToolExecutor([tool('noop', 'low', false, () => ({ ok: true, output: {} }))]);
    const res = await new AgentEngine().run({
      taskId: 'pair1',
      prompt: 'long multi-tool task',
      provider,
      tools,
      controller: new RunController(),
      skipPlanning: true,
      budgets: { maxSteps: 30, maxToolErrors: 50 },
      emit: () => {},
    });

    expect(provider.summaryCalls).toBeGreaterThanOrEqual(1); // compaction did run
    expect(provider.violations).toEqual([]); // …and never produced an invalid message sequence
    expect(res.state).toBe('completed');
  });
});
