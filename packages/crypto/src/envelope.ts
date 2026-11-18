import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce
const TAG_LEN = 16; // GCM auth tag
const DEK_LEN = 32; // per-secret data-encryption key

/**
 * Envelope-encrypted payload. Stored as bytes; ciphertext only at rest.
 * `wrappedDataKey` = wrapIv(12) | wrapTag(16) | wrappedKey(32) — the DEK encrypted under the master key.
 */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDataKey: Buffer;
  lastFour: string;
}

export type EncryptedInput = Pick<
  EncryptedSecret,
  'ciphertext' | 'iv' | 'authTag' | 'wrappedDataKey'
>;

/** Mask a secret for display — only the last 4 chars are ever safe to render. */
export function lastFour(value: string): string {
  return value.length <= 4 ? value : value.slice(-4);
}

/**
 * Envelope encryption: each secret gets a fresh random data key (DEK) which encrypts the
 * plaintext (AES-256-GCM); the DEK is then wrapped by the master key. Rotating the master key
 * re-wraps the DEK only — ciphertext is untouched. Decryption happens server-side only.
 */
export class EnvelopeCipher {
  private readonly masterKey: Buffer;
  readonly keyId: string;

  constructor(masterKey: Buffer, keyId = 'local-dev-v1') {
    if (masterKey.length !== KEY_LEN) {
      throw new Error(`master key must be ${KEY_LEN} bytes, got ${masterKey.length}`);
    }
    this.masterKey = masterKey;
    this.keyId = keyId;
  }

  static fromBase64(base64Key: string, keyId?: string): EnvelopeCipher {
    return new EnvelopeCipher(Buffer.from(base64Key, 'base64'), keyId);
  }

  /** Generate a fresh master key (base64) for dev/bootstrap. In prod this comes from a KMS. */
  static generateMasterKeyBase64(): string {
    return randomBytes(KEY_LEN).toString('base64');
  }

  encrypt(plaintext: string): EncryptedSecret {
    const dek = randomBytes(DEK_LEN);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Wrap the DEK under the master key.
    const wrapIv = randomBytes(IV_LEN);
    const wrapCipher = createCipheriv(ALGO, this.masterKey, wrapIv);
    const wrappedKey = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();
    const wrappedDataKey = Buffer.concat([wrapIv, wrapTag, wrappedKey]);

    return { ciphertext, iv, authTag, wrappedDataKey, lastFour: lastFour(plaintext) };
  }

  decrypt(secret: EncryptedInput): string {
    const { wrappedDataKey } = secret;
    const wrapIv = wrappedDataKey.subarray(0, IV_LEN);
    const wrapTag = wrappedDataKey.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const wrappedKey = wrappedDataKey.subarray(IV_LEN + TAG_LEN);

    const unwrap = createDecipheriv(ALGO, this.masterKey, wrapIv);
    unwrap.setAuthTag(wrapTag);
    const dek = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()]);

    const decipher = createDecipheriv(ALGO, dek, secret.iv);
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
  }
}
