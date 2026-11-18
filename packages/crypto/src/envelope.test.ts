import { describe, it, expect } from 'vitest';
import { EnvelopeCipher, lastFour } from './envelope';

const masterKey = Buffer.from(EnvelopeCipher.generateMasterKeyBase64(), 'base64');
const cipher = new EnvelopeCipher(masterKey);

describe('EnvelopeCipher', () => {
  it('round-trips a secret', () => {
    const secret = 'sk-ant-super-secret-value-1234';
    const enc = cipher.encrypt(secret);
    expect(cipher.decrypt(enc)).toBe(secret);
  });

  it('stores only ciphertext (plaintext never appears in the encrypted payload)', () => {
    const secret = 'my-plaintext-key';
    const enc = cipher.encrypt(secret);
    expect(enc.ciphertext.toString('utf8')).not.toContain(secret);
    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(enc.wrappedDataKey.length).toBe(12 + 16 + 32);
    expect(enc.lastFour).toBe('-key');
  });

  it('produces different ciphertext each time (random DEK + IV)', () => {
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(cipher.decrypt(a)).toBe('same');
    expect(cipher.decrypt(b)).toBe('same');
  });

  it('fails to decrypt tampered ciphertext (GCM auth)', () => {
    const enc = cipher.encrypt('integrity-protected');
    enc.ciphertext[0] = (enc.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(enc)).toThrow();
  });

  it('fails to decrypt with the wrong master key', () => {
    const enc = cipher.encrypt('cross-key');
    const other = new EnvelopeCipher(Buffer.from(EnvelopeCipher.generateMasterKeyBase64(), 'base64'));
    expect(() => other.decrypt(enc)).toThrow();
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => new EnvelopeCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('lastFour', () => {
  it('returns the last 4 characters, or the whole short value', () => {
    expect(lastFour('abcdef')).toBe('cdef');
    expect(lastFour('ab')).toBe('ab');
  });
});
