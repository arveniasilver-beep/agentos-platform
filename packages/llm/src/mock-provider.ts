import { computeCostUsd, OPUS_4_8_PRICING } from './cost';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmToolUseBlock,
  LlmStopReason,
  LlmUsage,
  LlmMessage,
  LlmToolDef,
} from './types';

export interface MockScript {
  text?: string;
  toolCalls?: LlmToolUseBlock[];
  stopReason?: LlmStopReason;
}

function estimateTokens(req: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): number {
  let chars = (req.system ?? '').length;
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else {
      for (const b of m.content) {
        if (b.type === 'text') chars += b.text.length;
        else if (b.type === 'tool_use') chars += b.name.length + JSON.stringify(b.input).length;
        else chars += b.content.length;
      }
    }
  }
  for (const t of req.tools ?? []) {
    chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Deterministic, network-free provider for tests. Returns scripted responses in order (repeating
 * the last script once exhausted) and records every request it received.
 */
export class MockProvider implements LlmProvider {
  readonly model = 'mock-model';
  readonly calls: LlmRequest[] = [];
  private readonly scripts: MockScript[];
  private index = 0;

  constructor(scripts: MockScript[] = [{ text: 'ok', stopReason: 'end_turn' }]) {
    this.scripts = scripts.length > 0 ? scripts : [{ text: 'ok', stopReason: 'end_turn' }];
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const script = this.scripts[Math.min(this.index, this.scripts.length - 1)] as MockScript;
    this.index += 1;

    const text = script.text ?? '';
    const toolCalls = script.toolCalls ?? [];
    const stopReason: LlmStopReason = script.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn');

    const usage: LlmUsage = {
      inputTokens: estimateTokens(req),
      outputTokens: Math.max(1, Math.ceil(text.length / 4)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    return {
      text,
      toolCalls,
      stopReason,
      usage,
      costUsd: computeCostUsd(usage, OPUS_4_8_PRICING),
      model: this.model,
    };
  }

  async countTokens(req: Pick<LlmRequest, 'system' | 'messages' | 'tools'>): Promise<number> {
    return estimateTokens(req);
  }
}

export type { LlmMessage, LlmToolDef };
