import type { ToolDefinition } from './tool';

/** In-memory registry of tools, keyed by id. The agent engine routes tool calls through this. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }
    this.tools.set(tool.id, tool);
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  get(id: string): ToolDefinition {
    const tool = this.tools.get(id);
    if (!tool) {
      throw new Error(`Unknown tool: ${id}`);
    }
    return tool;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Validate raw tool input against the tool's Zod schema, returning the parsed value. */
  validateInput(id: string, input: unknown): unknown {
    return this.get(id).inputSchema.parse(input);
  }
}
