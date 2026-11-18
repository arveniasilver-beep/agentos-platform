import { Injectable } from '@nestjs/common';
import type { EmbeddingsConfig, ImageConfig, SpeechConfig, ChatProviderConfig, ModelRouteConfig } from '@agentos/llm';
import type { SecretType } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';

export interface LlmKeyInfo {
  configured: boolean;
  lastFour: string | null;
  provider: string | null;
}

export interface EmbeddingsInfo {
  configured: boolean;
  provider: string | null;
  model: string | null;
  lastFour: string | null;
}

/** Shared shape for provider-config secrets (embeddings / image / speech). */
export type ProviderConfigInfo = EmbeddingsInfo;

/** A provider config that carries an optional key + provider/model for the lastFour/info display. */
interface ProviderConfigLike {
  // All optional: most configs have a single provider/apiKey/model, but a model_route_config (TICKET-10)
  // is a route table with its keys nested inside per-profile entries (encrypted in the ciphertext; no
  // top-level apiKey, so lastFour is null — nothing leaks).
  provider?: string;
  apiKey?: string;
  model?: string;
}

/** Workspace secrets vault. The LLM key is stored envelope-encrypted; only lastFour is renderable. */
@Injectable()
export class SecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async setLlmKey(
    workspaceId: string,
    userId: string,
    apiKey: string,
    provider: string,
  ): Promise<LlmKeyInfo> {
    const enc = this.crypto.encrypt(apiKey);
    // Replace any existing LLM key for the workspace.
    await this.prisma.secret.deleteMany({ where: { workspaceId, type: 'llm_api_key' } });
    const secret = await this.prisma.secret.create({
      data: {
        workspaceId,
        type: 'llm_api_key',
        label: `${provider} API key`,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        wrappedDataKey: enc.wrappedDataKey,
        kmsKeyId: this.crypto.keyId,
        lastFour: enc.lastFour,
        createdByUserId: userId,
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'secret.set',
      targetType: 'secret',
      targetId: secret.id,
      risk: 'high',
      metadata: { provider },
    });
    return { configured: true, lastFour: secret.lastFour, provider };
  }

  async getLlmKeyInfo(workspaceId: string): Promise<LlmKeyInfo> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type: 'llm_api_key' },
      orderBy: { createdAt: 'desc' },
      select: { lastFour: true },
    });
    if (!secret) {
      return { configured: false, lastFour: null, provider: null };
    }
    return { configured: true, lastFour: secret.lastFour, provider: 'anthropic' };
  }

  /** SERVER-ONLY: decrypt the key for the agent engine. Never exposed over HTTP. */
  async getDecryptedLlmKey(workspaceId: string): Promise<string | null> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type: 'llm_api_key' },
      orderBy: { createdAt: 'desc' },
    });
    if (!secret) {
      return null;
    }
    return this.crypto.decrypt({
      ciphertext: Buffer.from(secret.ciphertext),
      iv: Buffer.from(secret.iv),
      authTag: Buffer.from(secret.authTag),
      wrappedDataKey: Buffer.from(secret.wrappedDataKey),
    });
  }

  async deleteLlmKey(workspaceId: string, userId: string): Promise<LlmKeyInfo> {
    const { count } = await this.prisma.secret.deleteMany({
      where: { workspaceId, type: 'llm_api_key' },
    });
    if (count > 0) {
      await this.audit.record({
        workspaceId,
        actorUserId: userId,
        action: 'secret.delete',
        targetType: 'secret',
        risk: 'critical',
      });
    }
    return { configured: false, lastFour: null, provider: null };
  }

  // ---- Embeddings provider config (provider + key + model, for knowledge/RAG) ----

  async setEmbeddingsConfig(
    workspaceId: string,
    userId: string,
    config: EmbeddingsConfig,
  ): Promise<EmbeddingsInfo> {
    const enc = this.crypto.encrypt(JSON.stringify(config));
    await this.prisma.secret.deleteMany({ where: { workspaceId, type: 'embeddings_config' } });
    const lastFour = config.apiKey ? config.apiKey.slice(-4) : null;
    const secret = await this.prisma.secret.create({
      data: {
        workspaceId,
        type: 'embeddings_config',
        label: JSON.stringify({ provider: config.provider, model: config.model ?? null }),
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        wrappedDataKey: enc.wrappedDataKey,
        kmsKeyId: this.crypto.keyId,
        lastFour,
        createdByUserId: userId,
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'secret.set',
      targetType: 'secret',
      targetId: secret.id,
      risk: 'high',
      metadata: { kind: 'embeddings', provider: config.provider },
    });
    return { configured: true, provider: config.provider, model: config.model ?? null, lastFour };
  }

  async getEmbeddingsInfo(workspaceId: string): Promise<EmbeddingsInfo> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type: 'embeddings_config' },
      orderBy: { createdAt: 'desc' },
      select: { label: true, lastFour: true },
    });
    if (!secret) return { configured: false, provider: null, model: null, lastFour: null };
    let provider: string | null = null;
    let model: string | null = null;
    try {
      const l = JSON.parse(secret.label) as { provider?: string; model?: string };
      provider = l.provider ?? null;
      model = l.model ?? null;
    } catch {
      /* legacy label */
    }
    return { configured: true, provider, model, lastFour: secret.lastFour };
  }

  /** SERVER-ONLY: decrypt the embeddings config for the knowledge layer. Never exposed over HTTP. */
  async getEmbeddingsConfig(workspaceId: string): Promise<EmbeddingsConfig | null> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type: 'embeddings_config' },
      orderBy: { createdAt: 'desc' },
    });
    if (!secret) return null;
    const json = this.crypto.decrypt({
      ciphertext: Buffer.from(secret.ciphertext),
      iv: Buffer.from(secret.iv),
      authTag: Buffer.from(secret.authTag),
      wrappedDataKey: Buffer.from(secret.wrappedDataKey),
    });
    return JSON.parse(json) as EmbeddingsConfig;
  }

  async deleteEmbeddingsConfig(workspaceId: string, userId: string): Promise<EmbeddingsInfo> {
    const { count } = await this.prisma.secret.deleteMany({
      where: { workspaceId, type: 'embeddings_config' },
    });
    if (count > 0) {
      await this.audit.record({
        workspaceId,
        actorUserId: userId,
        action: 'secret.delete',
        targetType: 'secret',
        risk: 'high',
      });
    }
    return { configured: false, provider: null, model: null, lastFour: null };
  }

  // ---- Generic provider-config secrets (image / speech generation) ----

  private async setProviderConfig(
    workspaceId: string,
    userId: string,
    type: SecretType,
    config: ProviderConfigLike,
    kind: string,
  ): Promise<ProviderConfigInfo> {
    const enc = this.crypto.encrypt(JSON.stringify(config));
    await this.prisma.secret.deleteMany({ where: { workspaceId, type } });
    const lastFour = config.apiKey ? config.apiKey.slice(-4) : null;
    const secret = await this.prisma.secret.create({
      data: {
        workspaceId,
        type,
        label: JSON.stringify({ provider: config.provider ?? null, model: config.model ?? null }),
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        wrappedDataKey: enc.wrappedDataKey,
        kmsKeyId: this.crypto.keyId,
        lastFour,
        createdByUserId: userId,
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'secret.set',
      targetType: 'secret',
      targetId: secret.id,
      risk: 'high',
      metadata: { kind, provider: config.provider ?? null },
    });
    return { configured: true, provider: config.provider ?? null, model: config.model ?? null, lastFour };
  }

  private async getProviderInfo(workspaceId: string, type: SecretType): Promise<ProviderConfigInfo> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type },
      orderBy: { createdAt: 'desc' },
      select: { label: true, lastFour: true },
    });
    if (!secret) return { configured: false, provider: null, model: null, lastFour: null };
    let provider: string | null = null;
    let model: string | null = null;
    try {
      const l = JSON.parse(secret.label) as { provider?: string; model?: string };
      provider = l.provider ?? null;
      model = l.model ?? null;
    } catch {
      /* legacy label */
    }
    return { configured: true, provider, model, lastFour: secret.lastFour };
  }

  private async getProviderConfig<T>(workspaceId: string, type: SecretType): Promise<T | null> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type },
      orderBy: { createdAt: 'desc' },
    });
    if (!secret) return null;
    const json = this.crypto.decrypt({
      ciphertext: Buffer.from(secret.ciphertext),
      iv: Buffer.from(secret.iv),
      authTag: Buffer.from(secret.authTag),
      wrappedDataKey: Buffer.from(secret.wrappedDataKey),
    });
    return JSON.parse(json) as T;
  }

  private async deleteProviderConfig(
    workspaceId: string,
    userId: string,
    type: SecretType,
  ): Promise<ProviderConfigInfo> {
    const { count } = await this.prisma.secret.deleteMany({ where: { workspaceId, type } });
    if (count > 0) {
      await this.audit.record({
        workspaceId,
        actorUserId: userId,
        action: 'secret.delete',
        targetType: 'secret',
        risk: 'high',
      });
    }
    return { configured: false, provider: null, model: null, lastFour: null };
  }

  // Image generation config.
  setImageConfig(workspaceId: string, userId: string, config: ImageConfig): Promise<ProviderConfigInfo> {
    return this.setProviderConfig(workspaceId, userId, 'image_config', config, 'image');
  }
  getImageInfo(workspaceId: string): Promise<ProviderConfigInfo> {
    return this.getProviderInfo(workspaceId, 'image_config');
  }
  /** SERVER-ONLY: decrypt the image config for the media layer. Never exposed over HTTP. */
  getImageConfig(workspaceId: string): Promise<ImageConfig | null> {
    return this.getProviderConfig<ImageConfig>(workspaceId, 'image_config');
  }
  deleteImageConfig(workspaceId: string, userId: string): Promise<ProviderConfigInfo> {
    return this.deleteProviderConfig(workspaceId, userId, 'image_config');
  }

  // Speech (text-to-speech) config.
  setSpeechConfig(workspaceId: string, userId: string, config: SpeechConfig): Promise<ProviderConfigInfo> {
    return this.setProviderConfig(workspaceId, userId, 'speech_config', config, 'speech');
  }
  getSpeechInfo(workspaceId: string): Promise<ProviderConfigInfo> {
    return this.getProviderInfo(workspaceId, 'speech_config');
  }
  /** SERVER-ONLY: decrypt the speech config for the media layer. Never exposed over HTTP. */
  getSpeechConfig(workspaceId: string): Promise<SpeechConfig | null> {
    return this.getProviderConfig<SpeechConfig>(workspaceId, 'speech_config');
  }
  deleteSpeechConfig(workspaceId: string, userId: string): Promise<ProviderConfigInfo> {
    return this.deleteProviderConfig(workspaceId, userId, 'speech_config');
  }

  // Chat "brain" provider config (Anthropic default, or OpenAI-compatible: DeepSeek / local MiMo).
  setChatProviderConfig(workspaceId: string, userId: string, config: ChatProviderConfig): Promise<ProviderConfigInfo> {
    return this.setProviderConfig(workspaceId, userId, 'chat_provider_config', config, 'chat_provider');
  }
  getChatProviderInfo(workspaceId: string): Promise<ProviderConfigInfo> {
    return this.getProviderInfo(workspaceId, 'chat_provider_config');
  }
  /** SERVER-ONLY: decrypt the chat provider config for the LLM factory. Never exposed over HTTP. */
  getChatProviderConfig(workspaceId: string): Promise<ChatProviderConfig | null> {
    return this.getProviderConfig<ChatProviderConfig>(workspaceId, 'chat_provider_config');
  }
  deleteChatProviderConfig(workspaceId: string, userId: string): Promise<ProviderConfigInfo> {
    return this.deleteProviderConfig(workspaceId, userId, 'chat_provider_config');
  }

  // Peer "second brain" config (e.g. brain=DeepSeek, peer=MiMo-VL) — consulted via the consult_peer tool.
  setPeerProviderConfig(workspaceId: string, userId: string, config: ChatProviderConfig): Promise<ProviderConfigInfo> {
    return this.setProviderConfig(workspaceId, userId, 'peer_provider_config', config, 'peer_provider');
  }
  getPeerProviderInfo(workspaceId: string): Promise<ProviderConfigInfo> {
    return this.getProviderInfo(workspaceId, 'peer_provider_config');
  }
  /** SERVER-ONLY: decrypt the peer provider config for the peer service. Never exposed over HTTP. */
  getPeerProviderConfig(workspaceId: string): Promise<ChatProviderConfig | null> {
    return this.getProviderConfig<ChatProviderConfig>(workspaceId, 'peer_provider_config');
  }
  deletePeerProviderConfig(workspaceId: string, userId: string): Promise<ProviderConfigInfo> {
    return this.deleteProviderConfig(workspaceId, userId, 'peer_provider_config');
  }

  // Model route config (TICKET-10): named provider profiles + capability/effort route table + fallback
  // chain. Stored encrypted (profiles carry API keys). Consumed by LlmProviderFactory when MODEL_ROUTER.
  setModelRouteConfig(workspaceId: string, userId: string, config: ModelRouteConfig): Promise<ProviderConfigInfo> {
    // setProviderConfig encrypts the WHOLE object + reads only the (absent) top-level provider/apiKey/model
    // (→ null lastFour). The cast bridges the "weak type" mismatch (route config shares no top-level field).
    return this.setProviderConfig(workspaceId, userId, 'model_route_config', config as unknown as { provider?: string }, 'model_route');
  }
  getModelRouteInfo(workspaceId: string): Promise<ProviderConfigInfo> {
    return this.getProviderInfo(workspaceId, 'model_route_config');
  }
  /** SERVER-ONLY: decrypt the model route config for the LLM factory. Never exposed over HTTP. */
  getModelRouteConfig(workspaceId: string): Promise<ModelRouteConfig | null> {
    return this.getProviderConfig<ModelRouteConfig>(workspaceId, 'model_route_config');
  }
  deleteModelRouteConfig(workspaceId: string, userId: string): Promise<ProviderConfigInfo> {
    return this.deleteProviderConfig(workspaceId, userId, 'model_route_config');
  }

  // ---- Connector secrets (OAuth client config + access token), keyed by provider via `label` ----

  private async setKeyed(
    workspaceId: string,
    userId: string,
    type: SecretType,
    label: string,
    obj: unknown,
    lastFour: string | null,
    kind: string,
  ): Promise<void> {
    const enc = this.crypto.encrypt(JSON.stringify(obj));
    await this.prisma.secret.deleteMany({ where: { workspaceId, type, label } });
    const secret = await this.prisma.secret.create({
      data: {
        workspaceId,
        type,
        label,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        wrappedDataKey: enc.wrappedDataKey,
        kmsKeyId: this.crypto.keyId,
        lastFour,
        createdByUserId: userId,
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'secret.set',
      targetType: 'secret',
      targetId: secret.id,
      risk: 'high',
      metadata: { kind, provider: label },
    });
  }

  private async getKeyed<T>(workspaceId: string, type: SecretType, label: string): Promise<T | null> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type, label },
      orderBy: { createdAt: 'desc' },
    });
    if (!secret) return null;
    const json = this.crypto.decrypt({
      ciphertext: Buffer.from(secret.ciphertext),
      iv: Buffer.from(secret.iv),
      authTag: Buffer.from(secret.authTag),
      wrappedDataKey: Buffer.from(secret.wrappedDataKey),
    });
    return JSON.parse(json) as T;
  }

  /** Set a connector's OAuth client credentials (admin-configured app registration). */
  setConnectorClient(
    workspaceId: string,
    userId: string,
    provider: string,
    client: { clientId: string; clientSecret: string },
  ): Promise<void> {
    return this.setKeyed(workspaceId, userId, 'oauth_client_secret', provider, client, client.clientId.slice(-4), 'connector_client');
  }
  /** SERVER-ONLY: the OAuth client credentials for the connect flow. Never exposed over HTTP. */
  getConnectorClient(workspaceId: string, provider: string): Promise<{ clientId: string; clientSecret: string } | null> {
    return this.getKeyed(workspaceId, 'oauth_client_secret', provider);
  }
  async getConnectorClientInfo(workspaceId: string, provider: string): Promise<{ configured: boolean; lastFour: string | null }> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type: 'oauth_client_secret', label: provider },
      select: { lastFour: true },
    });
    return { configured: !!secret, lastFour: secret?.lastFour ?? null };
  }

  /** Store a connector's encrypted access token + granted scopes. Optional refreshToken/expiresAt
   * support providers whose access tokens expire (Google, Microsoft) and must be refreshed. */
  setConnectorToken(
    workspaceId: string,
    userId: string,
    provider: string,
    token: { accessToken: string; scopes: string; refreshToken?: string; expiresAt?: number },
  ): Promise<void> {
    return this.setKeyed(workspaceId, userId, 'connector_token', provider, token, token.accessToken.slice(-4), 'connector_token');
  }
  /** SERVER-ONLY: the access token (+ refresh metadata) for connector tools. Never exposed over HTTP. */
  getConnectorToken(
    workspaceId: string,
    provider: string,
  ): Promise<{ accessToken: string; scopes: string; refreshToken?: string; expiresAt?: number } | null> {
    return this.getKeyed(workspaceId, 'connector_token', provider);
  }

  /** Remove both the access token and the client config for a provider. */
  async deleteConnectorSecrets(workspaceId: string, provider: string): Promise<void> {
    await this.prisma.secret.deleteMany({
      where: { workspaceId, type: { in: ['connector_token', 'oauth_client_secret'] }, label: provider },
    });
  }

  // ---- Hosting (static-site deploy) token, stored encrypted under the generic vault ----

  /** Store the hosting config: the deploy token + backend ('netlify' | 'selfhosted'), the self-hosted
   * endpoint (for the VPS server), and Netlify's persisted siteId (for a stable URL). */
  setHostingConfig(
    workspaceId: string,
    userId: string,
    config: { token: string; siteId?: string; backend?: 'netlify' | 'selfhosted'; endpoint?: string },
  ): Promise<void> {
    return this.setKeyed(workspaceId, userId, 'generic', 'hosting', config, config.token.slice(-4), 'hosting');
  }

  /** Renderable status (configured + last four of the token) for the Hosting settings UI. */
  async getHostingInfo(workspaceId: string): Promise<{ configured: boolean; lastFour: string | null }> {
    const secret = await this.prisma.secret.findFirst({
      where: { workspaceId, type: 'generic', label: 'hosting' },
      orderBy: { createdAt: 'desc' },
      select: { lastFour: true },
    });
    return { configured: !!secret, lastFour: secret?.lastFour ?? null };
  }

  /** SERVER-ONLY: the decrypted hosting token + backend/endpoint/siteId. Never exposed over HTTP. */
  getHostingConfig(
    workspaceId: string,
  ): Promise<{ token: string; siteId?: string; backend?: 'netlify' | 'selfhosted'; endpoint?: string } | null> {
    return this.getKeyed(workspaceId, 'generic', 'hosting');
  }

  async deleteHostingConfig(workspaceId: string): Promise<void> {
    await this.prisma.secret.deleteMany({ where: { workspaceId, type: 'generic', label: 'hosting' } });
  }
}
