import type { RiskLevel } from '@agentos/protocol';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
  /** Force approval regardless of riskCeiling. */
  approvalRequired: boolean;
  /** Capability scopes the tool requires (TICKET-POLICY). Carried so the policy engine can enforce
   * them; optional so in-memory/test tools need not declare any. */
  permissions?: string[];
  /** Tool implementation version (TICKET-2) — surfaced in the tool_call event/trace. */
  version?: string;
  /** Whether the tool is safe to re-run with the same input (TICKET-2). */
  idempotent?: boolean;
}

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** TICKET-2: true when the hardened executor served this from its idempotency cache (no re-run). */
  cached?: boolean;
}

/** The engine routes tool calls through this. The real registry (Phase 2) implements it. */
export interface ToolExecutor {
  list(): ToolDescriptor[];
  execute(name: string, input: unknown): Promise<ToolExecutionResult>;
}

export interface InMemoryTool {
  descriptor: ToolDescriptor;
  handler: (input: unknown) => ToolExecutionResult | Promise<ToolExecutionResult>;
}

/** In-memory executor — used by tests and as a simple default. */
export class InMemoryToolExecutor implements ToolExecutor {
  private readonly descriptors: ToolDescriptor[];
  private readonly handlers = new Map<string, InMemoryTool['handler']>();

  constructor(tools: InMemoryTool[]) {
    this.descriptors = tools.map((t) => t.descriptor);
    for (const t of tools) this.handlers.set(t.descriptor.name, t.handler);
  }

  list(): ToolDescriptor[] {
    return this.descriptors;
  }

  async execute(name: string, input: unknown): Promise<ToolExecutionResult> {
    const handler = this.handlers.get(name);
    if (!handler) return { ok: false, error: `unknown tool: ${name}` };
    return handler(input);
  }
}
