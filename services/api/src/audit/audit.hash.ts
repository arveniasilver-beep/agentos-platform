import { createHash } from 'node:crypto';

export interface AuditHashFields {
  action: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  createdAtIso: string;
}

/**
 * Tamper-evidence hash chain: each row's hash = sha256(prevHash + core fields).
 * Metadata (jsonb, key-order-unstable) is intentionally excluded from the hash.
 */
export function computeAuditHash(prevHash: string | null, f: AuditHashFields): string {
  const canonical = JSON.stringify({
    prev: prevHash ?? '',
    a: f.action,
    u: f.actorUserId ?? '',
    tt: f.targetType ?? '',
    ti: f.targetId ?? '',
    t: f.createdAtIso,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
