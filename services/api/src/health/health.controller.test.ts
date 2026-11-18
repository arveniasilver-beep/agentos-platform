import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION } from '@agentos/protocol';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok with service identity and protocol version', () => {
    const result = new HealthController().check();
    expect(result.status).toBe('ok');
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.service.length).toBeGreaterThan(0);
  });
});
