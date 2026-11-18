import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service';

/** Central policy engine + risk classifiers (TICKET-POLICY). */
@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
