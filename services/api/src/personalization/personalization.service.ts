import { Injectable } from '@nestjs/common';
import { Prisma } from '@agentos/db';
import { PrismaService } from '../prisma/prisma.service';
import { composePersonalizationPreamble } from './personalization.prompt';

export interface PersonalizationView {
  nickname: string | null;
  profession: string | null;
  about: string | null;
  instructions: string | null;
  memories: string[];
}

export interface UpdatePersonalizationInput {
  nickname?: string | null;
  profession?: string | null;
  about?: string | null;
  instructions?: string | null;
  memories?: string[];
}

const EMPTY: PersonalizationView = {
  nickname: null,
  profession: null,
  about: null,
  instructions: null,
  memories: [],
};

/** Coerce the JSON `memories` column to a clean string[] (defensive against legacy/garbled rows). */
function toMemories(value: Prisma.JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is string => typeof m === 'string');
}

/**
 * Workspace-level agent personalization (Manus "Kişiselleştirme"): the profile, custom instructions,
 * and remembered facts that the engine prepends to every task's system prompt. One row per
 * workspace, tenancy-scoped by RLS (the request runs in the workspace's tenant context).
 */
@Injectable()
export class PersonalizationService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<PersonalizationView> {
    const row = await this.prisma.personalization.findUnique({ where: { workspaceId } });
    if (!row) return EMPTY;
    return {
      nickname: row.nickname,
      profession: row.profession,
      about: row.about,
      instructions: row.instructions,
      memories: toMemories(row.memories),
    };
  }

  async update(workspaceId: string, dto: UpdatePersonalizationInput): Promise<PersonalizationView> {
    // Normalize blanks to null so an empty field clears rather than stores "".
    const norm = (v: string | null | undefined): string | null => {
      if (v === undefined) return undefined as unknown as string | null; // not provided => leave as-is on update
      const t = v?.trim();
      return t ? t : null;
    };
    const data = {
      ...(dto.nickname !== undefined ? { nickname: norm(dto.nickname) } : {}),
      ...(dto.profession !== undefined ? { profession: norm(dto.profession) } : {}),
      ...(dto.about !== undefined ? { about: norm(dto.about) } : {}),
      ...(dto.instructions !== undefined ? { instructions: norm(dto.instructions) } : {}),
      ...(dto.memories !== undefined
        ? { memories: dto.memories.map((m) => m.trim()).filter(Boolean) as unknown as Prisma.InputJsonValue }
        : {}),
    };
    const row = await this.prisma.personalization.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        nickname: norm(dto.nickname),
        profession: norm(dto.profession),
        about: norm(dto.about),
        instructions: norm(dto.instructions),
        memories: (dto.memories?.map((m) => m.trim()).filter(Boolean) ?? []) as unknown as Prisma.InputJsonValue,
      },
      update: data,
    });
    return {
      nickname: row.nickname,
      profession: row.profession,
      about: row.about,
      instructions: row.instructions,
      memories: toMemories(row.memories),
    };
  }

  /**
   * Build the system-prompt preamble for a task run, or undefined when nothing is configured.
   * Called from the task runner (system/bypass tenant context), so it awaits the read inline.
   */
  async buildPreamble(workspaceId: string): Promise<string | undefined> {
    const row = await this.prisma.personalization.findUnique({ where: { workspaceId } });
    if (!row) return undefined;
    return composePersonalizationPreamble({
      nickname: row.nickname,
      profession: row.profession,
      about: row.about,
      instructions: row.instructions,
      memories: toMemories(row.memories),
    });
  }
}
