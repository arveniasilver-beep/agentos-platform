import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { loadServerEnv } from '@agentos/config';
import {
  AnthropicProvider,
  OpenAiCompatProvider,
  MockProvider,
  RoutingProvider,
  validateRouteConfig,
  deprecationWarning,
  getModel,
  type LlmProvider,
  type ChatProviderConfig,
  type ConsultableProvider,
} from '@agentos/llm';
import { assertAllowedUrl } from '@agentos/tools';
import { SecretsService } from '../secrets/secrets.service';

/**
 * Builds the LLM provider for a run. In `mock` mode it returns a scripted, network-free provider so
 * the engine runs without a key (e2e/CI). In `live` mode it decrypts the workspace's stored
 * Anthropic key (server-only — the plaintext key never crosses an HTTP boundary).
 */
@Injectable()
export class LlmProviderFactory {
  private readonly logger = new Logger(LlmProviderFactory.name);
  constructor(private readonly secrets: SecretsService) {}

  /** Fail fast (400) if the workspace can't run live: no brain configured (Anthropic key OR an
   * OpenAI-compatible chat provider). No-op in mock mode. */
  async ensureConfigured(workspaceId: string): Promise<void> {
    const env = loadServerEnv();
    if (env.LLM_MODE === 'mock') return;
    // Model Router (TICKET-10): if enabled + a route config is stored, it takes precedence — validate it
    // here so a broken route table fails fast at the pre-run gate (mirrors forWorkspace).
    if (env.MODEL_ROUTER_ENABLED) {
      const raw = await this.secrets.getModelRouteConfig(workspaceId);
      if (raw) {
        const v = validateRouteConfig(raw);
        if (!v.ok) throw new BadRequestException(`Model route config is invalid: ${v.errors.join('; ')}`);
        return;
      }
    }
    // Mirror forWorkspace/buildFromConfig exactly, so the pre-run gate and the builder never disagree.
    const chat = await this.secrets.getChatProviderConfig(workspaceId);
    if (chat) {
      if (chat.provider === 'openai' && chat.apiKey && chat.baseUrl) return;
      if (chat.provider === 'anthropic') {
        if (chat.apiKey) return;
        if ((await this.secrets.getLlmKeyInfo(workspaceId)).configured) return;
      }
      throw new BadRequestException(
        'The selected model provider is incomplete. Check Settings → Model brain provider.',
      );
    }
    const info = await this.secrets.getLlmKeyInfo(workspaceId);
    if (!info.configured) {
      throw new BadRequestException(
        'No model provider is configured for this workspace. Add one in Settings before running tasks.',
      );
    }
  }

  async forWorkspace(workspaceId: string): Promise<LlmProvider> {
    const env = loadServerEnv();
    if (env.LLM_MODE === 'mock') {
      return new MockProvider([
        { text: '1. Analyze the request\n2. Produce the answer', stopReason: 'end_turn' },
        { text: 'Task completed in mock mode.', stopReason: 'end_turn' },
      ]);
    }

    // Model Router (TICKET-10): when enabled + configured, route across named profiles with fallback.
    if (env.MODEL_ROUTER_ENABLED) {
      const routed = await this.tryBuildRouter(workspaceId);
      if (routed) return routed;
    }

    // A workspace may select an OpenAI-compatible brain (DeepSeek, a local vLLM serving MiMo, …);
    // otherwise fall back to the default Anthropic provider (unchanged behaviour).
    const chat = await this.secrets.getChatProviderConfig(workspaceId);
    if (chat) return this.buildFromConfig(workspaceId, chat);

    const apiKey = await this.secrets.getDecryptedLlmKey(workspaceId);
    if (!apiKey) {
      throw new BadRequestException(
        'No model provider is configured for this workspace. Add one in Settings before running tasks.',
      );
    }
    return new AnthropicProvider({ apiKey });
  }

  /**
   * Build a ConsultableProvider (one-shot ask, incl. vision) from a stored config — used for the
   * "peer" second brain. Same SSRF guard + key resolution as the primary brain.
   */
  buildConsultable(workspaceId: string, config: ChatProviderConfig): Promise<ConsultableProvider> {
    return this.buildFromConfig(workspaceId, config);
  }

  /**
   * Build a RoutingProvider from the workspace's stored model_route_config, or null if none is stored.
   * Each named profile is built via the SAME buildFromConfig (so the OpenAI-compat SSRF guard + key
   * resolution apply to every profile, failing fast at build time). An invalid route table is a hard 400.
   */
  private async tryBuildRouter(workspaceId: string): Promise<LlmProvider | null> {
    const raw = await this.secrets.getModelRouteConfig(workspaceId);
    if (!raw) return null;
    const v = validateRouteConfig(raw);
    if (!v.ok || !v.config) throw new BadRequestException(`Model route config is invalid: ${v.errors.join('; ')}`);
    const cfg = v.config;
    const providers: Record<string, LlmProvider> = {};
    for (const [name, profile] of Object.entries(cfg.profiles)) {
      providers[name] = await this.buildFromConfig(workspaceId, profile);
    }
    return new RoutingProvider(cfg, providers);
  }

  private async buildFromConfig(
    workspaceId: string,
    chat: ChatProviderConfig,
  ): Promise<AnthropicProvider | OpenAiCompatProvider> {
    // Model-agnostic lifecycle check (Model Registry): warn for ANY deprecated model id — DeepSeek's
    // legacy ids, or any future family's. The brain still runs; the operator is told the faithful upgrade.
    const dep = deprecationWarning(chat.model);
    if (dep) this.logger.warn(dep);
    if (chat.provider === 'openai') {
      if (!chat.apiKey || !chat.baseUrl) {
        throw new BadRequestException('OpenAI-compatible provider needs an API key and base URL.');
      }
      // The provider POSTs the decrypted key to this admin-set baseUrl, so SSRF-guard it like media/
      // embeddings. A LOCAL endpoint (self-hosted vLLM/MiMo) is intended, so private/loopback hosts are
      // allowed ONLY when the operator opts in via ALLOW_LOCAL_BRAIN_URL (fail-closed by default).
      try {
        await assertAllowedUrl(chat.baseUrl, { allowPrivate: loadServerEnv().ALLOW_LOCAL_BRAIN_URL });
      } catch (err) {
        throw new BadRequestException(
          `Brain baseUrl is not allowed: ${err instanceof Error ? err.message : String(err)}. ` +
            'For a local model server, set ALLOW_LOCAL_BRAIN_URL=true.',
        );
      }
      // Cost metering (COST-PRICING): user-supplied pricing wins; otherwise fall back to the model
      // registry so a known brain (e.g. deepseek-v4-flash -> 0.14/0.28 per MTok) meters at real cost
      // instead of $0. An unknown / self-hosted model with no registry row and no user pricing stays
      // 0/0 (correct — we don't invent a price for a model we don't recognize).
      const modelId = chat.model ?? 'gpt-4o-mini';
      const userPricing =
        chat.inputPerMTok !== undefined && chat.outputPerMTok !== undefined
          ? { inputPerMTok: chat.inputPerMTok, outputPerMTok: chat.outputPerMTok }
          : undefined;
      const pricing = userPricing ?? getModel(modelId)?.pricing;
      return new OpenAiCompatProvider({
        apiKey: chat.apiKey,
        baseUrl: chat.baseUrl,
        model: modelId,
        ...(pricing ? { pricing } : {}),
      });
    }
    // provider === 'anthropic': prefer the config's own key, else the stored llm_api_key.
    const apiKey = chat.apiKey ?? (await this.secrets.getDecryptedLlmKey(workspaceId));
    if (!apiKey) throw new BadRequestException('No Anthropic API key configured.');
    return new AnthropicProvider({ apiKey, ...(chat.model ? { model: chat.model } : {}) });
  }
}
