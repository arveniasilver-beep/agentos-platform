import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { PlaybooksService } from './playbooks.service';
import { PlaybooksController } from './playbooks.controller';

@Module({
  imports: [AuthModule],
  controllers: [PlaybooksController],
  providers: [PlaybooksService, WorkspaceRoleGuard],
  exports: [PlaybooksService],
})
export class PlaybooksModule {}
