import { describe, it, expect } from 'vitest';
import {
  IPC_CHANNELS,
  isAllowedChannel,
  validateRequest,
  validateResponse,
} from './contracts';

describe('IPC allowlist', () => {
  it('exposes exactly the expected channels (no surprise passthrough)', () => {
    expect([...IPC_CHANNELS].sort()).toEqual(['app:apiStatus', 'app:getInfo', 'app:ping']);
  });

  it('accepts allowlisted channels and rejects everything else', () => {
    expect(isAllowedChannel('app:getInfo')).toBe(true);
    expect(isAllowedChannel('app:ping')).toBe(true);
    expect(isAllowedChannel('app:apiStatus')).toBe(true);
    expect(isAllowedChannel('evil:channel')).toBe(false);
    expect(isAllowedChannel('fs:readFile')).toBe(false);
  });
});

describe('IPC payload validation', () => {
  it('validates ping request/response', () => {
    expect(validateRequest('app:ping', { at: 123 })).toEqual({ at: 123 });
    expect(() => validateRequest('app:ping', {})).toThrow();
    expect(validateResponse('app:ping', { pong: true, at: 1 })).toEqual({ pong: true, at: 1 });
  });

  it('validates getInfo response shape', () => {
    const ok = { name: 'x', appId: 'com.x.y', protocolVersion: '1.0.0' };
    expect(validateResponse('app:getInfo', ok)).toEqual(ok);
    expect(() => validateResponse('app:getInfo', { name: 'x' })).toThrow();
  });

  it('validates apiStatus response shape', () => {
    expect(validateResponse('app:apiStatus', { ok: true, origin: 'http://localhost:4000' })).toEqual({
      ok: true,
      origin: 'http://localhost:4000',
    });
    expect(() => validateResponse('app:apiStatus', { ok: 'yes' })).toThrow();
  });
});
