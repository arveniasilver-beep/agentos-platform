import { describe, it, expect } from 'vitest';
import { MockProvider } from '@agentos/llm';
import type { AgentEvent } from '@agentos/protocol';
import { AgentEngine, type EnginePolicyDecision } from './engine';
import { RunController } from './controller';
import { InMemoryToolExecutor, type InMemoryTool } from './tool-runtime';

function tool(name: string, opts: Partial<InMemoryTool['descriptor']>, onRun: () => void): InMemoryTool {
  return {
    descriptor: { name, description: name, inputSchema: { type: 'object', properties: {} }, riskLevel: 'low', approvalRequired: false, ...opts },
    handler: () => { onRun(); return { ok: true, output: { ok: 1 } }; },
  };
}
const callToolThenAnswer = (toolName: string) => [
  { text: '1. act', stopReason: 'end_turn' as const },
  { text: '', toolCalls: [{ type: 'tool_use' as const, id: 'u1', name: toolName, input: {} }], stopReason: 'tool_use' as const },
  { text: 'done', stopReason: 'end_turn' as const },
];

describe('AgentEngine policy hook', () => {
  it('policy deny → tool NOT executed, tool_result is a policy denial', async () => {
    let runs = 0;
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't1', prompt: 'go', provider: new MockProvider(callToolThenAnswer('x')),
      tools: new InMemoryToolExecutor([tool('x', {}, () => { runs += 1; })]),
      controller: new RunController(), emit: (e) => { events.push(e); },
      policy: async () => ({ effect: 'deny', reason: 'blocked by test' }),
    });
    expect(res.state).toBe('completed'); // the model recovered and answered
    expect(runs).toBe(0); // tool never ran
    expect(events.find((e) => e.type === 'approval_request')).toBeUndefined();
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr && 'error' in tr ? tr.error : '').toContain('denied by policy');
  });

  it('policy require_approval → approval requested; runs on approve', async () => {
    let runs = 0;
    const ctl = new RunController();
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't1', prompt: 'go', provider: new MockProvider(callToolThenAnswer('x')),
      tools: new InMemoryToolExecutor([tool('x', {}, () => { runs += 1; })]),
      controller: ctl,
      emit: (e) => { events.push(e); if (e.type === 'approval_request') ctl.decideApproval(e.approvalId, 'approve'); },
      policy: async () => ({ effect: 'require_approval', reason: 'needs ok', detail: { tool: 'x', requestedScopes: [], riskReason: 'needs ok', elevated: false } }),
    });
    expect(res.state).toBe('completed');
    expect(runs).toBe(1); // ran after approval
    const ar = events.find((e) => e.type === 'approval_request');
    expect(ar && 'detail' in ar ? ar.detail?.riskReason : '').toBe('needs ok');
  });

  it('SECURITY: a high-risk tool ALWAYS requires approval even at ceiling=high; a medium tool does not', async () => {
    // The bug: gate was `risk > ceiling`, so with the real-world default task ceiling `high`, a high-risk
    // action (shell exec / deploy / sub-agent spawn) slipped through ungated (high > high = false).
    let highRuns = 0;
    const ctl = new RunController();
    const hev: AgentEvent[] = [];
    const r1 = await new AgentEngine().run({
      taskId: 't', prompt: 'go', riskCeiling: 'high', provider: new MockProvider(callToolThenAnswer('danger')),
      tools: new InMemoryToolExecutor([tool('danger', { riskLevel: 'high' }, () => { highRuns += 1; })]),
      controller: ctl,
      emit: (e) => { hev.push(e); if (e.type === 'approval_request') ctl.decideApproval(e.approvalId, 'approve'); },
    });
    expect(r1.state).toBe('completed');
    expect(hev.some((e) => e.type === 'approval_request')).toBe(true); // GATED (the fix)
    expect(highRuns).toBe(1); // ran only after approval

    // A routine medium tool is NOT over-gated at the same ceiling.
    const mev: AgentEvent[] = [];
    await new AgentEngine().run({
      taskId: 't2', prompt: 'go', riskCeiling: 'high', provider: new MockProvider(callToolThenAnswer('routine')),
      tools: new InMemoryToolExecutor([tool('routine', { riskLevel: 'medium' }, () => undefined)]),
      controller: new RunController(), emit: (e) => { mev.push(e); },
    });
    expect(mev.find((e) => e.type === 'approval_request')).toBeUndefined(); // NOT gated
  });

  it('legacy approvalRequired is NOT relaxed by a policy allow', async () => {
    const ctl = new RunController();
    let approvals = 0; let runs = 0;
    await new AgentEngine().run({
      taskId: 't1', prompt: 'go', provider: new MockProvider(callToolThenAnswer('danger')),
      tools: new InMemoryToolExecutor([tool('danger', { riskLevel: 'high', approvalRequired: true }, () => { runs += 1; })]),
      controller: ctl,
      emit: (e) => { if (e.type === 'approval_request') { approvals += 1; ctl.decideApproval(e.approvalId, 'approve'); } },
      policy: async () => ({ effect: 'allow', reason: 'policy says fine' }), // policy allow, legacy approvalRequired
    });
    expect(approvals).toBe(1); // legacy approval still enforced (merge = more restrictive)
    expect(runs).toBe(1);
  });

  it('require_elevated_approval emits detail.elevated = true', async () => {
    const ctl = new RunController();
    let elevated: boolean | undefined;
    await new AgentEngine().run({
      taskId: 't1', prompt: 'go', provider: new MockProvider(callToolThenAnswer('x')),
      tools: new InMemoryToolExecutor([tool('x', {}, () => {})]),
      controller: ctl,
      emit: (e) => { if (e.type === 'approval_request') { elevated = e.detail?.elevated; ctl.decideApproval(e.approvalId, 'approve'); } },
      policy: async () => ({ effect: 'require_elevated_approval', reason: 'rm -rf', detail: { tool: 'x', requestedScopes: [], riskReason: 'rm -rf', elevated: true } }),
    });
    expect(elevated).toBe(true);
  });

  it('deny loop → run fails after maxPolicyDenials', async () => {
    // The model keeps calling the (denied) tool; MockProvider repeats the last script.
    const provider = new MockProvider([
      { text: '1. act', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u', name: 'x', input: {} }], stopReason: 'tool_use' },
    ]);
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't1', prompt: 'go', provider,
      tools: new InMemoryToolExecutor([tool('x', {}, () => {})]),
      controller: new RunController(), emit: (e) => { events.push(e); },
      budgets: { maxSteps: 12, maxToolErrors: 4, maxPolicyDenials: 2 },
      policy: async () => ({ effect: 'deny', reason: 'always no' }),
    });
    expect(res.state).toBe('failed');
    expect(events.some((e) => e.type === 'error' && 'message' in e && e.message.includes('policy-denied'))).toBe(true);
  });

  it('no policy callback → legacy behavior unchanged (low-risk tool runs without approval)', async () => {
    let runs = 0;
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't1', prompt: 'go', provider: new MockProvider(callToolThenAnswer('x')),
      tools: new InMemoryToolExecutor([tool('x', {}, () => { runs += 1; })]),
      controller: new RunController(), emit: (e) => { events.push(e); },
    });
    expect(res.state).toBe('completed');
    expect(runs).toBe(1);
    expect(events.find((e) => e.type === 'approval_request')).toBeUndefined();
  });

  it('RESILIENCE: a TRANSIENT provider error (429) is retried, then the run recovers', async () => {
    let calls = 0;
    const flaky = {
      model: 'flaky',
      async complete() {
        calls += 1;
        if (calls === 1) {
          const e = new Error('rate limited') as Error & { status: number };
          e.status = 429;
          throw e;
        }
        return { text: 'recovered answer', toolCalls: [], stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, model: 'flaky' };
      },
      async countTokens() { return 1; },
    };
    const events: AgentEvent[] = [];
    const res = await new AgentEngine().run({
      taskId: 't', prompt: 'go', skipPlanning: true, provider: flaky as never,
      tools: new InMemoryToolExecutor([]), controller: new RunController(), emit: (e) => { events.push(e); },
    });
    expect(res.state).toBe('completed'); // recovered instead of dying
    expect(calls).toBe(2); // retried once after the 429
    expect(res.finalText).toBe('recovered answer');
    expect(events.some((e) => e.type === 'error' && 'recoverable' in e && e.recoverable === true)).toBe(true); // surfaced the retry
  });
});
