import { Body, Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConnectorRegistryService } from './connector-registry.service';

const eventSchema = z.object({ eventType: z.string().min(1).max(120), summary: z.string().max(2000).optional() });
type EventDto = z.infer<typeof eventSchema>;

/**
 * Public connector webhook ingestion (TICKET-9). NO session guard — authentication is the per-connection
 * secret (constant-time compared, UNIFORM 404 on any failure, flag-gated in the service). Per-IP throttled
 * like every other public entry point. The body is stored REDACTED + minimal (never raw payload/secret).
 */
@Controller('webhooks/connectors')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class ConnectorWebhookController {
  constructor(private readonly registry: ConnectorRegistryService) {}

  @Post(':connectionId')
  ingest(@Param('connectionId') connectionId: string, @Headers('x-connector-token') token: string, @Body(new ZodValidationPipe(eventSchema)) dto: EventDto) {
    return this.registry.ingestWebhook(connectionId, token ?? '', dto.eventType, dto.summary);
  }
}
