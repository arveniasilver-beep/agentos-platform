import { BadRequestException, Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { validateRouteConfig, type ModelRouteConfig } from '@agentos/llm';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SecretsService, type LlmKeyInfo, type ProviderConfigInfo } from './secrets.service';
import { setLlmKeySchema, type SetLlmKeyDto } from './dto';

// The "brain" (chat model) provider: Anthropic (default) or any OpenAI-compatible server.
const brainSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']),
    apiKey: z.string().max(400).optional(),
    baseUrl: z.string().url().max(300).optional(),
    model: z.string().max(120).optional(),
    inputPerMTok: z.number().nonnegative().max(10_000).optional(),
    outputPerMTok: z.number().nonnegative().max(10_000).optional(),
  })
  .refine((d) => d.provider !== 'openai' || (!!d.apiKey && !!d.baseUrl), {
    message: 'An OpenAI-compatible provider needs both an API key and a base URL.',
    path: ['baseUrl'],
  });
type BrainDto = z.infer<typeof brainSchema>;

@Controller('workspaces/:workspaceId/settings/llm-key')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class SettingsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @MinRole('member')
  get(@Param('workspaceId') workspaceId: string): Promise<LlmKeyInfo> {
    return this.secrets.getLlmKeyInfo(workspaceId);
  }

  @Put()
  @MinRole('admin')
  set(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(setLlmKeySchema)) dto: SetLlmKeyDto,
  ): Promise<LlmKeyInfo> {
    return this.secrets.setLlmKey(workspaceId, user.id, dto.apiKey, dto.provider);
  }

  @Delete()
  @MinRole('admin')
  remove(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<LlmKeyInfo> {
    return this.secrets.deleteLlmKey(workspaceId, user.id);
  }
}

/** The chat "brain" provider (Anthropic default, or an OpenAI-compatible server like DeepSeek / a
 * local vLLM serving MiMo). Read=member, write=admin; the key is never returned. */
@Controller('workspaces/:workspaceId/settings/brain')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class BrainProviderController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @MinRole('member')
  get(@Param('workspaceId') workspaceId: string): Promise<ProviderConfigInfo> {
    return this.secrets.getChatProviderInfo(workspaceId);
  }

  @Put()
  @MinRole('admin')
  set(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(brainSchema)) dto: BrainDto,
  ): Promise<ProviderConfigInfo> {
    return this.secrets.setChatProviderConfig(workspaceId, user.id, dto);
  }

  @Delete()
  @MinRole('admin')
  remove(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<ProviderConfigInfo> {
    return this.secrets.deleteChatProviderConfig(workspaceId, user.id);
  }
}

/** The "peer" second model the brain can consult (e.g. brain=DeepSeek, peer=MiMo-VL for vision).
 * Same shape + RBAC as the brain provider; the key is never returned. */
@Controller('workspaces/:workspaceId/settings/peer')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class PeerProviderController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @MinRole('member')
  get(@Param('workspaceId') workspaceId: string): Promise<ProviderConfigInfo> {
    return this.secrets.getPeerProviderInfo(workspaceId);
  }

  @Put()
  @MinRole('admin')
  set(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(brainSchema)) dto: BrainDto,
  ): Promise<ProviderConfigInfo> {
    return this.secrets.setPeerProviderConfig(workspaceId, user.id, dto);
  }

  @Delete()
  @MinRole('admin')
  remove(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<ProviderConfigInfo> {
    return this.secrets.deletePeerProviderConfig(workspaceId, user.id);
  }
}

// Model Router (TICKET-10): named provider profiles + a capability/effort route table + fallback chain.
const routeProfileSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']),
    apiKey: z.string().max(400).optional(),
    baseUrl: z.string().url().max(300).optional(),
    model: z.string().max(120).optional(),
    inputPerMTok: z.number().nonnegative().max(10_000).optional(),
    outputPerMTok: z.number().nonnegative().max(10_000).optional(),
  })
  .refine((d) => d.provider !== 'openai' || (!!d.apiKey && !!d.baseUrl), {
    message: 'An OpenAI-compatible profile needs both an API key and a base URL.',
    path: ['baseUrl'],
  });
const routeConfigSchema = z.object({
  profiles: z.record(z.string().min(1).max(40), routeProfileSchema),
  routes: z
    .array(z.object({ capability: z.string().max(40).optional(), effortAtLeast: z.enum(['low', 'medium', 'high', 'max']).optional(), profile: z.string().min(1).max(40) }))
    .max(40)
    .default([]),
  fallback: z.array(z.string().max(40)).max(10).default([]),
  default: z.string().max(40).optional(),
});
type RouteConfigDto = z.infer<typeof routeConfigSchema>;

/** The Model Router config: named provider profiles + route table + fallback. Read=member, write=admin;
 * the profile API keys are never returned (stored encrypted, lastFour is null at the route level). The
 * cross-reference validation (every routed profile must exist) is enforced at write time. */
@Controller('workspaces/:workspaceId/settings/route')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class RouteProviderController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @MinRole('member')
  get(@Param('workspaceId') workspaceId: string): Promise<ProviderConfigInfo> {
    return this.secrets.getModelRouteInfo(workspaceId);
  }

  @Put()
  @MinRole('admin')
  async set(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(routeConfigSchema)) dto: RouteConfigDto,
  ): Promise<ProviderConfigInfo> {
    // Shape is Zod-valid; also enforce cross-references (routes/fallback/default → existing profile) so a
    // broken table is rejected at SAVE time, not only at run time.
    const v = validateRouteConfig(dto);
    if (!v.ok || !v.config) throw new BadRequestException(`Model route config is invalid: ${v.errors.join('; ')}`);
    return this.secrets.setModelRouteConfig(workspaceId, user.id, v.config as ModelRouteConfig);
  }

  @Delete()
  @MinRole('admin')
  remove(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<ProviderConfigInfo> {
    return this.secrets.deleteModelRouteConfig(workspaceId, user.id);
  }
}
