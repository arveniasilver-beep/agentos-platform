import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Skill, type RiskLevel, type Task } from '@agentos/db';
import { loadServerEnv } from '@agentos/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TasksService } from '../tasks/tasks.service';
import type { CreateTaskDto } from '../tasks/dto';
import type { CreateSkillDto, UpdateSkillDto } from './dto';
import { parseParamDefs, validateSkillInput, renderWithParams } from './skill-params';

/**
 * Reusable, named task templates. Running a skill substitutes the caller's input into the
 * instructions ({{input}} placeholder, or appended) and dispatches a fresh task through the normal
 * task pipeline with the skill's default risk ceiling and budgets.
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
  ) {}

  async create(workspaceId: string, userId: string, dto: CreateSkillDto): Promise<Skill> {
    const skill = await this.prisma.skill.create({
      data: {
        workspaceId,
        createdByUserId: userId,
        name: dto.name,
        description: dto.description ?? null,
        instructions: dto.instructions,
        riskCeiling: dto.riskCeiling as RiskLevel,
        ...(dto.stepBudget !== undefined ? { stepBudget: dto.stepBudget } : {}),
        ...(dto.costBudgetUsd !== undefined ? { costBudgetUsd: dto.costBudgetUsd } : {}),
        // Skills v2 (TICKET-4): additive typed params + capability/effort (validated by the DTO).
        ...(dto.params !== undefined ? { params: dto.params as Prisma.InputJsonValue } : {}),
        ...(dto.capability !== undefined ? { capability: dto.capability } : {}),
        ...(dto.effort !== undefined ? { effort: dto.effort } : {}),
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'skill.create',
      targetType: 'skill',
      targetId: skill.id,
      metadata: { name: skill.name },
    });
    return skill;
  }

  async update(
    workspaceId: string,
    skillId: string,
    userId: string,
    dto: UpdateSkillDto,
  ): Promise<Skill> {
    await this.require(workspaceId, skillId);
    const skill = await this.prisma.skill.update({
      where: { id: skillId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.instructions !== undefined ? { instructions: dto.instructions } : {}),
        ...(dto.riskCeiling !== undefined ? { riskCeiling: dto.riskCeiling as RiskLevel } : {}),
        ...(dto.stepBudget !== undefined ? { stepBudget: dto.stepBudget } : {}),
        ...(dto.costBudgetUsd !== undefined ? { costBudgetUsd: dto.costBudgetUsd } : {}),
        ...(dto.params !== undefined ? { params: dto.params as Prisma.InputJsonValue } : {}),
        ...(dto.capability !== undefined ? { capability: dto.capability } : {}),
        ...(dto.effort !== undefined ? { effort: dto.effort } : {}),
        // v2: bump the version on each edit so the run trace attributes behavior to a version.
        ...(loadServerEnv().SKILLS_PLAYBOOKS_V2_ENABLED ? { version: { increment: 1 } } : {}),
      },
    });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'skill.update',
      targetType: 'skill',
      targetId: skillId,
    });
    return skill;
  }

  async remove(workspaceId: string, skillId: string, userId: string): Promise<{ deleted: true }> {
    await this.require(workspaceId, skillId);
    await this.prisma.skill.delete({ where: { id: skillId } });
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'skill.delete',
      targetType: 'skill',
      targetId: skillId,
    });
    return { deleted: true };
  }

  list(workspaceId: string): Promise<Skill[]> {
    return this.prisma.skill.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  get(workspaceId: string, skillId: string): Promise<Skill> {
    return this.require(workspaceId, skillId);
  }

  /** Build the prompt: substitute {{input}} if present, else append the input on its own line. */
  static renderPrompt(instructions: string, input?: string): string {
    const value = input?.trim() ?? '';
    if (instructions.includes('{{input}}')) {
      return instructions.split('{{input}}').join(value);
    }
    return value ? `${instructions}\n\n${value}` : instructions;
  }

  async run(
    workspaceId: string,
    skillId: string,
    userId: string,
    input?: string,
    params?: Record<string, unknown>,
  ): Promise<Task> {
    const skill = await this.require(workspaceId, skillId);
    const v2 = loadServerEnv().SKILLS_PLAYBOOKS_V2_ENABLED;
    let prompt: string;
    const defs = v2 ? parseParamDefs(skill.params) : [];
    if (v2 && defs.length > 0) {
      // Typed-param path: validate caller values, then substitute {{name}} placeholders.
      const { ok, errors, values } = validateSkillInput(defs, params ?? {});
      if (!ok) throw new BadRequestException(`Skill params invalid: ${errors.join('; ')}`);
      prompt = renderWithParams(skill.instructions, values);
      if (input) prompt = SkillsService.renderPrompt(prompt, input); // {{input}} still honored
    } else {
      prompt = SkillsService.renderPrompt(skill.instructions, input);
    }
    // Service-to-service calls bypass the controller's Zod min(1) prompt check, so enforce the
    // non-empty-prompt invariant here (e.g. instructions of just "{{input}}" run with no input).
    if (!prompt.trim()) {
      throw new BadRequestException('Rendered prompt is empty — provide input/params or non-placeholder instructions.');
    }
    const dto: CreateTaskDto = {
      title: skill.name,
      prompt,
      riskCeiling: skill.riskCeiling,
      stepBudget: skill.stepBudget,
      ...(skill.costBudgetUsd !== null ? { costBudgetUsd: Number(skill.costBudgetUsd) } : {}),
      // v2: apply the skill's saved capability mode + effort tier at run time.
      ...(v2 && skill.capability ? { capability: skill.capability as CreateTaskDto['capability'] } : {}),
      ...(v2 && skill.effort ? { effort: skill.effort as CreateTaskDto['effort'] } : {}),
    };
    const task = await this.tasks.createAndStart(workspaceId, userId, dto);
    await this.audit.record({
      workspaceId,
      actorUserId: userId,
      action: 'skill.run',
      targetType: 'skill',
      targetId: skillId,
      // v2: record the version + applied mode in the execution trace (no secrets).
      metadata: { taskId: task.id, version: skill.version, capability: v2 ? skill.capability : null, effort: v2 ? skill.effort : null, paramCount: defs.length },
    });
    return task;
  }

  private async require(workspaceId: string, skillId: string): Promise<Skill> {
    const skill = await this.prisma.skill.findFirst({ where: { id: skillId, workspaceId } });
    if (!skill) throw new NotFoundException('Skill not found in this workspace.');
    return skill;
  }
}
