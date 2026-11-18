import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MemberRole } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionUser } from '../auth/auth.service';
import { MIN_ROLE_KEY } from './min-role.decorator';
import { hasAtLeast } from './roles';

interface RequestWithMembership {
  params?: Record<string, string>;
  user?: SessionUser;
  membership?: { role: MemberRole };
}

/**
 * Enforces workspace tenancy + RBAC: the authenticated user must be a member of the
 * `:workspaceId` in the route, with at least the role declared via `@MinRole(...)`.
 * Runs after AuthGuard (which sets req.user).
 */
@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithMembership>();
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }
    const workspaceId = req.params?.workspaceId;
    if (!workspaceId) {
      throw new ForbiddenException('Missing workspace context');
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    const min = this.reflector.get<MemberRole>(MIN_ROLE_KEY, ctx.getHandler()) ?? 'viewer';
    if (!hasAtLeast(membership.role, min)) {
      throw new ForbiddenException(`Requires role of at least "${min}"`);
    }

    req.membership = { role: membership.role };
    return true;
  }
}
