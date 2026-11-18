import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@agentos/db';

/**
 * DI token + type handle for the RLS-aware Prisma client. The provider value (see PrismaModule) is
 * the shared tenancy-extended singleton from `@agentos/db` (`getPrisma()`), so every injection gets
 * the same client that sets the Row-Level-Security GUC per query. This class is never instantiated
 * directly — it exists so existing `private readonly prisma: PrismaService` injections keep working
 * unchanged. Connection lifecycle is owned by PrismaModule.
 */
@Injectable()
export class PrismaService extends PrismaClient {}
