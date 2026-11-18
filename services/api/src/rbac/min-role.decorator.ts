import { SetMetadata } from '@nestjs/common';
import type { MemberRole } from '@agentos/db';

export const MIN_ROLE_KEY = 'minRole';

/** Declares the minimum workspace role required to call a handler (enforced by WorkspaceRoleGuard). */
export const MinRole = (role: MemberRole) => SetMetadata(MIN_ROLE_KEY, role);
