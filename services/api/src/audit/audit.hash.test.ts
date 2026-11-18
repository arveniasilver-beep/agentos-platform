import { describe, it, expect } from 'vitest';
import { computeAuditHash, type AuditHashFields } from './audit.hash';

const base: AuditHashFields = {
  action: 'secret.set',
  actorUserId: 'u1',
  targetType: 'secret',
  targetId: 'id1',
  createdAtIso: '2026-01-01T00:00:00.000Z',
};

describe('computeAuditHash', () => {
  it('is deterministic for the same inputs', () => {
    expect(computeAuditHash(null, base)).toBe(computeAuditHash(null, base));
  });

  it('chains: different prevHash yields a different hash', () => {
    expect(computeAuditHash('aaa', base)).not.toBe(computeAuditHash('bbb', base));
  });

  it('changes when a core field changes', () => {
    expect(computeAuditHash(null, base)).not.toBe(
      computeAuditHash(null, { ...base, action: 'secret.delete' }),
    );
  });
});
