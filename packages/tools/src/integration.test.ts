import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@agentos/llm';
import { AgentEngine, RunController } from '@agentos/agent-engine';
import type { AgentEvent } from '@agentos/protocol';
import { ToolRegistryExecutor } from './runtime';
import { createFsTools } from './fs-tools';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aos-int-'));
  await writeFile(join(root, 'data.txt'), 'the secret is 1234', 'utf8');
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('agent engine + tool registry integration', () => {
  it('reads a real file through the full stack and completes', async () => {
    const provider = new MockProvider([
      { text: '1. read the file\n2. report', stopReason: 'end_turn' },
      { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'fs_read', input: { path: 'data.txt' } }], stopReason: 'tool_use' },
      { text: 'The file says: the secret is 1234', stopReason: 'end_turn' },
    ]);
    const tools = new ToolRegistryExecutor(createFsTools({ root }));
    const events: AgentEvent[] = [];

    const res = await new AgentEngine().run({
      taskId: 'int1',
      prompt: 'read data.txt and report its contents',
      provider,
      tools,
      controller: new RunController(),
      emit: (e) => {
        events.push(e);
      },
    });

    expect(res.state).toBe('completed');
    expect(res.toolCalls).toBe(1);

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.type === 'tool_result' && toolResult.ok).toBe(true);
    // the real fs_read output flowed back through the engine
    expect(JSON.stringify(toolResult)).toContain('the secret is 1234');
  });
});
