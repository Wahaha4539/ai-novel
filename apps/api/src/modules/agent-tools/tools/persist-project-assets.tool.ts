import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
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

  constructor(private readonly prisma: PrismaService, private readonly cacheService: NovelCacheService) {}

  async run(args: PersistProjectAssetsInput, context: ToolContext) {
    if (!args.preview) throw new BadRequestException('persist_project_assets 需要 import preview');
    const preview = args.preview;
    this.assertSafePreview(preview);

    const result = await this.prisma.$transaction(async (tx) => {
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
        // 同一批导入内也要更新去重集合，避免重复角色名在本次事务中被连续创建。
        existingNames.add(character.name);
        characterCreatedCount += 1;
      }

      const existingLorebook = await tx.lorebookEntry.findMany({ where: { projectId: context.projectId }, select: { title: true } });
      const existingLorebookTitles = new Set(existingLorebook.map((item) => item.title));
      let lorebookCreatedCount = 0;
      let lorebookSkippedCount = 0;
      for (const entry of preview.lorebookEntries) {
        if (existingLorebookTitles.has(entry.title)) {
          lorebookSkippedCount += 1;
          continue;
        }
        await tx.lorebookEntry.create({ data: { projectId: context.projectId, title: entry.title, entryType: entry.entryType, content: entry.content, summary: entry.summary, tags: (entry.tags ?? []) as Prisma.InputJsonValue, sourceType: 'agent_import' } });
        existingLorebookTitles.add(entry.title);
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

      return { characterCreatedCount, lorebookCreatedCount, lorebookSkippedCount, volumeCount: preview.volumes.length, chapterCreatedCount, chapterUpdatedCount, chapterSkippedCount };
    });

    if (this.hasRetrievalRelevantWrites(result)) {
      // 导入资料可能新增设定、角色或章节规划，这些都会改变后续召回输入/结果，写入后清空项目级召回缓存。
      await this.cacheService.deleteProjectRecallResults(context.projectId);
    }

    return result;
  }

  /** 判断本次导入是否改变了召回可见资料；只在确有写入时触发项目级召回缓存失效。 */
  private hasRetrievalRelevantWrites(result: Record<string, unknown>) {
    return ['characterCreatedCount', 'lorebookCreatedCount', 'volumeCount', 'chapterCreatedCount', 'chapterUpdatedCount'].some((key) => Number(result[key]) > 0);
  }

  /** 批量导入写库前的最后防线，避免重复卷号/章节号造成 upsert 或章节覆盖语义不明确。 */
  private assertSafePreview(preview: ImportPreviewOutput) {
    const volumeNos = preview.volumes.map((volume) => Number(volume.volumeNo));
    const chapterNos = preview.chapters.map((chapter) => Number(chapter.chapterNo));
    if (volumeNos.some((volumeNo) => !Number.isFinite(volumeNo) || volumeNo <= 0)) throw new BadRequestException('卷号必须是正数');
    if (chapterNos.some((chapterNo) => !Number.isFinite(chapterNo) || chapterNo <= 0)) throw new BadRequestException('章节编号必须是正数');
    const duplicatedVolumes = volumeNos.filter((volumeNo, index) => volumeNos.indexOf(volumeNo) !== index);
    const duplicatedChapters = chapterNos.filter((chapterNo, index) => chapterNos.indexOf(chapterNo) !== index);
    if (duplicatedVolumes.length) throw new BadRequestException(`卷号重复，已阻止写入：${[...new Set(duplicatedVolumes)].join(', ')}`);
    if (duplicatedChapters.length) throw new BadRequestException(`章节编号重复，已阻止写入：${[...new Set(duplicatedChapters)].join(', ')}`);
  }
}