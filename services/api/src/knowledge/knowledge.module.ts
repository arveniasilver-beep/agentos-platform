import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

@Module({
  imports: [AuthModule, SecretsModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, WorkspaceRoleGuard],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
