import { describe, it, expect } from 'vitest';
import { loadServerEnv } from './env';

describe('loadServerEnv', () => {
  it('applies defaults for a minimal environment', () => {
    const env = loadServerEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces a string API_PORT to a number', () => {
    const env = loadServerEnv({ API_PORT: '8080' });
    expect(env.API_PORT).toBe(8080);
  });

  it('throws a readable error on a non-numeric API_PORT', () => {
    expect(() => loadServerEnv({ API_PORT: 'not-a-number' })).toThrowError(/API_PORT/);
  });

  it('throws on an invalid NODE_ENV', () => {
    expect(() => loadServerEnv({ NODE_ENV: 'staging' })).toThrowError(/NODE_ENV/);
  });

  it('rejects a malformed DATABASE_URL when provided', () => {
    expect(() => loadServerEnv({ DATABASE_URL: 'not a url' })).toThrowError(/DATABASE_URL/);
  });

  it('accepts a valid DATABASE_URL', () => {
    const env = loadServerEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/agentos' });
    expect(env.DATABASE_URL).toContain('postgres://');
  });
});
