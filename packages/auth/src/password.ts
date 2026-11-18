import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Typed wrapper around scrypt's options overload (promisify can't pick the right overload).
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const SALT_LEN = 16;
const KEY_LEN = 64;
// scrypt cost parameters (memory ≈ 128 * N * r = 16 MiB at these settings).
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Hash a password with scrypt (built-in, no native dependency). Format is self-describing so
 * parameters can evolve; swap to argon2id later behind this same interface without a data change.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = (await scryptAsync(password, salt, KEY_LEN, PARAMS)) as Buffer;
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verify a password against a stored hash, in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (!saltB64 || !hashB64) return false;

  const cost = { N: Number(nStr), r: Number(rStr), p: Number(pStr), maxmem: PARAMS.maxmem };
  if (!Number.isFinite(cost.N) || !Number.isFinite(cost.r) || !Number.isFinite(cost.p)) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const salt = Buffer.from(saltB64, 'base64');
  const derived = (await scryptAsync(password, salt, expected.length, cost)) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
