import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MemberRole } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ROLE_ORDER } from '../rbac/roles';
import type { CreateWorkspaceDto, AddMemberDto } from './dto';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, dto: CreateWorkspaceDto) {
    const exists = await this.prisma.workspace.findUnique({ where: { slug: dto.slug } });
    if (exists) {
      throw new ConflictException('Workspace slug already taken');
    }
    const workspace = await this.prisma.workspace.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        ownerUserId: userId,
        members: { create: { userId, role: 'owner', joinedAt: new Date() } },
      },
    });
    await this.audit.record({
      workspaceId: workspace.id,
      actorUserId: userId,
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: workspace.id,
      risk: 'low',
    });
    return workspace;
  }

  /** Only workspaces the user is a member of (tenancy). */
  listForUser(userId: string) {
    return this.prisma.workspace.findMany({
      where: { members: { some: { userId } }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }
    return ws;
  }

  /** Actor's role in the workspace (owner outranks all). */
  private async actorRole(workspaceId: string, actorUserId: string): Promise<MemberRole> {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actorUserId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this workspace');
    return m.role;
  }

  /** A non-owner may only assign a role strictly below their own; the owner may assign any. */
  private assertCanAssign(actor: MemberRole, role: MemberRole): void {
    if (actor !== 'owner' && ROLE_ORDER[role] >= ROLE_ORDER[actor]) {
      throw new ForbiddenException('You cannot assign a role at or above your own.');
    }
  }

  async addMember(workspaceId: string, actorUserId: string, dto: AddMemberDto) {
    const actor = await this.actorRole(workspaceId, actorUserId);
    this.assertCanAssign(actor, dto.role);
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new NotFoundException('No user with that email');
    }
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (existing) {
      throw new ConflictException('User is already a member');
    }
    const membership = await this.prisma.workspaceMember.create({
      data: { workspaceId, userId: user.id, role: dto.role, joinedAt: new Date() },
    });
    await this.audit.record({
      workspaceId,
      actorUserId,
      action: 'member.add',
      targetType: 'user',
      targetId: user.id,
      risk: 'medium',
      metadata: { role: dto.role },
    });
    return membership;
  }

  listMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Authorize a member-management action: the target must exist, must not be the owner, and a
   * non-owner actor may only act on a member STRICTLY below their own role (so admins can't manage
   * peer admins, grant admin, or demote/remove themselves). Returns the target membership.
   */
  private async authorizeMemberMgmt(
    workspaceId: string,
    actorUserId: string,
    memberUserId: string,
  ) {
    const [actor, target] = await Promise.all([
      this.actorRole(workspaceId, actorUserId),
      this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: memberUserId } },
      }),
    ]);
    if (!target) {
      throw new NotFoundException('Member not found in this workspace');
    }
    if (target.role === 'owner') {
      throw new ForbiddenException('The workspace owner cannot be changed or removed');
    }
    if (actor !== 'owner' && ROLE_ORDER[target.role] >= ROLE_ORDER[actor]) {
      throw new ForbiddenException('You can only manage members with a role below your own.');
    }
    return { actor, target };
  }

  async updateMemberRole(
    workspaceId: string,
    actorUserId: string,
    memberUserId: string,
    role: Exclude<MemberRole, 'owner'>,
  ) {
    const { actor } = await this.authorizeMemberMgmt(workspaceId, actorUserId, memberUserId);
    this.assertCanAssign(actor, role);
    const updated = await this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: memberUserId } },
      data: { role },
    });
    await this.audit.record({
      workspaceId,
      actorUserId,
      action: 'member.update_role',
      targetType: 'user',
      targetId: memberUserId,
      risk: 'medium',
      metadata: { role },
    });
    return updated;
  }

  async removeMember(workspaceId: string, actorUserId: string, memberUserId: string) {
    await this.authorizeMemberMgmt(workspaceId, actorUserId, memberUserId);
    await this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: memberUserId } },
    });
    await this.audit.record({
      workspaceId,
      actorUserId,
      action: 'member.remove',
      targetType: 'user',
      targetId: memberUserId,
      risk: 'medium',
    });
    return { removed: true };
  }
}
