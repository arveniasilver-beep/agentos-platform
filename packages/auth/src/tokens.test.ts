import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, safeEqual } from './tokens';

describe('tokens', () => {
  it('generates distinct URL-safe tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically (same input -> same hash)', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('safeEqual compares correctly', () => {
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'other')).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
  });
});
