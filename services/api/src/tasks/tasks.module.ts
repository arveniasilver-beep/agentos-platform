import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { MediaModule } from '../media/media.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { PeerModule } from '../peer/peer.module';
import { LocalFoldersModule } from '../local-folders/local-folders.module';
import { HostingModule } from '../hosting/hosting.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { PolicyModule } from '../policy/policy.module';
import { CodingModule } from '../coding/coding.module';
import { AutomationRunsModule } from '../automations/automation-runs.module';
import { MemoryModule } from '../memory/memory.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { TasksController } from './tasks.controller';
import { ShareController } from './share.controller';
import { TasksService } from './tasks.service';
import { TaskControlBus } from './task-control-bus';
import { LlmProviderFactory } from './llm-provider.factory';
import { ToolsFactory } from './tools.factory';
import { TaskWorker } from '../queue/task.worker';
import { AgentGateway } from '../events/agent.gateway';

@Module({
  imports: [
    AuthModule,
    SecretsModule,
    KnowledgeModule,
    PersonalizationModule,
    MediaModule,
    ConnectorsModule,
    PeerModule,
    LocalFoldersModule,
    HostingModule,
    ArtifactsModule,
    PolicyModule,
    CodingModule,
    AutomationRunsModule,
    MemoryModule,
  ],
  controllers: [TasksController, ShareController],
  providers: [
    TasksService,
    TaskControlBus,
    LlmProviderFactory,
    ToolsFactory,
    WorkspaceRoleGuard,
    TaskWorker,
    AgentGateway,
  ],
  exports: [TasksService],
})
export class TasksModule {}
