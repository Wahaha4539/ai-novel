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
      case 'chapter_outline':
        return this.loadChapterOutline(projectId, selector);
      case 'chapter_craft_brief':
        return this.loadChapterCraftBrief(projectId, selector);
      case 'chapter_draft':
        return this.loadChapterDraft(projectId, selector);
      default:
        throw new BadRequestException(`Scoring target is not implemented yet: ${selector.targetType}`);
    }
  }

  private async loadChapterOutline(projectId: string, selector: ScoringTargetSelector): Promise<LoadedScoringTarget> {
    const chapterId = selector.targetId ?? text(selector.targetRef?.chapterId);
    if (!chapterId) throw new BadRequestException('chapter_outline scoring requires targetId or targetRef.chapterId.');
    const chapter = await this.loadChapterWithPlanningContext(projectId, chapterId);
    if (!text(chapter.objective)) throw new BadRequestException(`Chapter ${chapter.chapterNo} missing objective for chapter_outline scoring.`);
    if (!text(chapter.outline)) throw new BadRequestException(`Chapter ${chapter.chapterNo} missing outline for chapter_outline scoring.`);
    const adjacentChapters = await this.loadAdjacentChapters(projectId, chapter.chapterNo);
    const sourceTrace = {
      projectId,
      chapterId: chapter.id,
      chapterNo: chapter.chapterNo,
      volumeId: chapter.volumeId,
      volumeNo: chapter.volume?.volumeNo ?? null,
      source: 'Chapter.outline',
    };

    return {
      targetType: 'chapter_outline',
      targetId: chapter.id,
      targetRef: selector.targetRef ?? null,
      chapterId: chapter.id,
      targetSnapshot: {
        targetType: 'chapter_outline',
        targetId: chapter.id,
        targetRef: selector.targetRef ?? null,
        assetSummary: {
          targetType: 'chapter_outline',
          title: chapter.title ?? `Chapter ${chapter.chapterNo} outline`,
          volumeNo: chapter.volume?.volumeNo ?? null,
          chapterNo: chapter.chapterNo,
          source: 'Chapter.outline',
          updatedAt: chapter.updatedAt.toISOString(),
        },
        content: {
          project: chapter.project,
          volume: chapter.volume,
          chapter: this.chapterPlanningContent(chapter),
          adjacentChapters,
        },
        sourceTrace,
      },
      sourceTrace,
    };
  }

  private async loadChapterCraftBrief(projectId: string, selector: ScoringTargetSelector): Promise<LoadedScoringTarget> {
    const chapterId = selector.targetId ?? text(selector.targetRef?.chapterId);
    if (!chapterId) throw new BadRequestException('chapter_craft_brief scoring requires targetId or targetRef.chapterId.');

    const chapter = await this.loadChapterWithPlanningContext(projectId, chapterId);
    try {
      assertCompleteChapterCraftBrief(chapter.craftBrief, { label: `chapter ${chapter.chapterNo}` });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }

    const adjacentChapters = await this.loadAdjacentChapters(projectId, chapter.chapterNo);

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

  private async loadChapterDraft(projectId: string, selector: ScoringTargetSelector): Promise<LoadedScoringTarget> {
    const chapterId = selector.targetId ?? text(selector.targetRef?.chapterId);
    if (!selector.draftId || !selector.draftVersion) {
      throw new BadRequestException('chapter_draft scoring requires explicit draftId and draftVersion.');
    }
    const draft = await this.prisma.chapterDraft.findFirst({
      where: {
        id: selector.draftId,
        chapter: {
          projectId,
          ...(chapterId ? { id: chapterId } : {}),
        },
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
        chapter: {
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
            volume: this.volumeSelect(),
            project: this.projectSelect(),
          },
        },
      },
    });

    if (!draft) throw new NotFoundException(`Draft not found in project: ${selector.draftId}`);
    if (draft.versionNo !== selector.draftVersion) {
      throw new BadRequestException(`Draft version mismatch: requested v${selector.draftVersion}, found v${draft.versionNo}.`);
    }
    if (!text(draft.content)) throw new BadRequestException(`Draft ${draft.id} is empty.`);
    if (!text(draft.chapter.outline)) throw new BadRequestException(`Chapter ${draft.chapter.chapterNo} missing outline for chapter_draft scoring.`);
    try {
      assertCompleteChapterCraftBrief(draft.chapter.craftBrief, { label: `chapter ${draft.chapter.chapterNo}` });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const adjacentChapters = await this.loadAdjacentChapters(projectId, draft.chapter.chapterNo);
    const sourceTrace = {
      projectId,
      chapterId: draft.chapter.id,
      chapterNo: draft.chapter.chapterNo,
      volumeId: draft.chapter.volumeId,
      volumeNo: draft.chapter.volume?.volumeNo ?? null,
      draftId: draft.id,
      draftVersion: draft.versionNo,
      source: 'ChapterDraft',
    };

    return {
      targetType: 'chapter_draft',
      targetId: draft.chapter.id,
      targetRef: selector.targetRef ?? null,
      chapterId: draft.chapter.id,
      draftId: draft.id,
      draftVersion: draft.versionNo,
      targetSnapshot: {
        targetType: 'chapter_draft',
        targetId: draft.chapter.id,
        targetRef: selector.targetRef ?? null,
        assetSummary: {
          targetType: 'chapter_draft',
          title: draft.chapter.title ?? `Chapter ${draft.chapter.chapterNo} draft v${draft.versionNo}`,
          volumeNo: draft.chapter.volume?.volumeNo ?? null,
          chapterNo: draft.chapter.chapterNo,
          draftId: draft.id,
          draftVersion: draft.versionNo,
          source: draft.source,
          updatedAt: draft.createdAt.toISOString(),
        },
        content: {
          project: draft.chapter.project,
          volume: draft.chapter.volume,
          chapter: this.chapterPlanningContent(draft.chapter),
          adjacentChapters,
          craftBrief: draft.chapter.craftBrief,
          draft: {
            id: draft.id,
            versionNo: draft.versionNo,
            source: draft.source,
            modelInfo: draft.modelInfo,
            generationContext: draft.generationContext,
            isCurrent: draft.isCurrent,
            content: draft.content,
          },
          planAdherenceContext: {
            outline: draft.chapter.outline,
            craftBrief: draft.chapter.craftBrief,
          },
        },
        sourceTrace,
      },
      sourceTrace,
    };
  }

  private async loadChapterWithPlanningContext(projectId: string, chapterId: string) {
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
        volume: this.volumeSelect(),
        project: this.projectSelect(),
      },
    });

    if (!chapter) throw new NotFoundException(`Chapter not found in project: ${chapterId}`);
    return chapter;
  }

  private loadAdjacentChapters(projectId: string, chapterNo: number) {
    return this.prisma.chapter.findMany({
      where: {
        projectId,
        chapterNo: { in: [chapterNo - 1, chapterNo + 1] },
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
  }

  private projectSelect() {
    return {
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
    } as const;
  }

  private volumeSelect() {
    return {
      select: {
        id: true,
        volumeNo: true,
        title: true,
        synopsis: true,
        objective: true,
        narrativePlan: true,
        chapterCount: true,
      },
    } as const;
  }

  private chapterPlanningContent(chapter: {
    id: string;
    chapterNo: number;
    title: string | null;
    objective: string | null;
    conflict: string | null;
    revealPoints: string | null;
    foreshadowPlan: string | null;
    outline: string | null;
    status: string;
  }) {
    return {
      id: chapter.id,
      chapterNo: chapter.chapterNo,
      title: chapter.title,
      objective: chapter.objective,
      conflict: chapter.conflict,
      revealPoints: chapter.revealPoints,
      foreshadowPlan: chapter.foreshadowPlan,
      outline: chapter.outline,
      status: chapter.status,
    };
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export type PrismaJson = Prisma.JsonValue;
