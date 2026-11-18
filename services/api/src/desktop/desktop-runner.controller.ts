import { Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { loadServerEnv } from '@agentos/config';
import { AuthGuard } from '../auth/auth.guard';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DesktopRunnerService } from './desktop-runner.service';
import { registerRunnerSchema, setRunnerStatusSchema, type RegisterRunnerDto, type SetRunnerStatusDto } from './dto';

/**
 * Desktop Runner Foundation (TICKET-7). register/heartbeat authenticate as a TICKET-5 device (Bearer),
 * so req.deviceId is set; a revoked device fails closed at AuthGuard + in the service. register/heartbeat
 * are flag-gated (DESKTOP_RUNNER_ENABLED) so flag-off is inert. list/status are management reads.
 */
@Controller('workspaces/:workspaceId/desktop')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class DesktopRunnerController {
  constructor(private readonly runners: DesktopRunnerService) {}

  private ensureEnabled() {
    if (!loadServerEnv().DESKTOP_RUNNER_ENABLED) throw new NotFoundException('Desktop runner is not enabled.');
  }

  @Post('runner/register')
  @MinRole('member')
  register(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(registerRunnerSchema)) dto: RegisterRunnerDto,
    @Req() req: { deviceId?: string },
  ) {
    this.ensureEnabled();
    return this.runners.register(workspaceId, req.deviceId, dto);
  }

  @Post('runner/heartbeat')
  @MinRole('member')
  heartbeat(@Param('workspaceId') workspaceId: string, @Req() req: { deviceId?: string }) {
    this.ensureEnabled();
    return this.runners.heartbeat(workspaceId, req.deviceId);
  }

  @Get('runners')
  @MinRole('viewer')
  list(@Param('workspaceId') workspaceId: string) {
    return this.runners.list(workspaceId);
  }

  @Get('runners/:id')
  @MinRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.runners.get(workspaceId, id);
  }

  @Post('runners/:id/status')
  @MinRole('member')
  setStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setRunnerStatusSchema)) dto: SetRunnerStatusDto,
  ) {
    return this.runners.setStatus(workspaceId, id, dto.status);
  }
}
