export type LlmRole = 'user' | 'assistant';

export interface LlmTextBlock {
  type: 'text';
  text: string;
}
export interface LlmToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface LlmToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}
export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock;

export interface LlmMessage {
  role: LlmRole;
  content: string | LlmContentBlock[];
}

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LlmEffort = 'low' | 'medium' | 'high' | 'max';

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  maxTokens?: number;
  effort?: LlmEffort;
  /** Adaptive thinking on/off (default on). */
  thinking?: boolean;
  /** Task capability mode (slides|document|website|chart|image|chat|…). Used by the Model Router to
   * route a request to a capability-appropriate profile (e.g. image → a vision model). Advisory only —
   * single-provider setups ignore it. */
  capability?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolUseBlock[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  costUsd: number;
  model: string;
}

/** Per-workspace "brain" selection: Anthropic (default) or any OpenAI-compatible server
 * (DeepSeek, a local vLLM serving MiMo, Together, …). Stored encrypted; key never leaves the server. */
export interface ChatProviderConfig {
  provider: 'anthropic' | 'openai';
  apiKey?: string;
  /** OpenAI-compatible base URL (required when provider==='openai'). */
  baseUrl?: string;
  model?: string;
  /** Optional cost metering (USD per 1M tokens). */
  inputPerMTok?: number;
  outputPerMTok?: number;
}

/** Provider abstraction the agent engine codes against. Anthropic is the default implementation. */
export interface LlmProvider {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  countTokens(req: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): Promise<number>;
}

/** A base64 image to hand to a multimodal model (e.g. MiMo-VL) for a one-shot vision question. */
export interface AskImage {
  base64: string;
  mimeType: string;
}
export interface AskOptions {
  system?: string;
  image?: AskImage;
  maxTokens?: number;
}
export interface AskResult {
  text: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}
/**
 * A one-shot Q&A capability (optionally with an image), used for cross-model "peer consultation":
 * one brain asks the other a single question and gets a single answer. Both AnthropicProvider and
 * OpenAiCompatProvider implement this in addition to LlmProvider. Distinct from the full agent loop
 * (complete) — no tools, no multi-turn state.
 */
export interface ConsultableProvider {
  readonly model: string;
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
}
