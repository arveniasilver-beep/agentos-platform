import { toLlmToolSchema, type ToolDefinition } from '@agentos/tool-abi';
import type { ToolExecutor, ToolDescriptor, ToolExecutionResult } from '@agentos/agent-engine';

export interface RuntimeTool {
  definition: ToolDefinition;
  run: (input: unknown) => Promise<unknown> | unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tool timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Implements the engine's ToolExecutor over tool-abi definitions: validates input against the
 * tool's Zod schema, enforces the per-tool timeout, and maps failures to a safe error result.
 */
/** TICKET-2: tool-execution hardening (output validation + idempotency cache) is opt-in; off =>
 * byte-identical legacy behavior (input validation + timeout only). */
function execHardened(): boolean {
  return process.env.TOOL_EXEC_HARDENING_ENABLED === 'true';
}

export class ToolRegistryExecutor implements ToolExecutor {
  private readonly tools = new Map<string, RuntimeTool>();
  // Per-executor idempotency cache (one executor == one task's tool set): an idempotent tool called
  // again with identical input returns the prior result instead of re-running (no duplicate side-effect).
  private readonly idempotencyCache = new Map<string, ToolExecutionResult>();

  constructor(tools: RuntimeTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: RuntimeTool): void {
    if (this.tools.has(tool.definition.id)) {
      throw new Error(`tool already registered: ${tool.definition.id}`);
    }
    this.tools.set(tool.definition.id, tool);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({
      name: t.definition.id,
      description: t.definition.description,
      inputSchema: toLlmToolSchema(t.definition).input_schema,
      riskLevel: t.definition.riskLevel,
      approvalRequired: t.definition.approvalRequired,
      permissions: t.definition.permissions, // TICKET-POLICY: carry scopes to the engine for enforcement
      version: t.definition.version, // TICKET-2: surface tool version in the trace
      idempotent: t.definition.idempotent,
    }));
  }

  async execute(name: string, input: unknown): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `unknown tool: ${name}` };
    }
    const parsed = tool.definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: `invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
    }
    const hardened = execHardened();
    // TICKET-2: serve a cached result for a repeated idempotent call (prevents duplicate side-effects).
    const cacheKey = hardened && tool.definition.idempotent ? `${name}:${stableKey(parsed.data)}` : null;
    if (cacheKey) {
      const hit = this.idempotencyCache.get(cacheKey);
      if (hit) return { ...hit, cached: true };
    }
    let result: ToolExecutionResult;
    try {
      const output = await withTimeout(Promise.resolve(tool.run(parsed.data)), tool.definition.timeoutMs);
      // TICKET-2: validate the output against the tool's declared schema (controlled tool_error on
      // violation) so a misbehaving tool can't feed malformed data back into the model.
      if (hardened) {
        const out = tool.definition.outputSchema.safeParse(output);
        if (!out.success) {
          return { ok: false, error: `tool output schema validation failed: ${out.error.issues.map((i) => i.message).join('; ')}` };
        }
        result = { ok: true, output: out.data };
      } else {
        result = { ok: true, output };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (cacheKey) this.idempotencyCache.set(cacheKey, result);
    return result;
  }
}

/** Stable stringify for the idempotency cache key (sorts object keys so call order doesn't matter). */
function stableKey(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = norm((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  };
  try {
    return JSON.stringify(norm(value));
  } catch {
    return String(value);
  }
}
