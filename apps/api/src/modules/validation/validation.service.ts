import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type ChapterRow = {
  id: string;
  chapterNo: number;
  title: string | null;
  timelineSeq: number | null;
};

type StoryEventRow = {
  id: string;
  chapterId: string;
  chapterNo: number | null;
  title: string;
  participants: unknown;
  timelineSeq: number | null;
};

type CharacterStateSnapshotRow = {
  id: string;
  chapterId: string;
  chapterNo: number | null;
  characterName: string;
  stateType: string;
  stateValue: string;
  status: string;
};

type ForeshadowTrackRow = {
  id: string;
  chapterId: string;
  chapterNo: number | null;
  title: string;
  firstSeenChapterNo: number | null;
  lastSeenChapterNo: number | null;
};

type DeadCharacterRow = {
  id: string;
  name: string;
};

type PrismaFactsClient = {
  storyEvent: {
    findMany(args: unknown): Promise<StoryEventRow[]>;
  };
  characterStateSnapshot: {
    findMany(args: unknown): Promise<CharacterStateSnapshotRow[]>;
  };
  foreshadowTrack: {
    findMany(args: unknown): Promise<ForeshadowTrackRow[]>;
  };
};

type ComputedIssue = {
  chapterId?: string | null;
  issueType: string;
  severity: 'error' | 'warning' | 'info';
  entityType?: string | null;
  entityId?: string | null;
  message: string;
  evidence?: Record<string, unknown>[];
  suggestion?: string | null;
};

const FACT_RULE_TYPES = [
  'timeline_conflict',
  'dead_character_appearance',
  'foreshadow_first_seen_mismatch',
  'foreshadow_range_invalid',
] as const;

const toJson = (value: Record<string, unknown>[]) => value as unknown as Prisma.InputJsonValue;

@Injectable()
export class ValidationService {
  constructor(private readonly prisma: PrismaService) {}

  private get prismaFacts(): PrismaFactsClient {
    return this.prisma as unknown as PrismaFactsClient;
  }

  /**
   * Return unresolved validation issues for the current project/scope.
   * Resolved items stay in the audit trail but are hidden from the writing panel.
   */
  listByProject(projectId: string, chapterId?: string) {
    return this.prisma.validationIssue.findMany({
      where: {
        projectId,
        status: 'open',
        ...(chapterId ? { chapterId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
  }

  /**
   * Return unresolved validation issues for a single chapter.
   */
  listByChapter(chapterId: string) {
    return this.prisma.validationIssue.findMany({
      where: { chapterId, status: 'open' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Idempotently mark an issue as resolved after an AI repair flow succeeds.
   * Hard-rule issues may already be deleted/recreated during rerun, so updateMany avoids false 404s.
   */
  async resolveIssue(issueId: string) {
    const result = await this.prisma.validationIssue.updateMany({
      where: {
        id: issueId,
        status: 'open',
      },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
      },
    });

    return {
      issueId,
      resolved: result.count > 0,
      updatedCount: result.count,
    };
  }

  async runFactRules(projectId: string, chapterId?: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, title: true },
    });

    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const [chapters, storyEvents, characterStates, foreshadowTracks, deadCharacters] = (await Promise.all([
      this.prisma.chapter.findMany({
        where: {
          projectId,
          ...(chapterId ? { id: chapterId } : {}),
        },
        orderBy: { chapterNo: 'asc' },
      }),
      this.prismaFacts.storyEvent.findMany({
        where: {
          projectId,
          ...(chapterId ? { chapterId } : {}),
        },
        orderBy: [{ chapterNo: 'asc' }, { timelineSeq: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prismaFacts.characterStateSnapshot.findMany({
        where: {
          projectId,
          ...(chapterId ? { chapterId } : {}),
        },
        orderBy: [{ chapterNo: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prismaFacts.foreshadowTrack.findMany({
        where: {
          projectId,
          ...(chapterId ? { chapterId } : {}),
        },
        orderBy: [{ chapterNo: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.character.findMany({
        where: {
          projectId,
          isDead: true,
        },
        select: {
          id: true,
          name: true,
        },
      }),
    ])) as [ChapterRow[], StoryEventRow[], CharacterStateSnapshotRow[], ForeshadowTrackRow[], DeadCharacterRow[]];

    const issues: ComputedIssue[] = [];
    const chapterMap = new Map<string, ChapterRow>(chapters.map((item: ChapterRow) => [item.id, item]));
    const deadCharacterMap = new Map<string, DeadCharacterRow>(
      deadCharacters.map((item: DeadCharacterRow) => [item.name, item]),
    );

    let lastTimelineEvent:
      | {
          id: string;
          title: string;
          chapterId: string;
          chapterNo: number | null;
          timelineSeq: number;
        }
      | undefined;

    for (const event of storyEvents) {
      if (event.timelineSeq == null) {
        continue;
      }

      if (lastTimelineEvent && event.timelineSeq < lastTimelineEvent.timelineSeq) {
        issues.push({
          chapterId: event.chapterId,
          issueType: 'timeline_conflict',
          severity: 'error',
          entityType: 'story_event',
          entityId: event.id,
          message: `事件「${event.title}」的 timelineSeq=${event.timelineSeq} 早于前序事件「${lastTimelineEvent.title}」的 timelineSeq=${lastTimelineEvent.timelineSeq}。`,
          evidence: [
            {
              currentEventId: event.id,
              currentChapterNo: event.chapterNo,
              currentTimelineSeq: event.timelineSeq,
              previousEventId: lastTimelineEvent.id,
              previousChapterNo: lastTimelineEvent.chapterNo,
              previousTimelineSeq: lastTimelineEvent.timelineSeq,
            },
          ],
          suggestion: '检查章节 timelineSeq 与事件排序，必要时先修正结构化事实后再生成。',
        });
      }

      lastTimelineEvent = {
        id: event.id,
        title: event.title,
        chapterId: event.chapterId,
        chapterNo: event.chapterNo,
        timelineSeq: event.timelineSeq,
      };
    }

    for (const event of storyEvents) {
      const participants = Array.isArray(event.participants)
        ? event.participants.filter((item: unknown): item is string => typeof item === 'string')
        : [];
      const deadParticipants = participants.filter((name: string) => deadCharacterMap.has(name));
      if (!deadParticipants.length) {
        continue;
      }

      issues.push({
        chapterId: event.chapterId,
        issueType: 'dead_character_appearance',
        severity: 'error',
        entityType: 'story_event',
        entityId: event.id,
        message: `已标记死亡的角色 ${deadParticipants.join('、')} 仍出现在事件「${event.title}」的参与者列表中。`,
        evidence: [
          {
            storyEventId: event.id,
            title: event.title,
            chapterNo: event.chapterNo,
            participants,
          },
        ],
        suggestion: '核对角色生死状态，或补充“回忆/幻觉/尸体”之类的明确说明。',
      });
    }

    for (const snapshot of characterStates) {
      if (!deadCharacterMap.has(snapshot.characterName) || snapshot.status === 'rejected') {
        continue;
      }

      issues.push({
        chapterId: snapshot.chapterId,
        issueType: 'dead_character_appearance',
        severity: 'warning',
        entityType: 'character_state_snapshot',
        entityId: snapshot.id,
        message: `已标记死亡的角色 ${snapshot.characterName} 在角色状态快照中仍被写入「${snapshot.stateValue}」。`,
        evidence: [
          {
            characterStateSnapshotId: snapshot.id,
            chapterNo: snapshot.chapterNo,
            stateType: snapshot.stateType,
            stateValue: snapshot.stateValue,
            reviewStatus: snapshot.status,
          },
        ],
        suggestion: '如果这是回忆或尸体状态，请改写为更明确的事实类型；否则请修正角色档案。',
      });
    }

    const foreshadowGroup = new Map<string, ForeshadowTrackRow[]>();
    for (const track of foreshadowTracks) {
      const group = foreshadowGroup.get(track.title) ?? [];
      group.push(track);
      foreshadowGroup.set(track.title, group);
    }

    for (const [title, tracks] of foreshadowGroup.entries()) {
      const chapterNos = tracks
        .map((item: ForeshadowTrackRow) => item.chapterNo)
        .filter((item: number | null): item is number => typeof item === 'number');
      const earliestChapterNo = chapterNos.length ? Math.min(...chapterNos) : null;

      for (const track of tracks) {
        if (
          earliestChapterNo != null &&
          track.firstSeenChapterNo != null &&
          track.firstSeenChapterNo !== earliestChapterNo
        ) {
          issues.push({
            chapterId: track.chapterId,
            issueType: 'foreshadow_first_seen_mismatch',
            severity: 'warning',
            entityType: 'foreshadow_track',
            entityId: track.id,
            message: `伏笔「${title}」的 firstSeenChapterNo=${track.firstSeenChapterNo}，但当前最早出现章节为第 ${earliestChapterNo} 章。`,
            evidence: [
              {
                foreshadowTrackId: track.id,
                chapterNo: track.chapterNo,
                firstSeenChapterNo: track.firstSeenChapterNo,
                expectedFirstSeenChapterNo: earliestChapterNo,
              },
            ],
            suggestion: '执行 rebuild 或手动修正 firstSeenChapterNo，保证首次出现查询稳定。',
          });
        }

        if (
          track.firstSeenChapterNo != null &&
          track.lastSeenChapterNo != null &&
          track.lastSeenChapterNo < track.firstSeenChapterNo
        ) {
          issues.push({
            chapterId: track.chapterId,
            issueType: 'foreshadow_range_invalid',
            severity: 'warning',
            entityType: 'foreshadow_track',
            entityId: track.id,
            message: `伏笔「${title}」的 lastSeenChapterNo=${track.lastSeenChapterNo} 小于 firstSeenChapterNo=${track.firstSeenChapterNo}。`,
            evidence: [
              {
                foreshadowTrackId: track.id,
                chapterNo: track.chapterNo,
                firstSeenChapterNo: track.firstSeenChapterNo,
                lastSeenChapterNo: track.lastSeenChapterNo,
              },
            ],
            suggestion: '修正伏笔章节范围，避免首次/最近一次出现查询失真。',
          });
        }
      }
    }

    const deleted = await this.prisma.validationIssue.deleteMany({
      where: {
        projectId,
        ...(chapterId ? { chapterId } : {}),
        issueType: { in: [...FACT_RULE_TYPES] },
      },
    });

    if (issues.length) {
      await this.prisma.validationIssue.createMany({
        data: issues.map((issue) => ({
          projectId,
          chapterId: issue.chapterId ?? null,
          issueType: issue.issueType,
          severity: issue.severity,
          entityType: issue.entityType ?? null,
          entityId: issue.entityId ?? null,
          message: issue.message,
          evidence: toJson(issue.evidence ?? []),
          suggestion: issue.suggestion ?? null,
        })),
      });
    }

    return {
      project,
      scope: {
        projectId,
        chapterId: chapterId ?? null,
      },
      deletedCount: deleted.count,
      createdCount: issues.length,
      chapterCount: chapters.length,
      factCounts: {
        storyEvents: storyEvents.length,
        characterStateSnapshots: characterStates.length,
        foreshadowTracks: foreshadowTracks.length,
      },
      issues,
      chapters: chapters.map((chapter: ChapterRow) => ({
        id: chapter.id,
        chapterNo: chapter.chapterNo,
        title: chapter.title,
        timelineSeq: chapter.timelineSeq,
        issueCount: issues.filter((issue) => issue.chapterId === chapter.id).length,
      })),
      deadCharacters: deadCharacters.map((item: DeadCharacterRow) => ({
        id: item.id,
        name: item.name,
      })),
      chapterMap: Object.fromEntries(
        Array.from(chapterMap.entries()).map(([id, chapter]: [string, ChapterRow]) => [id, { chapterNo: chapter.chapterNo, title: chapter.title }]),
      ),
    };
  }
}
