import { Module } from '@nestjs/common';
import { CodingWorkspaceService } from './coding.service';

@Module({
  providers: [CodingWorkspaceService],
  exports: [CodingWorkspaceService],
})
export class CodingModule {}
