import { describe, it, expect } from 'vitest';
import { OpenAiCompatProvider, type FetchLike } from './openai-compat-provider';

function capture(): { calls: { url: string; body: unknown }[]; fetchImpl: FetchLike } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      text: async () => '',
    };
  };
  return { calls, fetchImpl };
}

describe('OpenAiCompatProvider', () => {
  it('maps system + messages and reports usage/cost', async () => {
    const { calls, fetchImpl } = capture();
    const p = new OpenAiCompatProvider({
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com/',
      model: 'deepseek-chat',
      pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      fetchImpl,
    });
    const r = await p.complete({ system: 'be brief', messages: [{ role: 'user', content: 'hello' }] });
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    const body = calls[0]!.body as { model: string; messages: { role: string; content: string }[] };
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(r.text).toBe('hi there');
    expect(r.stopReason).toBe('end_turn');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // cost = (10*1 + 5*2)/1e6
    expect(r.costUsd).toBeCloseTo((10 * 1 + 5 * 2) / 1_000_000, 12);
  });

  it('sends tools and parses tool_calls into tool_use blocks', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      text: async () => '',
    });
    const p = new OpenAiCompatProvider({ apiKey: 'k', baseUrl: 'http://localhost:8000/v1', model: 'm', fetchImpl });
    const r = await p.complete({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'web_search', description: 'search', inputSchema: { type: 'object', properties: {} } }],
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ type: 'tool_use', id: 'c1', name: 'web_search', input: { q: 'x' } }]);
  });

  it('converts assistant tool_use + user tool_result into OpenAI tool_calls + role:tool messages', async () => {
    const { calls, fetchImpl } = capture();
    const p = new OpenAiCompatProvider({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm', fetchImpl });
    await p.complete({
      messages: [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 't', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'u1', content: '{"ok":true}' }] },
      ],
    });
    const msgs = (calls[0]!.body as { messages: unknown[] }).messages as Record<string, unknown>[];
    // user, assistant(with tool_calls), tool(result)
    expect(msgs[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'u1', function: { name: 't' } }] });
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'u1', content: '{"ok":true}' });
  });

  it('marks an errored tool_result so the model can tell failures from successes', async () => {
    const { calls, fetchImpl } = capture();
    const p = new OpenAiCompatProvider({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm', fetchImpl });
    await p.complete({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'u1', content: 'denied by user', isError: true }] },
      ],
    });
    const msgs = (calls[0]!.body as { messages: Record<string, unknown>[] }).messages;
    expect(msgs.find((m) => m.role === 'tool')).toEqual({
      role: 'tool',
      tool_call_id: 'u1',
      content: '[ERROR] denied by user',
    });
  });

  it('ask() sends a one-shot question with an image as a data: image_url part', async () => {
    const { calls, fetchImpl } = capture();
    const p = new OpenAiCompatProvider({ apiKey: 'k', baseUrl: 'http://mimo/v1', model: 'mimo-vl', fetchImpl });
    const r = await p.ask('What is in this image?', {
      system: 'You are MiMo, describe precisely.',
      image: { base64: 'AAAA', mimeType: 'image/png' },
    });
    const body = calls[0]!.body as { messages: { role: string; content: unknown }[] };
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are MiMo, describe precisely.' });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(r.text).toBe('hi there');
    expect(r.model).toBe('mimo-vl');
  });

  it('ask() without an image sends a plain string user message', async () => {
    const { calls, fetchImpl } = capture();
    const p = new OpenAiCompatProvider({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'deepseek-chat', fetchImpl });
    await p.ask('2+2?');
    const body = calls[0]!.body as { messages: { role: string; content: unknown }[] };
    expect(body.messages[0]).toEqual({ role: 'user', content: '2+2?' });
  });

  it('ask() throws when the peer returns a 200 with empty content (no silent empty answer)', async () => {
    const p = new OpenAiCompatProvider({
      apiKey: 'k',
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
        text: async () => '',
      }),
    });
    await expect(p.ask('hi')).rejects.toThrow(/no usable content \(finish_reason=content_filter\)/);
  });

  it('throws on a non-ok response', async () => {
    const p = new OpenAiCompatProvider({
      apiKey: 'k',
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'nope' }),
    });
    await expect(p.complete({ messages: [{ role: 'user', content: 'h' }] })).rejects.toThrow(/failed \(401\)/);
  });
});
