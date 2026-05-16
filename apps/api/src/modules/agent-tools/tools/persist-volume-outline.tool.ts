import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { replaceVolumeOutlineForeshadowTracks } from './foreshadow-track-sync';
import type { VolumeOutlinePreviewOutput } from './generate-volume-outline-preview.tool';
import { assertVolumeNarrativePlan } from './outline-narrative-contracts';

interface PersistVolumeOutlineInput {
  preview?: VolumeOutlinePreviewOutput;
}

interface CharacterCatalog {
  existingCharacterNames: string[];
  existingCharacterAliases: Record<string, string[]>;
}

@Injectable()
export class PersistVolumeOutlineTool implements BaseTool<PersistVolumeOutlineInput, Record<string, unknown>> {
  name = 'persist_volume_outline';
  description = '审批后只写入卷大纲和 Volume.narrativePlan，不创建或更新章节细纲。';
  inputSchema = {
    type: 'object' as const,
    required: ['preview'],
    additionalProperties: false,
    properties: {
      preview: {
        type: 'object' as const,
        required: ['volume'],
        properties: {
          volume: { type: 'object' as const },
          risks: { type: 'array' as const, items: { type: 'string' as const } },
        },
      },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volumeId', 'volumeNo', 'chapterCount', 'updatedVolumeOnly'],
    properties: {
      volumeId: { type: 'string' as const, minLength: 1 },
      volumeNo: { type: 'number' as const, minimum: 1 },
      chapterCount: { type: 'number' as const, minimum: 1 },
      updatedVolumeOnly: { type: 'boolean' as const },
      preservedStoryUnitPlan: { type: 'boolean' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['upsert_volume', 'replace_volume_outline_foreshadows'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '写入卷大纲',
    description: '审批后只更新 Volume 的 title、synopsis、objective、chapterCount 和 narrativePlan；不会生成、创建或覆盖任何 Chapter.craftBrief。',
    whenToUse: [
      '用户只要求生成或重写某一卷的大纲、卷大纲、卷级规划，且没有要求章节细纲、拆成 N 章或 Chapter.craftBrief 时',
      '上一步输出来自 generate_volume_outline_preview，需要审批后写入 Volume 时',
    ],
    whenNotToUse: [
      '用户要求卷细纲、章节细纲、60 章细纲、等长细纲、拆卷到章节时使用 persist_outline',
      '用户要求写章节正文时使用 write_chapter 或 write_chapter_series',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'generate_volume_outline_preview.output；必须包含完整 volume.narrativePlan。' },
    },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly prisma: PrismaService, private readonly cacheService?: NovelCacheService) {}

  async run(args: PersistVolumeOutlineInput, context: ToolContext) {
    if (context.mode !== 'act') throw new BadRequestException('persist_volume_outline must run in act mode.');
    if (!context.approved) throw new BadRequestException('persist_volume_outline requires explicit user approval.');
    if (!args.preview?.volume) throw new BadRequestException('persist_volume_outline 需要卷大纲预览。');

    const preview = args.preview;
    const volume = preview.volume;
    const chapterCount = Number(volume.chapterCount);
    if (!Number.isInteger(chapterCount) || chapterCount < 1) {
      throw new BadRequestException('persist_volume_outline blocked: volume.chapterCount must be a positive integer.');
    }
    const volumeNo = Number(volume.volumeNo);
    if (!Number.isInteger(volumeNo) || volumeNo < 1) throw new BadRequestException('persist_volume_outline blocked: volumeNo must be a positive integer.');

    const characterCatalog = await this.loadCharacterCatalog(context.projectId);
    const narrativePlan = assertVolumeNarrativePlan(volume.narrativePlan, {
      chapterCount,
      existingCharacterNames: characterCatalog.existingCharacterNames,
      existingCharacterAliases: characterCatalog.existingCharacterAliases,
      label: 'volume.narrativePlan',
    });

    const existingNarrativePlan = await this.loadExistingNarrativePlan(context.projectId, volumeNo);
    const narrativePlanForUpdate = this.preserveExistingStoryUnitPlan(narrativePlan, existingNarrativePlan);
    const preservedStoryUnitPlan = !this.hasOwn(narrativePlan, 'storyUnitPlan') && this.hasOwn(existingNarrativePlan, 'storyUnitPlan');

    const result = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.volume.upsert({
        where: { projectId_volumeNo: { projectId: context.projectId, volumeNo } },
        update: {
          title: this.requiredText(volume.title, 'volume.title'),
          synopsis: this.requiredText(volume.synopsis, 'volume.synopsis'),
          objective: this.requiredText(volume.objective, 'volume.objective'),
          chapterCount,
          narrativePlan: narrativePlanForUpdate,
        },
        create: {
          projectId: context.projectId,
          volumeNo,
          title: this.requiredText(volume.title, 'volume.title'),
          synopsis: this.requiredText(volume.synopsis, 'volume.synopsis'),
          objective: this.requiredText(volume.objective, 'volume.objective'),
          chapterCount,
          narrativePlan: narrativePlan as Prisma.InputJsonObject,
        },
      });

      const foreshadowTracks = await replaceVolumeOutlineForeshadowTracks(tx, {
        projectId: context.projectId,
        volumeId: saved.id,
        volumeNo,
        chapterCount,
        narrativePlan: narrativePlanForUpdate,
      });

      return {
        volumeId: saved.id,
        volumeNo,
        chapterCount,
        updatedVolumeOnly: true,
        preservedStoryUnitPlan,
        foreshadowTrackCreatedCount: foreshadowTracks.createdCount,
        foreshadowTrackDeletedCount: foreshadowTracks.deletedCount,
        risks: preview.risks ?? [],
      };
    });

    if (result.foreshadowTrackCreatedCount > 0 || result.foreshadowTrackDeletedCount > 0) {
      await this.cacheService?.deleteProjectRecallResults(context.projectId);
    }

    return result;
  }

  private async loadExistingNarrativePlan(projectId: string, volumeNo: number): Promise<Record<string, unknown>> {
    const volumeModel = (this.prisma as unknown as {
      volume?: {
        findUnique?: (args: unknown) => Promise<{ narrativePlan?: unknown } | null>;
      };
    }).volume;
    if (!volumeModel?.findUnique) return {};

    const existing = await volumeModel.findUnique({
      where: { projectId_volumeNo: { projectId, volumeNo } },
      select: { narrativePlan: true },
    });
    return this.asRecord(existing?.narrativePlan);
  }

  private preserveExistingStoryUnitPlan(narrativePlan: Record<string, unknown>, existingNarrativePlan: Record<string, unknown>): Prisma.InputJsonObject {
    if (this.hasOwn(narrativePlan, 'storyUnitPlan') || !this.hasOwn(existingNarrativePlan, 'storyUnitPlan')) {
      return narrativePlan as Prisma.InputJsonObject;
    }
    return {
      ...narrativePlan,
      storyUnitPlan: existingNarrativePlan.storyUnitPlan as Prisma.InputJsonValue,
    } as Prisma.InputJsonObject;
  }

  private hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
  }

  private requiredText(value: unknown, label: string): string {
    const text = this.text(value);
    if (!text.trim()) throw new BadRequestException(`persist_volume_outline blocked: missing ${label}.`);
    return text;
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
}
