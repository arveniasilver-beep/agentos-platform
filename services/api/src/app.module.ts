import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { loadServerEnv } from '@agentos/config';
import { TenantInterceptor } from './common/tenant.interceptor';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SecretsModule } from './secrets/secrets.module';
import { TasksModule } from './tasks/tasks.module';
import { QueueModule } from './queue/queue.module';
import { EventsModule } from './events/events.module';
import { AutomationsModule } from './automations/automations.module';
import { UsageModule } from './usage/usage.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { SkillsModule } from './skills/skills.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { PersonalizationModule } from './personalization/personalization.module';
import { MemoryModule } from './memory/memory.module';
import { BrowserModule } from './browser/browser.module';
import { SyncModule } from './sync/sync.module';
import { DesktopRunnerModule } from './desktop/desktop-runner.module';
import { WorkflowModule } from './workflows/workflow.module';
import { ConnectorRegistryModule } from './connectors/connector-registry.module';
import { MediaModule } from './media/media.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { InboundModule } from './inbound/inbound.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PlaybooksModule } from './playbooks/playbooks.module';
import { LocalFoldersModule } from './local-folders/local-folders.module';
import { HostingModule } from './hosting/hosting.module';

const env = loadServerEnv();

@Module({
  imports: [
    // Brute-force protection (applied to auth routes via ThrottlerGuard).
    ThrottlerModule.forRoot([
      { ttl: env.AUTH_RATE_WINDOW_SEC * 1000, limit: env.AUTH_RATE_LIMIT },
    ]),
    PrismaModule,
    CryptoModule,
    AuditModule,
    AuthModule,
    WorkspacesModule,
    SecretsModule,
    QueueModule,
    EventsModule,
    TasksModule,
    AutomationsModule,
    UsageModule,
    ArtifactsModule,
    SkillsModule,
    ApiKeysModule,
    KnowledgeModule,
    PersonalizationModule,
    MemoryModule,
    BrowserModule,
    SyncModule,
    DesktopRunnerModule,
    WorkflowModule,
    ConnectorRegistryModule,
    MediaModule,
    ConnectorsModule,
    InboundModule,
    NotificationsModule,
    PlaybooksModule,
    LocalFoldersModule,
    HostingModule,
  ],
  controllers: [HealthController],
  // Set the per-request tenancy context (drives Postgres RLS) for every workspace-scoped route.
  providers: [{ provide: APP_INTERCEPTOR, useClass: TenantInterceptor }],
})
export class AppModule {}
