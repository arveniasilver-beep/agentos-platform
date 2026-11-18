import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION } from '@agentos/protocol';
import { getSiteInfo } from './site';

describe('getSiteInfo', () => {
  it('exposes brand identity and protocol version from the shared packages', () => {
    const info = getSiteInfo();
    expect(info.name.length).toBeGreaterThan(0);
    expect(info.shortName.length).toBeGreaterThan(0);
    expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
