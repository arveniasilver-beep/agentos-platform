import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import { ToolRegistryExecutor, type RuntimeTool } from './runtime';

function makeTool(run: (input: unknown) => unknown, opts?: { idempotent?: boolean; version?: string }): RuntimeTool {
  return {
    definition: defineTool({
      id: 'probe',
      name: 'probe',
      description: 'test tool',
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ y: z.number() }),
      riskLevel: 'low',
      ...(opts?.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
      ...(opts?.version ? { version: opts.version } : {}),
    }),
    run,
  };
}

describe('ToolRegistryExecutor hardening (TICKET-2)', () => {
  beforeEach(() => {
    delete process.env.TOOL_EXEC_HARDENING_ENABLED;
  });
  afterEach(() => {
    delete process.env.TOOL_EXEC_HARDENING_ENABLED;
  });

  it('defineTool defaults version to "1" and idempotent to false; list() surfaces them', () => {
    const exec = new ToolRegistryExecutor([makeTool(() => ({ y: 1 }))]);
    const d = exec.list()[0]!;
    expect(d.version).toBe('1');
    expect(d.idempotent).toBe(false);
  });

  it('flag OFF: malformed output passes through unchanged (byte-identical legacy behavior)', async () => {
    const exec = new ToolRegistryExecutor([makeTool(() => ({ wrong: 'shape' }))]);
    const r = await exec.execute('probe', { x: 1 });
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ wrong: 'shape' }); // not validated when flag is off
  });

  it('flag ON: output violating the schema becomes a controlled tool_error', async () => {
    process.env.TOOL_EXEC_HARDENING_ENABLED = 'true';
    const exec = new ToolRegistryExecutor([makeTool(() => ({ wrong: 'shape' }))]);
    const r = await exec.execute('probe', { x: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/output schema validation failed/);
  });

  it('flag ON: valid output is returned (and parsed)', async () => {
    process.env.TOOL_EXEC_HARDENING_ENABLED = 'true';
    const exec = new ToolRegistryExecutor([makeTool(() => ({ y: 42 }))]);
    const r = await exec.execute('probe', { x: 1 });
    expect(r).toMatchObject({ ok: true, output: { y: 42 } });
  });

  it('flag ON + idempotent: a repeated identical call is served from cache (no re-run)', async () => {
    process.env.TOOL_EXEC_HARDENING_ENABLED = 'true';
    let runs = 0;
    const exec = new ToolRegistryExecutor([makeTool(() => { runs += 1; return { y: runs }; }, { idempotent: true })]);
    const r1 = await exec.execute('probe', { x: 7 });
    const r2 = await exec.execute('probe', { x: 7 });
    expect(runs).toBe(1); // second call did NOT re-execute
    expect(r1.output).toEqual({ y: 1 });
    expect(r2.output).toEqual({ y: 1 });
    expect(r2.cached).toBe(true);
    // different input still executes
    const r3 = await exec.execute('probe', { x: 8 });
    expect(runs).toBe(2);
    expect(r3.cached).toBeUndefined();
  });

  it('flag ON + non-idempotent: repeated calls always re-execute (no caching)', async () => {
    process.env.TOOL_EXEC_HARDENING_ENABLED = 'true';
    let runs = 0;
    const exec = new ToolRegistryExecutor([makeTool(() => { runs += 1; return { y: runs }; }, { idempotent: false })]);
    await exec.execute('probe', { x: 1 });
    await exec.execute('probe', { x: 1 });
    expect(runs).toBe(2);
  });

  it('input validation + unknown tool behave the same regardless of flag', async () => {
    const exec = new ToolRegistryExecutor([makeTool(() => ({ y: 1 }))]);
    expect((await exec.execute('probe', { x: 'no' })).ok).toBe(false); // bad input
    expect((await exec.execute('nope', {})).error).toMatch(/unknown tool/);
  });
});
