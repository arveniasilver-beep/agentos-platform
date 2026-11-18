import { describe, it, expect } from 'vitest';
import { getPrisma } from './index';

describe('getPrisma', () => {
  it('returns a singleton PrismaClient instance (no DB connection)', () => {
    expect(getPrisma()).toBe(getPrisma());
  });
});
