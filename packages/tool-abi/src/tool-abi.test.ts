import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool, toLlmToolSchema, ToolRegistry } from './index';

const webSearch = defineTool({
  id: 'web_search',
  name: 'web_search',
  description: 'Search the web for a query.',
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).optional(),
  }),
  outputSchema: z.object({ results: z.array(z.string()) }),
  riskLevel: 'low',
  permissions: ['web.search'],
});

const deleteFiles = defineTool({
  id: 'fs_delete',
  name: 'fs_delete',
  description: 'Delete files in an approved folder.',
  inputSchema: z.object({ path: z.string().min(1) }),
  outputSchema: z.object({ deleted: z.boolean() }),
  riskLevel: 'critical',
  permissions: ['fs.write'],
});

describe('defineTool', () => {
  it('defaults approvalRequired from the risk level', () => {
    expect(webSearch.approvalRequired).toBe(false);
    expect(deleteFiles.approvalRequired).toBe(true);
  });

  it('applies default timeout and retry policy', () => {
    expect(webSearch.timeoutMs).toBe(30_000);
    expect(webSearch.retry.maxAttempts).toBe(2);
  });
});

describe('ToolRegistry', () => {
  it('registers, finds and lists tools', () => {
    const reg = new ToolRegistry();
    reg.register(webSearch);
    reg.register(deleteFiles);
    expect(reg.has('web_search')).toBe(true);
    expect(reg.get('fs_delete').riskLevel).toBe('critical');
    expect(reg.list()).toHaveLength(2);
  });

  it('throws on duplicate id', () => {
    const reg = new ToolRegistry();
    reg.register(webSearch);
    expect(() => reg.register(webSearch)).toThrow(/already registered/);
  });

  it('throws on unknown id', () => {
    const reg = new ToolRegistry();
    expect(() => reg.get('nope')).toThrow(/Unknown tool/);
  });

  it('validates input against the tool schema', () => {
    const reg = new ToolRegistry();
    reg.register(webSearch);
    expect(reg.validateInput('web_search', { query: 'hi' })).toEqual({ query: 'hi' });
    expect(() => reg.validateInput('web_search', { query: '' })).toThrow();
    expect(() => reg.validateInput('web_search', {})).toThrow();
  });
});

describe('toLlmToolSchema (zod <-> json-schema parity)', () => {
  it('derives an Anthropic-shaped tool schema from the same Zod source', () => {
    const schema = toLlmToolSchema(webSearch);
    expect(schema.name).toBe('web_search');
    expect(schema.input_schema.type).toBe('object');

    const props = schema.input_schema.properties as Record<string, unknown>;
    expect(props.query).toBeDefined();
    expect(props.limit).toBeDefined();

    // The model-facing `required` matches the Zod-required keys (query required, limit optional).
    expect(schema.input_schema.required).toEqual(['query']);
  });
});
