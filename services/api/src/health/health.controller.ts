import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { BRAND } from '@agentos/brand';
import { PROTOCOL_VERSION } from '@agentos/protocol';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthStatus {
  status: 'ok';
  service: string;
  protocolVersion: string;
}

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up + serving. Cheap, dependency-free — load balancers / scripts/doctor.ps1
   * use it to know the API is alive. Always 200 when the event loop is responsive. */
  @Get()
  check(): HealthStatus {
    return {
      status: 'ok',
      service: BRAND.appName,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  /** Readiness (Ticket-01): can the API actually SERVE — i.e. is its database reachable? A real probe, not
   * a static 200: pings Postgres and returns 503 when the DB is down so an orchestrator / the doctor sees
   * the true state instead of a green light over a broken backend. */
  @Get('ready')
  async ready(): Promise<{ ready: true; db: 'up'; service: string }> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return { ready: true, db: 'up', service: BRAND.appName };
    } catch (err) {
      throw new ServiceUnavailableException({
        ready: false,
        db: 'down',
        reason: err instanceof Error ? err.message : 'database unreachable',
      });
    }
  }
}
