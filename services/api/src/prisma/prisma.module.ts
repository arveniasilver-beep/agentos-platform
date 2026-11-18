import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { loadServerEnv } from '@agentos/config';
import { PrismaService } from './prisma.service';

/** Owns the connection lifecycle of the shared RLS-aware client. */
@Injectable()
class PrismaLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  async onModuleInit(): Promise<void> {
    await getPrisma().$connect();
    await this.assertRlsActive();
  }

  /**
   * Row-Level Security is exempt for superuser, BYPASSRLS, and (under ENABLE-only) the table
   * OWNER. If the runtime DB role is any of those, every tenant_isolation policy is a silent no-op
   * and tenancy rests solely on the app-level filters — a fail-OPEN posture. Detect it at boot:
   * warn everywhere, and refuse to start in production (mirroring the CORS_ORIGINS guard).
   */
  private async assertRlsActive(): Promise<void> {
    const env = loadServerEnv();
    let inert = false;
    try {
      const rows = await getPrisma().$queryRaw<
        { is_super: boolean; is_bypass: boolean; is_owner: boolean }[]
      >`SELECT rolsuper AS is_super, rolbypassrls AS is_bypass,
               (current_user = (SELECT tableowner FROM pg_tables WHERE tablename = 'tasks')) AS is_owner
          FROM pg_roles WHERE rolname = current_user`;
      const r = rows[0];
      inert = !r || r.is_super || r.is_bypass || r.is_owner;
    } catch (err) {
      this.logger.warn(`Could not verify RLS role status: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!inert) return;
    const msg =
      'Postgres RLS is INERT for the current DB role (superuser / BYPASSRLS / table owner): ' +
      'database-layer tenant isolation is bypassed and tenancy rests solely on app-level filters. ' +
      'Connect as the least-privilege non-owner role (agentos_app) to enforce RLS.';
    if (env.NODE_ENV === 'production') throw new Error(msg);
    this.logger.warn(msg);
  }

  async onModuleDestroy(): Promise<void> {
    await disconnectPrisma();
  }
}

@Global()
@Module({
  providers: [
    // Inject the shared tenancy-extended singleton everywhere PrismaService is requested.
    { provide: PrismaService, useFactory: (): PrismaService => getPrisma() as unknown as PrismaService },
    PrismaLifecycle,
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
