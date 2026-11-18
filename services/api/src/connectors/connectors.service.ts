import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadServerEnv } from '@agentos/config';
import { tenantContext } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../secrets/secrets.service';
import { AuditService } from '../audit/audit.service';
import {
  githubAuthorizeUrl,
  githubExchangeCode,
  GithubApi,
  type GithubClientOptions,
} from './github.client';
import {
  notionAuthorizeUrl,
  notionExchangeCode,
  NotionApi,
  type NotionClientOptions,
} from './notion.client';
import {
  googleAuthorizeUrl,
  googleExchangeCode,
  googleRefresh,
  GoogleApi,
  GOOGLE_SCOPES,
  type GoogleClientOptions,
} from './google.client';
import {
  microsoftAuthorizeUrl,
  microsoftExchangeCode,
  microsoftRefresh,
  MicrosoftApi,
  MICROSOFT_SCOPES,
  type MicrosoftClientOptions,
} from './microsoft.client';

/** Providers wired today. The OAuth flow + tool wiring are generic; each provider plugs in its
 * authorize/exchange/account specifics below. */
export const CONNECTOR_PROVIDERS = ['github', 'notion', 'google', 'outlook'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

const PROVIDER_SCOPES: Record<ConnectorProvider, string> = {
  github: 'repo read:user',
  notion: '',
  google: GOOGLE_SCOPES,
  outlook: MICROSOFT_SCOPES,
};
const STATE_TTL_MS = 10 * 60 * 1000;

export interface ConnectionView {
  provider: string;
  connected: boolean;
  clientConfigured: boolean;
  accountLabel: string | null;
  scopes: string | null;
}

function isProvider(p: string): p is ConnectorProvider {
  return (CONNECTOR_PROVIDERS as readonly string[]).includes(p);
}

/**
 * OAuth connector orchestration. Per workspace+provider it keeps an encrypted OAuth client config and
 * (after connect) an encrypted access token; the Connection row tracks the linked account. The
 * connect flow is CSRF-protected by an HMAC-signed, expiring `state`. GitHub is the first concrete
 * provider; the framework generalizes to others. Inputs to test pass an injectable GitHub client.
 */
@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  private readonly env = loadServerEnv();
  // Inject provider client configs (base URLs / fetch) in tests; undefined => real hosts.
  githubOpts: GithubClientOptions | undefined;
  notionOpts: NotionClientOptions | undefined;
  googleOpts: GoogleClientOptions | undefined;
  microsoftOpts: MicrosoftClientOptions | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly audit: AuditService,
  ) {}

  private stateKey(): Buffer {
    const raw = this.env.MASTER_ENCRYPTION_KEY;
    if (raw) return Buffer.from(raw, 'base64');
    // The OAuth `state` signature is security-bearing (CSRF) — fail closed in production, mirroring
    // CryptoService. The deterministic dev key is dev-only.
    if (this.env.NODE_ENV === 'production') {
      throw new Error('MASTER_ENCRYPTION_KEY is required in production (OAuth state signing)');
    }
    return Buffer.alloc(32, 7);
  }
  private signState(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.stateKey()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }
  private verifyState(
    state: string,
  ): { workspaceId: string; provider: string; userId: string; nonce: string; exp: number } | null {
    const [body, sig] = state.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.stateKey()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        workspaceId: string;
        provider: string;
        userId: string;
        nonce: string;
        exp: number;
      };
      if (!payload.exp || payload.exp < this.nowMs()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** Constant-time equality for the cookie nonce vs the state nonce (both must be present). */
  private nonceMatches(a: string, b: string): boolean {
    if (!a || !b) return false;
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
  // Wrapped so tests can hold time stable if needed; Date.now is fine in normal API runtime.
  private nowMs(): number {
    return Date.now();
  }

  private redirectUri(provider: string): string {
    return `${this.env.PUBLIC_API_BASE_URL.replace(/\/$/, '')}/connectors/${provider}/callback`;
  }

  async list(workspaceId: string): Promise<ConnectionView[]> {
    const conns = await this.prisma.connection.findMany({ where: { workspaceId } });
    const byProvider = new Map(conns.map((c) => [c.provider, c]));
    const out: ConnectionView[] = [];
    for (const provider of CONNECTOR_PROVIDERS) {
      const info = await this.secrets.getConnectorClientInfo(workspaceId, provider);
      const c = byProvider.get(provider);
      out.push({
        provider,
        connected: !!c,
        clientConfigured: info.configured,
        accountLabel: c?.accountLabel ?? null,
        scopes: c?.scopes ?? null,
      });
    }
    return out;
  }

  async setClientConfig(
    workspaceId: string,
    userId: string,
    provider: string,
    clientId: string,
    clientSecret: string,
  ): Promise<void> {
    if (!isProvider(provider)) throw new BadRequestException('Unknown connector provider.');
    await this.secrets.setConnectorClient(workspaceId, userId, provider, { clientId, clientSecret });
  }

  /**
   * Build the provider authorize URL (with a signed state) the user is redirected to. Returns the
   * URL plus a one-time `nonce` the caller must set as an HttpOnly cookie; the callback requires the
   * cookie nonce to equal the state nonce (binds the flow to the initiating browser → CSRF + replay
   * protection; the cookie is cleared after use, so a captured code+state can't be replayed).
   */
  async startUrl(
    workspaceId: string,
    userId: string,
    provider: string,
  ): Promise<{ url: string; nonce: string }> {
    if (!isProvider(provider)) throw new BadRequestException('Unknown connector provider.');
    const client = await this.secrets.getConnectorClient(workspaceId, provider);
    if (!client) throw new BadRequestException('Configure the OAuth app (client id/secret) first.');
    const nonce = randomBytes(16).toString('hex');
    const state = this.signState({ workspaceId, provider, userId, nonce, exp: this.nowMs() + STATE_TTL_MS });
    const redirectUri = this.redirectUri(provider);
    const url =
      provider === 'outlook'
        ? microsoftAuthorizeUrl({
            clientId: client.clientId,
            redirectUri,
            scope: PROVIDER_SCOPES[provider],
            state,
            ...(this.microsoftOpts?.authBase ? { authBase: this.microsoftOpts.authBase } : {}),
          })
        : provider === 'google'
        ? googleAuthorizeUrl({
            clientId: client.clientId,
            redirectUri,
            scope: PROVIDER_SCOPES[provider],
            state,
            ...(this.googleOpts?.authBase ? { authBase: this.googleOpts.authBase } : {}),
          })
        : provider === 'notion'
        ? notionAuthorizeUrl({
            clientId: client.clientId,
            redirectUri,
            state,
            ...(this.notionOpts?.apiBase ? { apiBase: this.notionOpts.apiBase } : {}),
          })
        : githubAuthorizeUrl({
            clientId: client.clientId,
            redirectUri,
            scope: PROVIDER_SCOPES[provider],
            state,
            ...(this.githubOpts?.oauthBase ? { oauthBase: this.githubOpts.oauthBase } : {}),
          });
    return { url, nonce };
  }

  /**
   * OAuth callback: validate the signed state, exchange the code for a token, fetch the account, and
   * persist the encrypted token + Connection row. Returns the web URL to redirect the browser to.
   * Runs unauthenticated (it's a provider redirect) — the signed state is the only trust anchor.
   */
  async handleCallback(
    provider: string,
    code: string,
    state: string,
    cookieNonce: string,
    providerError = '',
  ): Promise<string> {
    const webBase = this.env.WEB_BASE_URL.replace(/\/$/, '');
    const errorUrl = `${webBase}/?connector=${encodeURIComponent(provider)}&status=error`;
    // The user declined consent at the provider — surface it as "cancelled", not a generic error.
    if (providerError) {
      const status = providerError === 'access_denied' ? 'cancelled' : 'error';
      return `${webBase}/?connector=${encodeURIComponent(provider)}&status=${status}`;
    }
    const payload = this.verifyState(state);
    // Reject a forged/expired state OR one whose nonce doesn't match the initiating browser's cookie
    // (CSRF + replay protection).
    if (!payload || payload.provider !== provider || !isProvider(provider) || !this.nonceMatches(cookieNonce, payload.nonce)) {
      return errorUrl;
    }
    const { workspaceId, userId } = payload;
    try {
      await tenantContext.runWorkspace(workspaceId, async () => {
        const client = await this.secrets.getConnectorClient(workspaceId, provider);
        if (!client) throw new Error('client config missing');
        const redirectUri = this.redirectUri(provider);
        let accessToken: string;
        let scopes: string;
        let account: { id: string; label: string };
        let refreshToken: string | undefined;
        let expiresAt: number | undefined;
        if (provider === 'outlook') {
          const ex = await microsoftExchangeCode({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            code,
            redirectUri,
            scope: PROVIDER_SCOPES.outlook,
            opts: this.microsoftOpts,
          });
          accessToken = ex.accessToken;
          scopes = ex.scopes;
          refreshToken = ex.refreshToken || undefined;
          expiresAt = ex.expiresAt;
          account = await new MicrosoftApi(accessToken, this.microsoftOpts ?? {}).getAccount();
        } else if (provider === 'google') {
          const ex = await googleExchangeCode({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            code,
            redirectUri,
            opts: this.googleOpts,
          });
          accessToken = ex.accessToken;
          scopes = ex.scopes;
          refreshToken = ex.refreshToken || undefined;
          expiresAt = ex.expiresAt;
          account = await new GoogleApi(accessToken, this.googleOpts ?? {}).getAccount();
        } else if (provider === 'notion') {
          const ex = await notionExchangeCode({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            code,
            redirectUri,
            opts: this.notionOpts,
          });
          accessToken = ex.accessToken;
          scopes = ex.scopes;
          // Notion's token response already names the workspace — no extra account call needed.
          account = { id: ex.workspaceId, label: ex.workspaceName };
        } else {
          const ex = await githubExchangeCode({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            code,
            redirectUri,
            opts: this.githubOpts,
          });
          accessToken = ex.accessToken;
          scopes = ex.scopes;
          const u = await new GithubApi(accessToken, this.githubOpts ?? {}).getUser();
          account = { id: String(u.id), label: u.login };
        }
        await this.secrets.setConnectorToken(workspaceId, userId, provider, {
          accessToken,
          scopes,
          ...(refreshToken ? { refreshToken } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        });
        await this.prisma.connection.upsert({
          where: { workspaceId_provider: { workspaceId, provider } },
          create: {
            workspaceId,
            provider,
            externalId: account.id,
            accountLabel: account.label,
            scopes,
            createdByUserId: userId,
          },
          update: { externalId: account.id, accountLabel: account.label, scopes },
        });
        await this.audit.record({
          workspaceId,
          actorUserId: userId,
          action: 'connector.connect',
          targetType: 'connection',
          risk: 'high',
          metadata: { provider, account: account.label },
        });
      });
      return `${webBase}/?connector=${encodeURIComponent(provider)}&status=connected`;
    } catch (err) {
      // User-facing redirect stays generic (no detail leak); record the cause for the operator.
      this.logger.warn(
        `connector callback failed for ${provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return errorUrl;
    }
  }

  async disconnect(workspaceId: string, userId: string, provider: string): Promise<void> {
    if (!isProvider(provider)) throw new BadRequestException('Unknown connector provider.');
    await this.prisma.connection.deleteMany({ where: { workspaceId, provider } });
    await this.secrets.deleteConnectorSecrets(workspaceId, provider);
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'connector.disconnect',
      targetType: 'connection',
      risk: 'medium',
      metadata: { provider },
    });
  }

  /** SERVER-ONLY: build an authenticated GitHub API for the agent tools, or null if not connected. */
  async githubApiFor(workspaceId: string): Promise<GithubApi | null> {
    const token = await this.secrets.getConnectorToken(workspaceId, 'github');
    if (!token) return null;
    return new GithubApi(token.accessToken, this.githubOpts ?? {});
  }

  /** SERVER-ONLY: build an authenticated Notion API for the agent tools, or null if not connected. */
  async notionApiFor(workspaceId: string): Promise<NotionApi | null> {
    const token = await this.secrets.getConnectorToken(workspaceId, 'notion');
    if (!token) return null;
    return new NotionApi(token.accessToken, this.notionOpts ?? {});
  }

  /**
   * SERVER-ONLY: build an authenticated Google API, or null if not connected. Google access tokens
   * expire (~1h), so if the stored one is near/past expiry it is refreshed on demand via the stored
   * refresh_token (not persisted — each run gets a fresh short-lived token).
   */
  async googleApiFor(workspaceId: string): Promise<GoogleApi | null> {
    const token = await this.secrets.getConnectorToken(workspaceId, 'google');
    if (!token) return null;
    let accessToken = token.accessToken;
    const expired = !token.expiresAt || token.expiresAt < this.nowMs();
    const nearExpiry = !token.expiresAt || token.expiresAt < this.nowMs() + 60_000;
    let refreshed = false;
    if (token.refreshToken && nearExpiry) {
      const client = await this.secrets.getConnectorClient(workspaceId, 'google');
      if (client) {
        try {
          const r = await googleRefresh({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            refreshToken: token.refreshToken,
            opts: this.googleOpts,
          });
          accessToken = r.accessToken;
          refreshed = true;
        } catch (err) {
          this.logger.warn(`google token refresh failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    // Fail closed: if the stored token is already expired and we couldn't refresh, treat as
    // not-connected (the tools simply aren't registered) rather than calling with a dead token.
    if (expired && !refreshed) return null;
    return new GoogleApi(accessToken, this.googleOpts ?? {});
  }

  /** SERVER-ONLY: build an authenticated Microsoft (Outlook) API, or null if not connected. Mirrors
   * googleApiFor — Microsoft tokens expire (~1h), refreshed on demand via the stored refresh_token.
   * NOTE: Entra ID rotates the refresh_token on each redemption, but we intentionally DON'T persist the
   * rotated one (each run just re-redeems the stored token). For a confidential client (we send a
   * client_secret) the original refresh_token stays valid within the 90-day inactivity window, so this
   * works; we simply forgo the rolling 90-day extension that persisting the rotated token would give. */
  async outlookApiFor(workspaceId: string): Promise<MicrosoftApi | null> {
    const token = await this.secrets.getConnectorToken(workspaceId, 'outlook');
    if (!token) return null;
    let accessToken = token.accessToken;
    const expired = !token.expiresAt || token.expiresAt < this.nowMs();
    const nearExpiry = !token.expiresAt || token.expiresAt < this.nowMs() + 60_000;
    let refreshed = false;
    if (token.refreshToken && nearExpiry) {
      const client = await this.secrets.getConnectorClient(workspaceId, 'outlook');
      if (client) {
        try {
          const r = await microsoftRefresh({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            refreshToken: token.refreshToken,
            scope: PROVIDER_SCOPES.outlook,
            opts: this.microsoftOpts,
          });
          accessToken = r.accessToken;
          refreshed = true;
        } catch (err) {
          this.logger.warn(`outlook token refresh failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    if (expired && !refreshed) return null;
    return new MicrosoftApi(accessToken, this.microsoftOpts ?? {});
  }
}
