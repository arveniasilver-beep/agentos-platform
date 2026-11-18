import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MinRole } from '../rbac/min-role.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InboundService } from './inbound.service';
import { InboundThrottlerGuard } from './inbound-throttler.guard';

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  allowedSenders: z.array(z.string().email().max(200)).max(200).optional(),
  taskRiskCeiling: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  taskCostBudgetUsd: z.number().positive().max(1000).nullable().optional(),
});
type UpdateDto = z.infer<typeof updateSchema>;

// Accept the common parsed-inbound shapes (Postmark/SendGrid/Mailgun/...) via aliases, normalized
// to { from, subject, text }. Unknown extra fields are ignored.
const inboundSchema = z
  .object({
    from: z.string().max(320).optional(),
    sender: z.string().max(320).optional(),
    From: z.string().max(320).optional(),
    subject: z.string().max(2_000).optional(),
    Subject: z.string().max(2_000).optional(),
    text: z.string().max(100_000).optional(),
    TextBody: z.string().max(100_000).optional(),
    'body-plain': z.string().max(100_000).optional(),
    body: z.string().max(100_000).optional(),
  })
  .passthrough();
type InboundDto = z.infer<typeof inboundSchema>;

/** Workspace inbound-email config (the address token, enable, sender allowlist). Auth + RBAC. */
@Controller('workspaces/:workspaceId/inbound')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class InboundConfigController {
  constructor(private readonly inbound: InboundService) {}

  @Get()
  @MinRole('member')
  get(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    return this.inbound.ensure(workspaceId, user.id);
  }

  @Patch()
  @MinRole('admin')
  update(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(updateSchema)) dto: UpdateDto,
  ) {
    return this.inbound.update(workspaceId, user.id, dto);
  }

  @Post('regenerate')
  @MinRole('admin')
  regenerate(@Param('workspaceId') workspaceId: string, @CurrentUser() user: SessionUser) {
    return this.inbound.regenerate(workspaceId, user.id);
  }
}

/** UNAUTHENTICATED webhook the mail service POSTs to. The opaque token is the capability; throttled
 * PER-TOKEN (not per-IP — providers share egress IPs and an attacker could rotate IPs). */
@Controller('inbound-email')
@UseGuards(InboundThrottlerGuard)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class InboundWebhookController {
  constructor(private readonly inbound: InboundService) {}

  @Post(':token')
  receive(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(inboundSchema)) dto: InboundDto,
  ) {
    const from = dto.from ?? dto.sender ?? dto.From ?? '';
    const subject = dto.subject ?? dto.Subject;
    const text = dto.text ?? dto.TextBody ?? dto['body-plain'] ?? dto.body;
    return this.inbound.handleInbound(token, { from, ...(subject ? { subject } : {}), ...(text ? { text } : {}) });
  }
}
