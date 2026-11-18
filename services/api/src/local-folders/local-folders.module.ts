import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceRoleGuard } from '../rbac/workspace-role.guard';
import { LocalFoldersService } from './local-folders.service';
import { LocalFoldersController } from './local-folders.controller';

@Module({
  imports: [AuthModule],
  controllers: [LocalFoldersController],
  providers: [LocalFoldersService, WorkspaceRoleGuard],
  exports: [LocalFoldersService],
})
export class LocalFoldersModule {}
