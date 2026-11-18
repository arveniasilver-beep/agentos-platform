import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** Blob storage for durable artifacts (S3/MinIO when configured, else a durable local store). */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
