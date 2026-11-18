import { BadRequestException, Injectable } from '@nestjs/common';
import type { AskImage } from '@agentos/llm';
import { SecretsService } from '../secrets/secrets.service';
import { LlmProviderFactory } from '../tasks/llm-provider.factory';

/** System prompt that frames the peer as a consulted specialist, not a chat partner. */
const PEER_SYSTEM =
  'You are a specialist AI model being consulted by another AI agent (not a human). Answer the ' +
  "question directly, precisely, and concisely — your reply is fed back into the agent's reasoning. " +
  'If an image is attached, describe or analyse exactly what is asked, including any text, numbers, ' +
  'layout, or details relevant to the question. Do not add pleasantries.';

/** System prompt for the debate/critique mode — frames the peer as a rigorous adversarial reviewer. */
const PEER_CRITIC_SYSTEM =
  'You are a rigorous, independent reviewer consulted by another AI agent. Adversarially critique the ' +
  'draft you are given: identify factual errors, weak or unsupported assumptions, missing cases, ' +
  'security/correctness risks, and anything you genuinely disagree with — do not rubber-stamp it. ' +
  'Then propose a concrete, stronger alternative. Be specific and concise; your critique is fed back ' +
  "into the agent's reasoning. If an image is attached, ground your critique in what it actually shows.";

export interface ConsultOpts {
  image?: AskImage;
  critic?: boolean;
}

export interface PeerAnswer {
  answer: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Cross-model peer consultation. A workspace's primary brain (e.g. DeepSeek) can consult a configured
 * "peer" model (e.g. MiMo-VL) for a one-shot question — optionally passing an image the peer reads.
 * This is how a text-only brain gains vision: it hands the image to the multimodal peer and reasons
 * over the returned description. The peer config is decrypted server-side; the key never leaves here.
 */
@Injectable()
export class PeerService {
  constructor(
    private readonly secrets: SecretsService,
    private readonly factory: LlmProviderFactory,
  ) {}

  /** A usable peer is configured (openai needs key+baseUrl; anthropic needs a key here or the stored one). */
  async hasPeer(workspaceId: string): Promise<boolean> {
    const cfg = await this.secrets.getPeerProviderConfig(workspaceId);
    if (!cfg) return false;
    return cfg.provider === 'openai' ? !!cfg.apiKey && !!cfg.baseUrl : !!cfg.apiKey;
  }

  /** Display name of the peer model (for the consult_peer tool description), or null if none. */
  async peerName(workspaceId: string): Promise<string | null> {
    const cfg = await this.secrets.getPeerProviderConfig(workspaceId);
    if (!cfg) return null;
    return cfg.model ?? (cfg.provider === 'openai' ? 'peer model' : 'Claude');
  }

  async consult(workspaceId: string, question: string, opts?: ConsultOpts): Promise<PeerAnswer> {
    const cfg = await this.secrets.getPeerProviderConfig(workspaceId);
    if (!cfg) throw new BadRequestException('No peer model is configured for this workspace.');
    const provider = await this.factory.buildConsultable(workspaceId, cfg);
    const res = await provider.ask(question, {
      system: opts?.critic ? PEER_CRITIC_SYSTEM : PEER_SYSTEM,
      // Generous caps: with adaptive thinking sharing the budget, a tight cap can truncate to empty.
      maxTokens: opts?.critic ? 8000 : 4096,
      ...(opts?.image ? { image: opts.image } : {}),
    });
    return {
      answer: res.text,
      model: res.model,
      costUsd: res.costUsd,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    };
  }
}
