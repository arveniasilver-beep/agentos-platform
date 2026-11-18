import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { loadServerEnv } from '@agentos/config';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConnectorsService } from './connectors.service';

const clientConfigSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(400),
});
type ClientConfigDto = z.infer<typeof clientConfigSchema>;

const STATE_COOKIE = (provider: string): string => `oauth_state_${provider}`;
const STATE_COOKIE_MAX_AGE = 600; // seconds (matches the state TTL)

/** Minimal Fastify req/reply surfaces we use (avoids a direct fastify dependency). */
interface ReqLike {
  cookies?: Record<string, string | undefined>;
}
interface ReplyLike {
  setCookie(name: string, value: string, opts: Record<string, unknown>): unknown;
  clearCookie(name: string, opts: Record<string, unknown>): unknown;
  status(code: number): ReplyLike;
  header(key: string, value: string): ReplyLike;
  send(payload?: unknown): unknown;
}

/** Manage workspace connectors (OAuth client config + connect/disconnect). Auth + RBAC gated. */
@Controller('workspaces/:workspaceId/connectors')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get()
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.connectors.list(workspaceId);
  }

  @Post(':provider/config')
  @MinRole('admin')
  setConfig(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(clientConfigSchema)) dto: ClientConfigDto,
  ) {
    return this.connectors.setClientConfig(workspaceId, user.id, provider, dto.clientId, dto.clientSecret);
  }

  @Get(':provider/start')
  @MinRole('admin')
  async start(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: string,
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) reply: ReplyLike,
  ) {
    const { url, nonce } = await this.connectors.startUrl(workspaceId, user.id, provider);
    // Bind the flow to this browser: the callback requires this cookie's nonce to match the state.
    reply.setCookie(STATE_COOKIE(provider), nonce, {
      httpOnly: true,
      secure: loadServerEnv().NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: STATE_COOKIE_MAX_AGE,
    });
    return { url };
  }

  @Delete(':provider')
  @MinRole('admin')
  disconnect(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.connectors.disconnect(workspaceId, user.id, provider);
  }
}

/** UNAUTHENTICATED OAuth redirect target — the signed `state` + the per-browser nonce cookie are the
 * trust anchors. Per-IP throttled (it's a public surface) and always redirects back to the web app
 * (never returns an error body that could leak details). */
@Controller('connectors')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class ConnectorCallbackController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: ReqLike,
    @Res() reply: ReplyLike,
  ): Promise<void> {
    const cookieName = STATE_COOKIE(provider);
    const nonce = req.cookies?.[cookieName] ?? '';
    // The provider can redirect back with ?error=access_denied (user cancelled) — surface that
    // distinctly instead of a generic failure.
    const url = await this.connectors.handleCallback(provider, code ?? '', state ?? '', nonce, error ?? '');
    // One-time: clear the nonce cookie so a captured code+state can't be replayed.
    reply.clearCookie(cookieName, { path: '/' });
    reply.status(302).header('location', url).send();
  }
}
