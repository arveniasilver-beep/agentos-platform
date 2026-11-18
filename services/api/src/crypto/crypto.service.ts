import { Injectable, Logger } from '@nestjs/common';
import { EnvelopeCipher, type EncryptedInput, type EncryptedSecret } from '@agentos/crypto';
import { loadServerEnv } from '@agentos/config';

/** Wraps the envelope cipher with the master key from the environment (server-only). */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly cipher: EnvelopeCipher;
  readonly keyId = 'local-dev-v1';

  constructor() {
    const env = loadServerEnv();
    if (env.MASTER_ENCRYPTION_KEY) {
      this.cipher = EnvelopeCipher.fromBase64(env.MASTER_ENCRYPTION_KEY, this.keyId);
    } else if (env.NODE_ENV === 'production') {
      throw new Error('MASTER_ENCRYPTION_KEY is required in production');
    } else {
      // Deterministic, clearly-insecure DEV key so local dev/e2e works without configuration.
      this.logger.warn('MASTER_ENCRYPTION_KEY not set — using an insecure dev key (dev only).');
      this.cipher = new EnvelopeCipher(Buffer.alloc(32, 7), this.keyId);
    }
  }

  encrypt(plaintext: string): EncryptedSecret {
    return this.cipher.encrypt(plaintext);
  }

  decrypt(input: EncryptedInput): string {
    return this.cipher.decrypt(input);
  }
}
