import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import { ImportPreviewOutput } from './build-import-preview.tool';

interface PersistProjectAssetsInput {
  preview?: ImportPreviewOutput;
}

/**
 * 项目资料导入工具：审批后把导入预览写入项目、角色、设定、卷和计划章节。
 * 只追加角色/设定，并只创建缺失章节或更新 planned 章节，降低批量导入污染风险。
 */
@Injectable()
export class PersistProjectAssetsTool implements BaseTool<PersistProjectAssetsInput, Record<string, unknown>> {
  name = 'persist_project_assets';
  description = '审批后将文案拆解预览写入项目资料、角色、设定、卷和章节。';
  inputSchema = { type: 'object' as const, required: ['preview'], additionalProperties: false, properties: { preview: { type: 'object' as const, required: ['projectProfile', 'characters', 'lorebookEntries', 'volumes', 'chapters'], properties: { projectProfile: { type: 'object' as const }, characters: { type: 'array' as const }, lorebookEntries: { type: 'array' as const }, volumes: { type: 'array' as const }, chapters: { type: 'array' as const } } } } };
  outputSchema = {
    type: 'object' as const,
    required: ['characterCreatedCount', 'lorebookCreatedCount', 'volumeCount', 'chapterCreatedCount', 'chapterUpdatedCount', 'chapterSkippedCount'],
    properties: {
      characterCreatedCount: { type: 'number' as const, minimum: 0 },
      lorebookCreatedCount: { type: 'number' as const, minimum: 0 },
      volumeCount: { type: 'number' as const, minimum: 0 },
      chapterCreatedCount: { type: 'number' as const, minimum: 0 },
      chapterUpdatedCount: { type: 'number' as const, minimum: 0 },
      chapterSkippedCount: { type: 'number' as const, minimum: 0 },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['update_project_profile', 'create_characters', 'create_lorebook_entries', 'upsert_volumes', 'create_or_update_planned_chapters'];

  constructor(private readonly prisma: PrismaService) {}

  async run(args: PersistProjectAssetsInput, context: ToolContext) {
    if (!args.preview) throw new BadRequestException('persist_project_assets 需要 import preview');
    const preview = args.preview;

    return this.prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: context.projectId },
        data: {
          title: preview.projectProfile.title || undefined,
          genre: preview.projectProfile.genre,
          theme: preview.projectProfile.theme,
          tone: preview.projectProfile.tone,
          logline: preview.projectProfile.logline,
          synopsis: preview.projectProfile.synopsis,
          outline: preview.projectProfile.outline,
        },
      });

      const existingCharacters = await tx.character.findMany({ where: { projectId: context.projectId }, select: { name: true } });
      const existingNames = new Set(existingCharacters.map((item) => item.name));
      let characterCreatedCount = 0;
      for (const character of preview.characters) {
        if (existingNames.has(character.name)) continue;
        await tx.character.create({ data: { projectId: context.projectId, name: character.name, roleType: character.roleType, personalityCore: character.personalityCore, motivation: character.motivation, backstory: character.backstory, source: 'auto_extracted' } });
        characterCreatedCount += 1;
      }

      let lorebookCreatedCount = 0;
      for (const entry of preview.lorebookEntries) {
        await tx.lorebookEntry.create({ data: { projectId: context.projectId, title: entry.title, entryType: entry.entryType, content: entry.content, summary: entry.summary, tags: (entry.tags ?? []) as Prisma.InputJsonValue, sourceType: 'agent_import' } });
        lorebookCreatedCount += 1;
      }

      const volumeByNo = new Map<number, string>();
      for (const volume of preview.volumes) {
        const saved = await tx.volume.upsert({
          where: { projectId_volumeNo: { projectId: context.projectId, volumeNo: volume.volumeNo } },
          update: { title: volume.title, synopsis: volume.synopsis, objective: volume.objective, chapterCount: volume.chapterCount },
          create: { projectId: context.projectId, volumeNo: volume.volumeNo, title: volume.title, synopsis: volume.synopsis, objective: volume.objective, chapterCount: volume.chapterCount },
        });
        volumeByNo.set(volume.volumeNo, saved.id);
      }

      let chapterCreatedCount = 0;
      let chapterUpdatedCount = 0;
      let chapterSkippedCount = 0;
      for (const chapter of preview.chapters) {
        const existing = await tx.chapter.findUnique({ where: { projectId_chapterNo: { projectId: context.projectId, chapterNo: chapter.chapterNo } } });
        const data = { volumeId: chapter.volumeNo ? volumeByNo.get(chapter.volumeNo) : undefined, title: chapter.title, objective: chapter.objective, conflict: chapter.conflict, revealPoints: chapter.hook, outline: chapter.outline, expectedWordCount: chapter.expectedWordCount };
        if (!existing) {
          await tx.chapter.create({ data: { projectId: context.projectId, chapterNo: chapter.chapterNo, ...data } });
          chapterCreatedCount += 1;
        } else if (existing.status === 'planned') {
          await tx.chapter.update({ where: { id: existing.id }, data });
          chapterUpdatedCount += 1;
        } else {
          chapterSkippedCount += 1;
        }
      }

      return { characterCreatedCount, lorebookCreatedCount, volumeCount: preview.volumes.length, chapterCreatedCount, chapterUpdatedCount, chapterSkippedCount };
    });
  }
}