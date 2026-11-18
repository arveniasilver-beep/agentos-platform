import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import { ToolRegistryExecutor, type RuntimeTool } from './runtime';

const echo: RuntimeTool = {
  definition: defineTool({
    id: 'echo',
    name: 'echo',
    description: 'echo back the input',
    inputSchema: z.object({ msg: z.string() }),
    outputSchema: z.object({ msg: z.string() }),
    riskLevel: 'low',
  }),
  run: (input) => input,
};

const slow: RuntimeTool = {
  definition: defineTool({
    id: 'slow',
    name: 'slow',
    description: 'never resolves',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    riskLevel: 'low',
    timeoutMs: 20,
  }),
  run: () => new Promise(() => undefined),
};

describe('ToolRegistryExecutor', () => {
  it('runs a tool with valid input', async () => {
    const exec = new ToolRegistryExecutor([echo]);
    const r = await exec.execute('echo', { msg: 'hi' });
    expect(r.ok).toBe(true);
    expect((r.output as { msg: string }).msg).toBe('hi');
  });

  it('rejects invalid input against the Zod schema', async () => {
    const exec = new ToolRegistryExecutor([echo]);
    const r = await exec.execute('echo', { wrong: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid input');
  });

  it('returns an error for an unknown tool', async () => {
    const exec = new ToolRegistryExecutor([echo]);
    const r = await exec.execute('nope', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown tool');
  });

  it('enforces the per-tool timeout', async () => {
    const exec = new ToolRegistryExecutor([slow]);
    const r = await exec.execute('slow', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out');
  });

  it('lists risk-tagged descriptors with JSON-schema inputs', () => {
    const exec = new ToolRegistryExecutor([echo]);
    const [d] = exec.list();
    expect(d?.name).toBe('echo');
    expect(d?.riskLevel).toBe('low');
    expect((d?.inputSchema as { type?: string }).type).toBe('object');
  });

  it('throws on duplicate registration', () => {
    const exec = new ToolRegistryExecutor([echo]);
    expect(() => exec.register(echo)).toThrow(/already registered/);
  });
});
