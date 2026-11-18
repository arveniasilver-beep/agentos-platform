import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { StorageModule } from '../storage/storage.module';
import { ArtifactsController, LibraryController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [ArtifactsController, LibraryController],
  providers: [ArtifactsService, WorkspaceRoleGuard],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
