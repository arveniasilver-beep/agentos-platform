import { computeCostUsd, type ModelPricing } from './cost';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmMessage,
  LlmToolDef,
  LlmToolUseBlock,
  LlmUsage,
  LlmStopReason,
  ConsultableProvider,
  AskOptions,
  AskResult,
} from './types';

/**
 * OpenAI-compatible chat provider — works against any server that speaks the OpenAI
 * /chat/completions API: DeepSeek's hosted API, a local vLLM/Ollama/llama.cpp serving MiMo, Together,
 * etc. Sits ALONGSIDE the Anthropic provider (no changes there); a workspace selects which brain to
 * use. Handles the Anthropic-shaped <-> OpenAI-shaped conversion (tool_use/tool_result <-> tool_calls
 * + role:'tool' messages). Fully injectable (fetchImpl) so it is unit-testable without a server.
 */

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export interface OpenAiCompatOptions {
  apiKey: string;
  /** Base URL of the OpenAI-compatible server (e.g. https://api.deepseek.com, http://localhost:8000/v1). */
  baseUrl: string;
  model: string;
  /** Optional pricing for cost metering (USD per 1M tokens); omit for self-hosted/free. */
  pricing?: Pick<ModelPricing, 'inputPerMTok' | 'outputPerMTok'>;
  fetchImpl?: FetchLike;
}

interface OpenAiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/** Flatten our Anthropic-shaped messages into OpenAI's (tool_result blocks become role:'tool' msgs). */
function toOpenAiMessages(system: string | undefined, messages: LlmMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: OpenAiToolCall[] = [];
    const toolResults: OpenAiMessage[] = [];
    for (const b of m.content) {
      if (b.type === 'text') textParts.push(b.text);
      else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      } else {
        // tool_result -> a separate role:'tool' message referencing the call id. OpenAI's tool role
        // has no is_error field, so mark failures inline (Anthropic forwards is_error) — otherwise the
        // model can't tell a denied/failed call from a successful one.
        toolResults.push({
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.isError ? `[ERROR] ${b.content}` : b.content,
        });
      }
    }
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: textParts.length ? textParts.join('') : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // A user turn: emit the tool results first (they answer the previous assistant tool_calls),
      // then any free user text.
      out.push(...toolResults);
      if (textParts.length) out.push({ role: 'user', content: textParts.join('') });
    }
  }
  return out;
}

function toOpenAiTools(tools: LlmToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function mapFinishReason(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function estimateTokens(req: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): number {
  let chars = (req.system ?? '').length;
  for (const m of req.messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  chars += (req.tools ?? []).reduce((n, t) => n + JSON.stringify(t).length, 0);
  return Math.ceil(chars / 4);
}

interface ChatCompletionJson {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatProvider implements LlmProvider, ConsultableProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly pricing: Pick<ModelPricing, 'inputPerMTok' | 'outputPerMTok'>;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenAiCompatOptions) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.pricing = opts.pricing ?? { inputPerMTok: 0, outputPerMTok: 0 };
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async request(body: Record<string, unknown>): Promise<ChatCompletionJson> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`chat completion failed (${res.status}): ${t.slice(0, 300)}`);
    }
    return (await res.json()) as ChatCompletionJson;
  }

  private costOf(json: ChatCompletionJson): { usage: LlmUsage; costUsd: number } {
    const usage: LlmUsage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return { usage, costUsd: computeCostUsd(usage, { ...this.pricing, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }) };
  }

  /**
   * One-shot Q&A, optionally with an image (vision). For an OpenAI-compatible multimodal server
   * (e.g. MiMo-VL via vLLM) the image is sent as a data: image_url part. Used for peer consultation.
   */
  async ask(question: string, opts?: AskOptions): Promise<AskResult> {
    const userContent: unknown = opts?.image
      ? [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:${opts.image.mimeType};base64,${opts.image.base64}` } },
        ]
      : question;
    const messages: unknown[] = [];
    if (opts?.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: userContent });
    const json = await this.request({ model: this.model, messages, max_tokens: opts?.maxTokens ?? 4096 });
    const { usage, costUsd } = this.costOf(json);
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? '';
    // A 200 with empty/filtered/truncated content would otherwise look like a successful empty answer
    // to the caller (the brain). Surface it as an error so the consultation fails loudly instead.
    if (text.trim() === '') {
      throw new Error(`peer returned no usable content (finish_reason=${choice?.finish_reason ?? 'none'})`);
    }
    return { text, model: this.model, costUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(req.system, req.messages),
      max_tokens: req.maxTokens ?? 8192,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = toOpenAiTools(req.tools);
      body.tool_choice = 'auto';
    }
    const json = await this.request(body);
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? '';
    const toolCalls: LlmToolUseBlock[] = (choice?.message?.tool_calls ?? []).map((tc) => ({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: safeJson(tc.function.arguments),
    }));
    const { usage, costUsd } = this.costOf(json);
    // A model that emitted tool calls but reported finish_reason 'stop' (some servers do) is still a
    // tool-use turn for the engine.
    const stopReason = toolCalls.length > 0 ? 'tool_use' : mapFinishReason(choice?.finish_reason);
    return {
      text,
      toolCalls,
      stopReason,
      usage,
      costUsd,
      model: this.model,
    };
  }

  countTokens(req: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): Promise<number> {
    // No universal count endpoint across OpenAI-compatible servers — estimate.
    return Promise.resolve(estimateTokens(req));
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
