import type { MemberRole } from '@agentos/db';

/** Role hierarchy (higher number = more privilege). */
export const ROLE_ORDER: Record<MemberRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** True if `role` is at least as privileged as `min`. */
export function hasAtLeast(role: MemberRole, min: MemberRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[min];
}
