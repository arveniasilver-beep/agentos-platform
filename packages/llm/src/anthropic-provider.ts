import Anthropic from '@anthropic-ai/sdk';
import { computeCostUsd, OPUS_4_8_PRICING } from './cost';
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

/** Default model — the brief mandates Claude Opus 4.8. */
export const DEFAULT_MODEL = 'claude-opus-4-8';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
}

function toAnthropicMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    const content = m.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
    });
    return { role: m.role, content };
  });
}

function toAnthropicTools(tools: LlmToolDef[]): unknown[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

function mapStopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
    case 'pause_turn':
      return reason;
    default:
      return 'other';
  }
}

/** Anthropic implementation of LlmProvider. Uses adaptive thinking + the effort parameter. */
export class AnthropicProvider implements LlmProvider, ConsultableProvider {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  /**
   * One-shot Q&A, optionally with an image (Claude is multimodal). Used for peer consultation.
   * Uses LOW effort: adaptive thinking shares the max_tokens budget, so a high-effort one-shot with a
   * modest cap can spend the whole budget on thinking and emit no text. Low effort + a generous default
   * keeps the answer from being truncated to empty; an empty result is surfaced as an error, not ''.
   */
  async ask(question: string, opts?: AskOptions): Promise<AskResult> {
    const content: unknown[] = [];
    if (opts?.image) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: opts.image.mimeType, data: opts.image.base64 },
      });
    }
    content.push({ type: 'text', text: question });
    const body = {
      model: this.model,
      max_tokens: opts?.maxTokens ?? 8000,
      output_config: { effort: 'low' },
      thinking: { type: 'adaptive' },
      ...(opts?.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content }],
    };
    const res = (await this.client.messages.create(
      body as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
    )) as Anthropic.Messages.Message;
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text.trim() === '') {
      throw new Error(`peer returned no usable content (stop_reason=${res.stop_reason ?? 'none'})`);
    }
    const usage: LlmUsage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      text,
      model: this.model,
      costUsd: computeCostUsd(usage, OPUS_4_8_PRICING),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Prompt caching (Ticket-09): the system prompt + the full tool set are large and RE-SENT on every
    // step of a run, yet identical each time. Mark them with an ephemeral cache breakpoint so Anthropic
    // serves them from cache (cache-read is ~10x cheaper than fresh input) instead of re-billing the whole
    // prefix every step. cacheRead/Write tokens are already read back + priced (computeCostUsd). Additive:
    // an endpoint that ignores cache_control is unaffected.
    const tools = req.tools && req.tools.length > 0 ? toAnthropicTools(req.tools) : undefined;
    if (tools && tools.length > 0) {
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      output_config: { effort: req.effort ?? 'high' },
      ...(req.thinking === false ? {} : { thinking: { type: 'adaptive' } }),
      ...(req.system ? { system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] } : {}),
      messages: toAnthropicMessages(req.messages),
      ...(tools ? { tools } : {}),
    };

    const res = (await this.client.messages.create(
      body as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
    )) as Anthropic.Messages.Message;

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const toolCalls: LlmToolUseBlock[] = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ type: 'tool_use', id: b.id, name: b.name, input: b.input }));

    const usage: LlmUsage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };

    return {
      text,
      toolCalls,
      stopReason: mapStopReason(res.stop_reason),
      usage,
      costUsd: computeCostUsd(usage, OPUS_4_8_PRICING),
      model: this.model,
    };
  }

  async countTokens(req: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): Promise<number> {
    const body = {
      model: this.model,
      ...(req.system ? { system: req.system } : {}),
      messages: toAnthropicMessages(req.messages),
      ...(req.tools && req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
    };
    const res = await this.client.messages.countTokens(
      body as unknown as Anthropic.Messages.MessageCountTokensParams,
    );
    return res.input_tokens;
  }
}
