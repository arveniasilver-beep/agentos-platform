import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SecretsModule } from '../secrets/secrets.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';

@Module({
  imports: [AuthModule, SecretsModule],
  controllers: [MediaController],
  providers: [MediaService, WorkspaceRoleGuard],
  exports: [MediaService],
})
export class MediaModule {}
