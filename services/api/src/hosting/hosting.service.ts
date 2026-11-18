import { Injectable } from '@nestjs/common';
import { SecretsService } from '../secrets/secrets.service';
import { NetlifyClient, type DeployFile } from './netlify.client';
import { SelfHostedClient } from './self-hosted.client';

export type HostingBackend = 'netlify' | 'selfhosted';

/**
 * Static-site hosting: deploy a generated website and get a public URL. Two backends:
 *   - 'netlify'    — third-party, just a token (siteId persisted for a stable URL).
 *   - 'selfhosted' — AgentOS's own server on the user's VPS (services/hosting-server); needs the
 *                    endpoint + token. Routes by slug, so the deploy carries the site slug.
 * The token (+ siteId/backend/endpoint) is stored encrypted per workspace.
 */
@Injectable()
export class HostingService {
  private readonly netlify = new NetlifyClient();
  private readonly selfHosted = new SelfHostedClient();

  constructor(private readonly secrets: SecretsService) {}

  setConfig(
    workspaceId: string,
    userId: string,
    config: { token: string; backend?: HostingBackend; endpoint?: string },
  ): Promise<void> {
    return this.secrets.setHostingConfig(workspaceId, userId, {
      token: config.token,
      backend: config.backend ?? 'netlify',
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
  }

  status(workspaceId: string): Promise<{ configured: boolean; lastFour: string | null }> {
    return this.secrets.getHostingInfo(workspaceId);
  }

  clear(workspaceId: string, userId: string): Promise<void> {
    void userId;
    return this.secrets.deleteHostingConfig(workspaceId);
  }

  /**
   * A deploy callback for the publish_site tool, or null when no hosting token is configured (so the
   * tool is withheld). Routes to Netlify or the self-hosted VPS server based on the stored backend.
   */
  async deployerFor(
    workspaceId: string,
    userId: string,
  ): Promise<((input: { slug: string; files: DeployFile[] }) => Promise<{ url: string }>) | null> {
    const info = await this.secrets.getHostingInfo(workspaceId);
    if (!info.configured) return null;
    return async ({ slug, files }: { slug: string; files: DeployFile[] }) => {
      const config = await this.secrets.getHostingConfig(workspaceId);
      if (!config?.token) throw new Error('hosting is not configured for this workspace');
      if (config.backend === 'selfhosted') {
        if (!config.endpoint) throw new Error('self-hosted hosting needs an endpoint URL');
        return this.selfHosted.deploy(config.endpoint, config.token, slug, files);
      }
      // Default: Netlify (slug is Netlify's own concern; we pass siteId for a stable URL).
      const { siteId, url } = await this.netlify.deploy(config.token, config.siteId ?? null, files);
      if (siteId && siteId !== config.siteId) {
        await this.secrets.setHostingConfig(workspaceId, userId, {
          token: config.token,
          siteId,
          backend: 'netlify',
          ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        });
      }
      return { url };
    };
  }
}
