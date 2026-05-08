import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';
import { assertChapterCharacterExecution, assertVolumeCharacterPlan, VolumeCharacterPlan } from './outline-character-contracts';

interface PersistOutlineInput {
  preview?: OutlinePreviewOutput;
  validation?: { valid?: boolean };
}

interface CharacterCatalog {
  existingCharacterNames: string[];
  existingCharacterAliases: Record<string, string[]>;
}

/**
 * 大纲持久化工具：用户审批后将预览写入 Volume 和 Chapter。
 * 为避免覆盖已写正文，本工具只创建缺失章节并更新未起草章节的大纲字段。
 */
@Injectable()
export class PersistOutlineTool implements BaseTool<PersistOutlineInput, Record<string, unknown>> {
  name = 'persist_outline';
  description = '审批后将大纲预览写入卷和章节，只更新未起草章节，避免覆盖已确认正文。';
  inputSchema = { type: 'object' as const, required: ['preview'], additionalProperties: false, properties: { preview: { type: 'object' as const, required: ['volume', 'chapters'], properties: { volume: { type: 'object' as const }, chapters: { type: 'array' as const } } }, validation: { type: 'object' as const, properties: { valid: { type: 'boolean' as const } } } } };
  outputSchema = {
    type: 'object' as const,
    required: ['volumeId', 'createdCount', 'updatedCount', 'skippedCount', 'chapterCount'],
    properties: {
      volumeId: { type: 'string' as const, minLength: 1 },
      createdCount: { type: 'number' as const, minimum: 0 },
      updatedCount: { type: 'number' as const, minimum: 0 },
      skippedCount: { type: 'number' as const, minimum: 0 },
      chapterCount: { type: 'number' as const, minimum: 0 },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['upsert_volume', 'create_or_update_planned_chapters'];

  constructor(private readonly prisma: PrismaService) {}

  async run(args: PersistOutlineInput, context: ToolContext) {
    if (!args.preview?.chapters?.length) throw new BadRequestException('persist_outline 需要 outline preview');
    if (args.validation && args.validation.valid !== true) {
      throw new BadRequestException('persist_outline requires validate_outline to return valid=true before writing.');
    }
    const preview = args.preview;
    const characterCatalog = await this.loadCharacterCatalog(context.projectId);
    this.assertSafePreview(preview, characterCatalog);

    const result = await this.prisma.$transaction(async (tx) => {
      const narrativePlan = this.asInputJsonObject(preview.volume.narrativePlan);
      const volumeData = {
        title: preview.volume.title,
        synopsis: preview.volume.synopsis,
        objective: preview.volume.objective,
        chapterCount: preview.volume.chapterCount,
        ...(narrativePlan ? { narrativePlan } : {}),
      };
      const volume = await tx.volume.upsert({
        where: { projectId_volumeNo: { projectId: context.projectId, volumeNo: preview.volume.volumeNo } },
        update: volumeData,
        create: { projectId: context.projectId, volumeNo: preview.volume.volumeNo, ...volumeData },
      });

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      for (const chapter of preview.chapters) {
        const existing = await tx.chapter.findUnique({ where: { projectId_chapterNo: { projectId: context.projectId, chapterNo: chapter.chapterNo } } });
        const craftBrief = this.asInputJsonObject(chapter.craftBrief);
        const data = {
          volumeId: volume.id,
          title: chapter.title,
          objective: chapter.objective,
          conflict: chapter.conflict,
          revealPoints: chapter.hook,
          outline: chapter.outline,
          expectedWordCount: chapter.expectedWordCount,
          ...(craftBrief ? { craftBrief } : {}),
        };
        if (!existing) {
          await tx.chapter.create({ data: { projectId: context.projectId, chapterNo: chapter.chapterNo, ...data } });
          createdCount += 1;
        } else if (existing.status === 'planned') {
          await tx.chapter.update({ where: { id: existing.id }, data });
          updatedCount += 1;
        } else {
          // 已起草/已审阅章节不自动覆盖，避免 Agent 破坏用户确认过的正文和事实。
          skippedCount += 1;
        }
      }
      return { volumeId: volume.id, createdCount, updatedCount, skippedCount };
    });

    return { ...result, chapterCount: preview.chapters.length, risks: preview.risks };
  }

  /** 写入前做一次确定性保护，防止绕过 validate_outline 的重复编号预览进入持久化。 */
  private assertSafePreview(preview: OutlinePreviewOutput, characterCatalog: CharacterCatalog) {
    const chapterNos = preview.chapters.map((chapter) => Number(chapter.chapterNo));
    if (!Number.isFinite(Number(preview.volume.volumeNo)) || Number(preview.volume.volumeNo) <= 0) throw new BadRequestException('卷号必须是正数');
    if (chapterNos.some((chapterNo) => !Number.isFinite(chapterNo) || chapterNo <= 0)) throw new BadRequestException('章节编号必须是正数');
    const duplicated = chapterNos.filter((chapterNo, index) => chapterNos.indexOf(chapterNo) !== index);
    if (duplicated.length) throw new BadRequestException(`章节编号重复，已阻止写入：${[...new Set(duplicated)].join(', ')}`);
    if (Number(preview.volume.chapterCount) !== preview.chapters.length) {
      throw new BadRequestException('persist_outline blocked: volume.chapterCount must equal preview chapter count.');
    }

    try {
      const characterPlan = assertVolumeCharacterPlan(this.asRecord(preview.volume.narrativePlan).characterPlan, {
        chapterCount: Number(preview.volume.chapterCount),
        existingCharacterNames: characterCatalog.existingCharacterNames,
        existingCharacterAliases: characterCatalog.existingCharacterAliases,
        label: 'volume.narrativePlan.characterPlan',
      });
      this.assertChapterCharacterExecutions(preview, characterPlan, characterCatalog);
    } catch (error) {
      throw new BadRequestException(`persist_outline blocked by character planning validation: ${this.errorMessage(error)}`);
    }
  }

  private assertChapterCharacterExecutions(preview: OutlinePreviewOutput, characterPlan: VolumeCharacterPlan, characterCatalog: CharacterCatalog): void {
    const existingCharacterNames = [
      ...characterCatalog.existingCharacterNames,
      ...characterPlan.existingCharacterArcs.map((arc) => arc.characterName),
    ];
    const volumeCandidateNames = characterPlan.newCharacterCandidates.map((candidate) => candidate.name);
    for (const chapter of preview.chapters) {
      const craftBrief = this.asRecord(chapter.craftBrief);
      assertChapterCharacterExecution(craftBrief.characterExecution, {
        existingCharacterNames,
        existingCharacterAliases: characterCatalog.existingCharacterAliases,
        volumeCandidateNames,
        sceneBeats: this.asRecordArray(craftBrief.sceneBeats).map((sceneBeat) => ({
          sceneArcId: this.text(sceneBeat.sceneArcId),
          participants: this.stringArray(sceneBeat.participants),
        })),
        actionBeatCount: this.stringArray(craftBrief.actionBeats).length,
        label: `chapter ${chapter.chapterNo}.craftBrief.characterExecution`,
      });
    }
  }

  private async loadCharacterCatalog(projectId: string): Promise<CharacterCatalog> {
    const characterModel = (this.prisma as unknown as {
      character?: { findMany?: (args: unknown) => Promise<Array<{ name: string; alias?: unknown }>> };
    }).character;
    if (!characterModel?.findMany) return { existingCharacterNames: [], existingCharacterAliases: {} };

    const characters = await characterModel.findMany({
      where: { projectId },
      select: { name: true, alias: true },
    });
    const existingCharacterAliases: Record<string, string[]> = {};
    for (const character of characters) {
      const aliases = Array.isArray(character.alias)
        ? character.alias.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
        : [];
      if (aliases.length) existingCharacterAliases[character.name] = aliases;
    }
    return {
      existingCharacterNames: characters.map((character) => character.name).filter(Boolean),
      existingCharacterAliases,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter((item) => Object.keys(item).length > 0)
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private asInputJsonObject(value: unknown): Prisma.InputJsonObject | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length ? record as Prisma.InputJsonObject : undefined;
  }
}
