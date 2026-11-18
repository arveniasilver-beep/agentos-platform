import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SecretsService } from '../secrets/secrets.service';

// A real (non-mock) provider must carry an API key — otherwise the config would look "configured"
// in the UI and advertise the tool to the agent, yet every generation would fail at runtime.
const requireKeyForRealProvider = (d: { provider: string; apiKey?: string }): boolean =>
  d.provider === 'mock' || !!d.apiKey?.trim();

const imageConfigSchema = z
  .object({
    provider: z.enum(['openai', 'gemini', 'mock']),
    apiKey: z.string().max(400).optional(),
    model: z.string().max(100).optional(),
    baseUrl: z.string().url().max(300).optional(),
  })
  .refine(requireKeyForRealProvider, { message: 'An API key is required for this provider.', path: ['apiKey'] });
type ImageConfigDto = z.infer<typeof imageConfigSchema>;

const speechConfigSchema = z
  .object({
    provider: z.enum(['openai', 'mock']),
    apiKey: z.string().max(400).optional(),
    model: z.string().max(100).optional(),
    voice: z.string().max(60).optional(),
    baseUrl: z.string().url().max(300).optional(),
  })
  .refine(requireKeyForRealProvider, { message: 'An API key is required for this provider.', path: ['apiKey'] });
type SpeechConfigDto = z.infer<typeof speechConfigSchema>;

/** Configure the workspace's image/speech generation providers (keys stored encrypted; never read
 * back over HTTP — only configured/provider/model/lastFour are surfaced). */
@Controller('workspaces/:workspaceId/media')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class MediaController {
  constructor(private readonly secrets: SecretsService) {}

  @Get('image')
  @MinRole('viewer')
  imageInfo(@Param('workspaceId') workspaceId: string) {
    return this.secrets.getImageInfo(workspaceId);
  }

  @Post('image')
  @MinRole('admin')
  setImage(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(imageConfigSchema)) dto: ImageConfigDto,
  ) {
    return this.secrets.setImageConfig(workspaceId, user.id, dto);
  }

  @Delete('image')
  @MinRole('admin')
  deleteImage(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    return this.secrets.deleteImageConfig(workspaceId, user.id);
  }

  @Get('speech')
  @MinRole('viewer')
  speechInfo(@Param('workspaceId') workspaceId: string) {
    return this.secrets.getSpeechInfo(workspaceId);
  }

  @Post('speech')
  @MinRole('admin')
  setSpeech(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(speechConfigSchema)) dto: SpeechConfigDto,
  ) {
    return this.secrets.setSpeechConfig(workspaceId, user.id, dto);
  }

  @Delete('speech')
  @MinRole('admin')
  deleteSpeech(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    return this.secrets.deleteSpeechConfig(workspaceId, user.id);
  }
}
