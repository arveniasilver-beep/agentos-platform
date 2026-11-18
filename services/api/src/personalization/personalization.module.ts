import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { PersonalizationService } from './personalization.service';
import { PersonalizationController } from './personalization.controller';

@Module({
  imports: [AuthModule],
  controllers: [PersonalizationController],
  providers: [PersonalizationService, WorkspaceRoleGuard],
  exports: [PersonalizationService],
})
export class PersonalizationModule {}
