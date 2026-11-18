// Model Registry — a declarative catalog of the model families AgentOS can use as a brain. The point is
// a SOLID, model-AGNOSTIC architecture: the engine codes against LlmProvider, the provider impls are
// generic (AnthropicProvider for Claude; OpenAiCompatProvider for ANY OpenAI-compatible endpoint —
// DeepSeek, a local vLLM serving MiMo / Qwen, Together, …), and this registry is the single source of
// truth for which models exist, what they can do, their pricing, their endpoints, and their deprecations.
// Nothing here is DeepSeek-specific; DeepSeek is just one family among many.

export type ModelFamily = 'anthropic' | 'deepseek' | 'mimo' | 'qwen' | 'openai-compat';

export interface ModelCapabilities {
  /** multi-turn chat */
  chat: boolean;
  /** function / tool calling (agent loop) */
  tools: boolean;
  /** extended reasoning / thinking mode */
  reasoning: boolean;
  /** multimodal image input */
  vision: boolean;
}

export interface ModelInfo {
  /** the exact model id sent to the provider */
  id: string;
  family: ModelFamily;
  /** which LlmProvider implementation serves it */
  provider: 'anthropic' | 'openai';
  label: string;
  capabilities: ModelCapabilities;
  /** USD per 1M tokens (optional; OpenAiCompatProvider can override) */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  /** Total context window in tokens (optional). The engine derives its token-aware compaction trigger
   * from this (≈0.6×window); unknown/self-hosted models fall back to a conservative constant. Use a
   * documented FLOOR — undershooting compacts a little early (safe), overshooting risks overflow. */
  contextWindowTokens?: number;
  /** default OpenAI-compatible base URL (public providers). Local families (MiMo/Qwen via vLLM) require
   * the operator to supply their own baseUrl — `requiresBaseUrl: true`. */
  defaultBaseUrl?: string;
  requiresBaseUrl?: boolean;
  /** lifecycle: when set, the id is going away — surface a warning + the faithful replacement. */
  deprecated?: { on: string; replacement: string; note?: string };
}

const cap = (o: Partial<ModelCapabilities>): ModelCapabilities => ({ chat: true, tools: false, reasoning: false, vision: false, ...o });

/**
 * The catalog. Add a model = add a row (declarative). Sources: Anthropic + DeepSeek public docs; MiMo
 * (Xiaomi) + Qwen are self-hosted via an OpenAI-compatible server (vLLM), so they require a baseUrl.
 */
export const MODEL_REGISTRY: ModelInfo[] = [
  // ---- Anthropic (Claude) ----
  { id: 'claude-opus-4-8', family: 'anthropic', provider: 'anthropic', label: 'Claude Opus 4.8', capabilities: cap({ tools: true, reasoning: true, vision: true }), contextWindowTokens: 200_000 },
  { id: 'claude-sonnet-4-6', family: 'anthropic', provider: 'anthropic', label: 'Claude Sonnet 4.6', capabilities: cap({ tools: true, reasoning: true, vision: true }), contextWindowTokens: 200_000 },
  { id: 'claude-haiku-4-5-20251001', family: 'anthropic', provider: 'anthropic', label: 'Claude Haiku 4.5', capabilities: cap({ tools: true, vision: true }), contextWindowTokens: 200_000 },

  // ---- DeepSeek (public, OpenAI-compatible) ----
  { id: 'deepseek-v4-flash', family: 'deepseek', provider: 'openai', label: 'DeepSeek V4 Flash', capabilities: cap({ tools: true, reasoning: true }), defaultBaseUrl: 'https://api.deepseek.com', pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 }, contextWindowTokens: 65_536 },
  { id: 'deepseek-v4-pro', family: 'deepseek', provider: 'openai', label: 'DeepSeek V4 Pro', capabilities: cap({ tools: true, reasoning: true }), defaultBaseUrl: 'https://api.deepseek.com', contextWindowTokens: 65_536 },
  // Legacy ids — both route to v4-flash (non-thinking / thinking). Deprecate 2026-07-24.
  // Legacy ids carry the SAME pricing as the v4-flash they map to — otherwise a workspace still on
  // 'deepseek-chat' meters at $0 (the real-world bug a user hit). 0.14/0.28 per MTok.
  { id: 'deepseek-chat', family: 'deepseek', provider: 'openai', label: 'DeepSeek Chat (legacy)', capabilities: cap({ tools: true }), defaultBaseUrl: 'https://api.deepseek.com', pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 }, deprecated: { on: '2026-07-24', replacement: 'deepseek-v4-flash', note: 'maps to v4-flash (non-thinking)' }, contextWindowTokens: 65_536 },
  { id: 'deepseek-reasoner', family: 'deepseek', provider: 'openai', label: 'DeepSeek Reasoner (legacy)', capabilities: cap({ tools: true, reasoning: true }), defaultBaseUrl: 'https://api.deepseek.com', pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 }, deprecated: { on: '2026-07-24', replacement: 'deepseek-v4-flash', note: 'maps to v4-flash (thinking)' }, contextWindowTokens: 65_536 },

  // ---- MiMo (Xiaomi) — self-hosted via vLLM (OpenAI-compatible). MiMo-VL is multimodal (vision peer). ----
  { id: 'mimo-vl', family: 'mimo', provider: 'openai', label: 'MiMo-VL (local vLLM)', capabilities: cap({ vision: true }), requiresBaseUrl: true },
  { id: 'mimo-7b', family: 'mimo', provider: 'openai', label: 'MiMo 7B (local vLLM)', capabilities: cap({ tools: true, reasoning: true }), requiresBaseUrl: true },

  // ---- Qwen — self-hosted via vLLM / Together (OpenAI-compatible). ----
  { id: 'qwen2.5-72b-instruct', family: 'qwen', provider: 'openai', label: 'Qwen2.5 72B Instruct (local)', capabilities: cap({ tools: true, reasoning: true }), requiresBaseUrl: true },

  // ---- Generic escape hatch: any other OpenAI-compatible endpoint the operator points at. ----
  { id: 'openai-compatible', family: 'openai-compat', provider: 'openai', label: 'Other OpenAI-compatible', capabilities: cap({ tools: true }), requiresBaseUrl: true },
];

const BY_ID = new Map(MODEL_REGISTRY.map((m) => [m.id, m]));

export function getModel(id: string): ModelInfo | undefined {
  return BY_ID.get(id);
}
export function listModels(family?: ModelFamily): ModelInfo[] {
  return family ? MODEL_REGISTRY.filter((m) => m.family === family) : MODEL_REGISTRY;
}

/** Model-AGNOSTIC deprecation check: works for ANY catalogued model, not just one family. Unknown ids
 * (a custom local model) are simply "not deprecated". */
export function modelDeprecation(id: string | undefined): { deprecated: boolean; on?: string; replacement?: string; note?: string } {
  const d = id ? BY_ID.get(id)?.deprecated : undefined;
  return d ? { deprecated: true, on: d.on, replacement: d.replacement, note: d.note } : { deprecated: false };
}

/** A human-readable, model-agnostic warning string (or null) for a configured model id. */
export function deprecationWarning(id: string | undefined): string | null {
  const d = modelDeprecation(id);
  if (!d.deprecated) return null;
  return `Model "${id}" is deprecated as of ${d.on} — switch to "${d.replacement}"${d.note ? ` (${d.note})` : ''}.`;
}
