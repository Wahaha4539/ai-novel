import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertCompleteChapterCraftBrief } from '../agent-tools/tools/chapter-craft-brief-contracts';
import { ScoringTargetSelector } from './scoring-targets';
import { ScoringTargetSnapshot, ScoringTargetType } from './scoring-contracts';

export interface LoadedScoringTarget {
  targetType: ScoringTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown> | null;
  chapterId?: string | null;
  draftId?: string | null;
  draftVersion?: number | null;
  targetSnapshot: ScoringTargetSnapshot;
  sourceTrace: Record<string, unknown>;
}

@Injectable()
export class ScoringTargetLoaderService {
  constructor(private readonly prisma: PrismaService) {}

  async loadTarget(projectId: string, selector: ScoringTargetSelector): Promise<LoadedScoringTarget> {
    switch (selector.targetType) {
      case 'chapter_craft_brief':
        return this.loadChapterCraftBrief(projectId, selector);
      default:
        throw new BadRequestException(`Scoring target is not implemented yet: ${selector.targetType}`);
    }
  }

  private async loadChapterCraftBrief(projectId: string, selector: ScoringTargetSelector): Promise<LoadedScoringTarget> {
    const chapterId = selector.targetId ?? text(selector.targetRef?.chapterId);
    if (!chapterId) throw new BadRequestException('chapter_craft_brief scoring requires targetId or targetRef.chapterId.');

    const chapter = await this.prisma.chapter.findFirst({
      where: { id: chapterId, projectId },
      select: {
        id: true,
        projectId: true,
        volumeId: true,
        chapterNo: true,
        title: true,
        objective: true,
        conflict: true,
        revealPoints: true,
        foreshadowPlan: true,
        outline: true,
        craftBrief: true,
        status: true,
        updatedAt: true,
        volume: {
          select: {
            id: true,
            volumeNo: true,
            title: true,
            synopsis: true,
            objective: true,
            narrativePlan: true,
            chapterCount: true,
          },
        },
        project: {
          select: {
            id: true,
            title: true,
            genre: true,
            theme: true,
            tone: true,
            logline: true,
            synopsis: true,
            outline: true,
            creativeProfile: {
              select: {
                audienceType: true,
                platformTarget: true,
                sellingPoints: true,
                pacingPreference: true,
                contentRating: true,
                centralConflict: true,
              },
            },
          },
        },
      },
    });

    if (!chapter) throw new NotFoundException(`Chapter not found in project: ${chapterId}`);
    try {
      assertCompleteChapterCraftBrief(chapter.craftBrief, { label: `chapter ${chapter.chapterNo}` });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }

    const adjacentChapters = await this.prisma.chapter.findMany({
      where: {
        projectId,
        chapterNo: { in: [chapter.chapterNo - 1, chapter.chapterNo + 1] },
      },
      orderBy: { chapterNo: 'asc' },
      select: {
        id: true,
        chapterNo: true,
        title: true,
        objective: true,
        conflict: true,
        outline: true,
        status: true,
      },
    });

    const sourceTrace = {
      projectId,
      chapterId: chapter.id,
      chapterNo: chapter.chapterNo,
      volumeId: chapter.volumeId,
      volumeNo: chapter.volume?.volumeNo ?? null,
      source: 'Chapter.craftBrief',
    };

    return {
      targetType: 'chapter_craft_brief',
      targetId: chapter.id,
      targetRef: selector.targetRef ?? null,
      chapterId: chapter.id,
      targetSnapshot: {
        targetType: 'chapter_craft_brief',
        targetId: chapter.id,
        targetRef: selector.targetRef ?? null,
        assetSummary: {
          targetType: 'chapter_craft_brief',
          title: chapter.title ?? `Chapter ${chapter.chapterNo} craftBrief`,
          volumeNo: chapter.volume?.volumeNo ?? null,
          chapterNo: chapter.chapterNo,
          source: 'Chapter.craftBrief',
          updatedAt: chapter.updatedAt.toISOString(),
        },
        content: {
          project: chapter.project,
          volume: chapter.volume,
          chapter: {
            id: chapter.id,
            chapterNo: chapter.chapterNo,
            title: chapter.title,
            objective: chapter.objective,
            conflict: chapter.conflict,
            revealPoints: chapter.revealPoints,
            foreshadowPlan: chapter.foreshadowPlan,
            outline: chapter.outline,
            status: chapter.status,
          },
          adjacentChapters,
          craftBrief: chapter.craftBrief,
        },
        sourceTrace,
      },
      sourceTrace,
    };
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export type PrismaJson = Prisma.JsonValue;
