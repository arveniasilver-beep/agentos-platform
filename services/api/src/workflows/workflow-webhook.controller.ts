import { Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { WorkflowService } from './workflow.service';

/**
 * Public webhook trigger (TICKET-8). NO session guard — authentication is the per-workflow secret token
 * (constant-time compared in the service). Flag-gated inside triggerWebhookById, which returns a UNIFORM
 * 404 on any failure (no enumeration oracle). Per-IP throttled to blunt brute-force / run-flooding, like
 * every other public entry point (auth, inbound email, public API). The workspace is resolved server-side.
 */
@Controller('webhooks/workflows')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class WorkflowWebhookController {
  constructor(private readonly workflows: WorkflowService) {}

  @Post(':workflowId')
  trigger(@Param('workflowId') workflowId: string, @Headers('x-workflow-token') token: string) {
    return this.workflows.triggerWebhookById(workflowId, token ?? '');
  }
}
