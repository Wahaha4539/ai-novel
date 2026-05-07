import { Injectable, NotFoundException } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface ChapterRewriteCleanupResult {
  projectId: string;
  chapterId: string;
  chapterNo: number;
  deletedDrafts: number;
  deletedQualityReports: number;
  deletedValidationIssues: number;
  deletedMemoryChunks: number;
  deletedStoryEvents: number;
  deletedCharacterStates: number;
  deletedForeshadows: number;
  deletedAutoCharacters: number;
  deletedAutoLorebookEntries: number;
}

/**
 * Reset chapter-body generated products before a true rewrite.
 *
 * "Rewrite" means the old chapter body is no longer a valid source of truth, so
 * generated draft versions, fact layers, review reports and memory chunks must
 * be removed before the new body is generated.
 */
@Injectable()
export class ChapterRewriteCleanupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async cleanupChapter(projectId: string, chapterId: string): Promise<ChapterRewriteCleanupResult> {
    const chapter = await this.prisma.chapter.findFirst({
      where: { id: chapterId, projectId },
      select: { id: true, chapterNo: true },
    });
    if (!chapter) throw new NotFoundException(`Chapter not found in project: ${chapterId}`);

    const result = await this.prisma.$transaction(async (tx) => {
      const [
        qualityReports,
        validationIssues,
        memoryChunks,
        storyEvents,
        characterStates,
        foreshadows,
        autoCharacters,
        autoLorebookEntries,
        drafts,
      ] = await Promise.all([
        tx.qualityReport.deleteMany({ where: { projectId, chapterId } }),
        tx.validationIssue.deleteMany({ where: { projectId, chapterId } }),
        tx.memoryChunk.deleteMany({ where: { projectId, sourceType: 'chapter', sourceId: chapterId } }),
        tx.storyEvent.deleteMany({ where: { projectId, chapterId } }),
        tx.characterStateSnapshot.deleteMany({ where: { projectId, chapterId } }),
        tx.foreshadowTrack.deleteMany({
          where: {
            projectId,
            chapterId,
            OR: [
              { source: 'auto_extracted' },
              { metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } },
            ],
          },
        }),
        tx.character.deleteMany({
          where: {
            projectId,
            source: 'auto_extracted',
            activeFromChapter: chapter.chapterNo,
            metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' },
          },
        }),
        tx.lorebookEntry.deleteMany({
          where: {
            projectId,
            sourceType: 'auto_extracted',
            AND: [
              { metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } },
              { metadata: { path: ['firstSeenChapterNo'], equals: chapter.chapterNo } },
            ],
          },
        }),
        tx.chapterDraft.deleteMany({ where: { chapterId } }),
      ]);

      await tx.chapter.update({
        where: { id: chapterId },
        data: { status: 'planned', actualWordCount: null },
      });

      return {
        deletedQualityReports: qualityReports.count,
        deletedValidationIssues: validationIssues.count,
        deletedMemoryChunks: memoryChunks.count,
        deletedStoryEvents: storyEvents.count,
        deletedCharacterStates: characterStates.count,
        deletedForeshadows: foreshadows.count,
        deletedAutoCharacters: autoCharacters.count,
        deletedAutoLorebookEntries: autoLorebookEntries.count,
        deletedDrafts: drafts.count,
      };
    }, { timeout: 30_000, maxWait: 10_000 });

    await Promise.all([
      this.cacheService.deleteChapterContext(projectId, chapterId),
      this.cacheService.deleteProjectRecallResults(projectId),
    ]);

    return {
      projectId,
      chapterId,
      chapterNo: chapter.chapterNo,
      ...result,
    };
  }
}
