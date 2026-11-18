import { describe, it, expect } from 'vitest';
import { MockProvider } from './mock-provider';

describe('MockProvider', () => {
  it('returns scripted responses in order, then repeats the last', async () => {
    const provider = new MockProvider([
      {
        text: '',
        toolCalls: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'x' } }],
        stopReason: 'tool_use',
      },
      { text: 'done', stopReason: 'end_turn' },
    ]);

    const r1 = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r1.stopReason).toBe('tool_use');
    expect(r1.toolCalls[0]?.name).toBe('web_search');

    const r2 = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r2.stopReason).toBe('end_turn');
    expect(r2.text).toBe('done');

    const r3 = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r3.text).toBe('done'); // repeats last

    expect(provider.calls).toHaveLength(3);
  });

  it('computes usage and cost and reports its model', async () => {
    const provider = new MockProvider([{ text: 'hello world', stopReason: 'end_turn' }]);
    const r = await provider.complete({ messages: [{ role: 'user', content: 'hi there' }] });
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
    expect(r.model).toBe('mock-model');
  });

  it('countTokens returns a positive estimate', async () => {
    const provider = new MockProvider();
    const n = await provider.countTokens({ messages: [{ role: 'user', content: 'some text here' }] });
    expect(n).toBeGreaterThan(0);
  });
});
