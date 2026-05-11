import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterDto } from './dto/create-chapter.dto';

@Injectable()
export class ChaptersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateChapterDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const chapter = await this.prisma.chapter.create({
      data: {
        projectId,
        chapterNo: dto.chapterNo,
        title: dto.title,
        objective: dto.objective,
        conflict: dto.conflict,
        outline: dto.outline,
        expectedWordCount: dto.expectedWordCount,
      },
    });

    await this.refreshChapterContext(projectId, chapter.id);
    return chapter;
  }

  listByProject(projectId: string) {
    return this.prisma.chapter.findMany({
      where: { projectId },
      orderBy: { chapterNo: 'asc' },
    });
  }

  async getById(chapterId: string) {
    const chapter = await this.prisma.chapter.findUnique({
      where: { id: chapterId },
    });

    if (!chapter) {
      throw new NotFoundException(`章节不存在：${chapterId}`);
    }

    return chapter;
  }

  async removeMany(projectId: string, chapterIds: string[]) {
    const uniqueChapterIds = Array.from(new Set(chapterIds.map((id) => id.trim()).filter(Boolean)));
    if (!uniqueChapterIds.length) {
      throw new BadRequestException('请选择要删除的章节');
    }

    const chapters = await this.prisma.chapter.findMany({
      where: { projectId, id: { in: uniqueChapterIds } },
      select: { id: true, chapterNo: true, title: true },
      orderBy: { chapterNo: 'asc' },
    });
    if (chapters.length !== uniqueChapterIds.length) {
      const foundIds = new Set(chapters.map((chapter) => chapter.id));
      const missingIds = uniqueChapterIds.filter((id) => !foundIds.has(id));
      throw new NotFoundException(`章节不存在或不属于当前项目：${missingIds.join('、')}`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const [
        qualityReports,
        validationIssues,
        memoryChunks,
        timelineEvents,
        sceneCards,
        pacingBeats,
        generationJobs,
        deletedChapters,
      ] = await Promise.all([
        tx.qualityReport.deleteMany({ where: { projectId, chapterId: { in: uniqueChapterIds } } }),
        tx.validationIssue.deleteMany({ where: { projectId, chapterId: { in: uniqueChapterIds } } }),
        tx.memoryChunk.deleteMany({ where: { projectId, sourceType: 'chapter', sourceId: { in: uniqueChapterIds } } }),
        tx.timelineEvent.deleteMany({ where: { projectId, chapterId: { in: uniqueChapterIds } } }),
        tx.sceneCard.deleteMany({ where: { projectId, chapterId: { in: uniqueChapterIds } } }),
        tx.pacingBeat.deleteMany({ where: { projectId, chapterId: { in: uniqueChapterIds } } }),
        tx.generationJob.deleteMany({ where: { projectId, chapterId: { in: uniqueChapterIds } } }),
        tx.chapter.deleteMany({ where: { projectId, id: { in: uniqueChapterIds } } }),
      ]);

      return {
        deletedCount: deletedChapters.count,
        deletedQualityReports: qualityReports.count,
        deletedValidationIssues: validationIssues.count,
        deletedMemoryChunks: memoryChunks.count,
        deletedTimelineEvents: timelineEvents.count,
        deletedSceneCards: sceneCards.count,
        deletedPacingBeats: pacingBeats.count,
        deletedGenerationJobs: generationJobs.count,
      };
    }, { timeout: 30_000, maxWait: 10_000 });

    await Promise.all([
      ...uniqueChapterIds.map((chapterId) => this.cacheService.deleteChapterContext(projectId, chapterId)),
      this.cacheService.deleteProjectRecallResults(projectId),
    ]);

    return {
      deleted: true,
      projectId,
      chapterIds: uniqueChapterIds,
      chapters,
      ...result,
    };
  }

  /**
   * Return the latest (isCurrent=true) draft for a chapter, or null if none exists.
   * Used by the frontend EditorPanel to display AI-generated content.
   */
  async getLatestDraft(chapterId: string) {
    const draft = await this.prisma.chapterDraft.findFirst({
      where: { chapterId, isCurrent: true },
      orderBy: { versionNo: 'desc' },
    });
    return draft;
  }

  /**
   * Return all draft versions for a chapter, ordered newest first.
   * Used by the frontend to show draft history / version switching.
   * generationContext is intentionally exposed so the editor can link a polished
   * draft back to the exact source draft that was polished.
   */
  async listDrafts(chapterId: string) {
    return this.prisma.chapterDraft.findMany({
      where: { chapterId },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        chapterId: true,
        versionNo: true,
        content: true,
        source: true,
        modelInfo: true,
        generationContext: true,
        isCurrent: true,
        createdAt: true,
      },
    });
  }

  async updateDraftContent(chapterId: string, draftId: string, content: string) {
    if (!content.trim()) {
      throw new BadRequestException('正文内容不能为空');
    }

    const existingDraft = await this.prisma.chapterDraft.findFirst({
      where: { id: draftId, chapterId },
      include: {
        chapter: {
          select: { id: true, projectId: true },
        },
      },
    });

    if (!existingDraft) {
      throw new NotFoundException(`草稿不存在或不属于当前章节：${draftId}`);
    }

    const actualWordCount = this.countDraftWords(content);
    const generationContext = this.withManualEditContext(existingDraft.generationContext);
    const updatedDraft = await this.prisma.$transaction(async (tx) => {
      await tx.chapterDraft.updateMany({
        where: { chapterId, isCurrent: true, id: { not: draftId } },
        data: { isCurrent: false },
      });

      const draft = await tx.chapterDraft.update({
        where: { id: draftId },
        data: {
          content,
          generationContext,
          isCurrent: true,
        },
        select: {
          id: true,
          chapterId: true,
          versionNo: true,
          content: true,
          source: true,
          modelInfo: true,
          generationContext: true,
          isCurrent: true,
          createdAt: true,
        },
      });

      await tx.chapter.update({
        where: { id: chapterId },
        data: {
          status: 'drafted',
          actualWordCount,
        },
      });

      return draft;
    }, { timeout: 30_000, maxWait: 10_000 });

    await Promise.all([
      this.refreshChapterContext(existingDraft.chapter.projectId, chapterId),
      this.cacheService.deleteProjectRecallResults(existingDraft.chapter.projectId),
    ]);

    return updatedDraft;
  }

  async markDrafted(chapterId: string, actualWordCount: number) {
    const chapter = await this.getById(chapterId);
    const updatedChapter = await this.prisma.chapter.update({
      where: { id: chapterId },
      data: {
        status: 'drafted',
        actualWordCount,
      },
    });

    await this.refreshChapterContext(chapter.projectId, updatedChapter.id);
    return updatedChapter;
  }

  /**
   * Mark a chapter as completed from the editor UI without invoking AI generation.
   * This is intentionally limited to chapter metadata so manual writing workflows
   * can update progress while preserving the user's current draft/content untouched.
   */
  async markCompletedManually(chapterId: string, actualWordCount?: number) {
    const chapter = await this.getById(chapterId);
    const updatedChapter = await this.prisma.chapter.update({
      where: { id: chapterId },
      data: {
        status: 'drafted',
        ...(typeof actualWordCount === 'number' && actualWordCount >= 0 ? { actualWordCount } : {}),
      },
    });

    // 更新章节上下文缓存，让后续生成/事实层读取到最新完成状态。
    await this.refreshChapterContext(chapter.projectId, updatedChapter.id);
    return updatedChapter;
  }

  private async refreshChapterContext(projectId: string, chapterId: string) {
    const chapter = await this.prisma.chapter.findUnique({
      where: { id: chapterId },
    });

    if (!chapter) {
      await this.cacheService.deleteChapterContext(projectId, chapterId);
      return;
    }

    const relatedCharacters = await this.prisma.character.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    await this.cacheService.setChapterContext(projectId, chapterId, {
      chapter: {
        id: chapter.id,
        projectId: chapter.projectId,
        chapterNo: chapter.chapterNo,
        title: chapter.title,
        objective: chapter.objective,
        conflict: chapter.conflict,
        outline: chapter.outline,
        expectedWordCount: chapter.expectedWordCount ?? null,
        status: chapter.status,
        actualWordCount: chapter.actualWordCount ?? null,
      },
      relatedCharacters: relatedCharacters.map((item) => ({
        id: item.id,
        name: item.name,
        roleType: item.roleType,
        speechStyle: item.speechStyle,
      })),
    });
  }

  private countDraftWords(content: string) {
    return content.replace(/\s/g, '').length;
  }

  private withManualEditContext(value: unknown) {
    const base = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value as Record<string, unknown> }
      : {};

    return {
      ...base,
      manualEdited: true,
      manualEditedAt: new Date().toISOString(),
    };
  }
}
