import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { LlmProviderFactory } from '../tasks/llm-provider.factory';
import { PeerService } from './peer.service';

/** Cross-model peer consultation (brain ⇄ peer, e.g. DeepSeek ⇄ MiMo-VL). Provides its own
 * LlmProviderFactory (a stateless SecretsService wrapper) to avoid a TasksModule import cycle. */
@Module({
  imports: [SecretsModule],
  providers: [PeerService, LlmProviderFactory],
  exports: [PeerService],
})
export class PeerModule {}
