import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { requiresApproval, type RiskLevel } from '@agentos/protocol';

/** Capability scopes a tool may require; enforced by the permission system. */
export const PERMISSION_SCOPES = [
  'web.read',
  'web.search',
  'fs.read',
  'fs.write',
  'shell.exec',
  'net.request',
  'browser.control',
  'llm.call',
  'task.spawn',
  'knowledge.read',
] as const;
export const permissionScopeSchema = z.enum(PERMISSION_SCOPES);
export type PermissionScope = z.infer<typeof permissionScopeSchema>;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

/** A registered agent tool. Input/output are Zod schemas (single source for type + validation). */
export interface ToolDefinition<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  id: string;
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  riskLevel: RiskLevel;
  permissions: PermissionScope[];
  approvalRequired: boolean;
  timeoutMs: number;
  retry: RetryPolicy;
  /** Tool implementation version (TICKET-2) — recorded in the trace so a tool's behavior change is
   * attributable. Defaults to '1'. */
  version: string;
  /** Whether re-running this tool with the same input is side-effect-free (TICKET-2). When true, the
   * hardened executor may serve a cached result for a duplicate call instead of re-executing. */
  idempotent: boolean;
}

export interface DefineToolInput<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  id: string;
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  riskLevel: RiskLevel;
  permissions?: PermissionScope[];
  approvalRequired?: boolean;
  timeoutMs?: number;
  retry?: RetryPolicy;
  version?: string;
  idempotent?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 2, backoffMs: 500 };

/** Build a fully-resolved ToolDefinition, defaulting approval from the risk level. */
export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: DefineToolInput<I, O>,
): ToolDefinition<I, O> {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    riskLevel: def.riskLevel,
    permissions: def.permissions ?? [],
    approvalRequired: def.approvalRequired ?? requiresApproval(def.riskLevel),
    timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: def.retry ?? DEFAULT_RETRY,
    version: def.version ?? '1',
    idempotent: def.idempotent ?? false,
  };
}

/** The tool shape the LLM consumes for tool/function calling (Anthropic-style). */
export interface LlmToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Convert a tool's Zod input schema to the JSON Schema the model sees. Because the same Zod
 * schema drives runtime validation, the model-facing contract and what we accept never drift.
 */
export function toLlmToolSchema(tool: ToolDefinition): LlmToolSchema {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = jsonSchema;
  return { name: tool.name, description: tool.description, input_schema: rest };
}
