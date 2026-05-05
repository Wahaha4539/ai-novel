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
  description?: string;
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
  summary?: string | null;
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

type WritingRuleRow = {
  id: string;
  ruleType: string;
  title: string;
  content: string;
  severity: 'error' | 'warning' | 'info';
  appliesFromChapterNo: number | null;
  appliesToChapterNo: number | null;
  entityType: string | null;
  entityRef: string | null;
  status: string;
  metadata?: unknown;
};

type TimelineEventRow = {
  id: string;
  chapterId: string | null;
  chapterNo: number | null;
  title: string;
  eventTime: string | null;
  locationName: string | null;
  participants: unknown;
  cause: string | null;
  result: string | null;
  isPublic: boolean;
  knownBy: unknown;
  unknownBy: unknown;
  eventStatus: string;
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
  writingRule?: {
    findMany(args: unknown): Promise<WritingRuleRow[]>;
  };
  timelineEvent?: {
    findMany(args: unknown): Promise<TimelineEventRow[]>;
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
  'writing_rule_forbidden_text',
  'writing_rule_no_appearance',
  'timeline_knowledge_leak',
  'timeline_event_order_conflict',
  'timeline_location_conflict',
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

    const [chapters, storyEvents, characterStates, foreshadowTracks, deadCharacters, writingRules, timelineEvents] = (await Promise.all([
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
      this.findActiveWritingRules(projectId),
      this.findTimelineEvents(projectId),
    ])) as [ChapterRow[], StoryEventRow[], CharacterStateSnapshotRow[], ForeshadowTrackRow[], DeadCharacterRow[], WritingRuleRow[], TimelineEventRow[]];

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
      const deadParticipants = participants.filter(
        (name: string) => deadCharacterMap.has(name) && this.isNormalAppearanceText(`${event.title}\n${event.description ?? ''}`),
      );
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
      if (
        !deadCharacterMap.has(snapshot.characterName) ||
        snapshot.status === 'rejected' ||
        !this.isNormalAppearanceText(`${snapshot.stateType}\n${snapshot.stateValue}\n${snapshot.summary ?? ''}`)
      ) {
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

    this.addWritingRuleIssues(issues, writingRules, storyEvents, characterStates);
    this.addTimelineEventIssues(issues, timelineEvents, storyEvents, characterStates, chapterId);

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
        writingRules: writingRules.length,
        timelineEvents: timelineEvents.length,
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

  private async findActiveWritingRules(projectId: string): Promise<WritingRuleRow[]> {
    const client = this.prismaFacts.writingRule;
    if (!client) return [];
    return client.findMany({
      where: { projectId, status: 'active' },
      orderBy: [{ updatedAt: 'desc' }],
    }).then((rows) => rows.sort((a, b) => this.severityRank(b.severity) - this.severityRank(a.severity)));
  }

  private async findTimelineEvents(projectId: string): Promise<TimelineEventRow[]> {
    const client = this.prismaFacts.timelineEvent;
    if (!client) return [];
    return client.findMany({
      where: { projectId, eventStatus: 'active' },
      orderBy: [{ chapterNo: 'asc' }, { eventTime: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private addWritingRuleIssues(
    issues: ComputedIssue[],
    rules: WritingRuleRow[],
    storyEvents: StoryEventRow[],
    characterStates: CharacterStateSnapshotRow[],
  ) {
    const noAppearanceTypes = new Set(['no_appearance', 'dead_character']);
    const forbiddenTypes = new Set(['forbidden', 'ban', 'no_leak']);

    for (const rule of rules) {
      const ruleType = rule.ruleType.trim().toLowerCase();
      if (noAppearanceTypes.has(ruleType)) {
        const names = this.ruleEntityNames(rule);
        if (!names.length) continue;
        this.addNoAppearanceRuleIssues(issues, rule, names, storyEvents, characterStates);
      }

      if (forbiddenTypes.has(ruleType)) {
        const terms = this.extractRuleTerms(rule);
        if (!terms.length) continue;
        this.addForbiddenRuleIssues(issues, rule, terms, storyEvents, characterStates);
      }
    }
  }

  private addNoAppearanceRuleIssues(
    issues: ComputedIssue[],
    rule: WritingRuleRow,
    names: string[],
    storyEvents: StoryEventRow[],
    characterStates: CharacterStateSnapshotRow[],
  ) {
    for (const event of storyEvents) {
      if (!this.isRuleActiveAt(rule, event.chapterNo) || !this.isNormalAppearanceText(`${event.title}\n${event.description ?? ''}`)) {
        continue;
      }
      const participants = this.readStringArray(event.participants);
      const matchedNames = names.filter((name) => participants.some((participant) => this.equalsLoose(participant, name)));
      if (!matchedNames.length) continue;

      issues.push({
        chapterId: event.chapterId,
        issueType: 'writing_rule_no_appearance',
        severity: rule.severity,
        entityType: 'story_event',
        entityId: event.id,
        message: `Writing rule "${rule.title}" forbids appearance of ${matchedNames.join(', ')}, but the character appears in story event "${event.title}".`,
        evidence: [{ writingRuleId: rule.id, ruleType: rule.ruleType, storyEventId: event.id, chapterNo: event.chapterNo, participants }],
        suggestion: 'Remove the appearance or update the rule range/entity if this chapter is allowed to use the character.',
      });
    }

    for (const snapshot of characterStates) {
      if (
        snapshot.status === 'rejected' ||
        !this.isRuleActiveAt(rule, snapshot.chapterNo) ||
        !this.isNormalAppearanceText(`${snapshot.stateType}\n${snapshot.stateValue}\n${snapshot.summary ?? ''}`) ||
        !names.some((name) => this.equalsLoose(snapshot.characterName, name))
      ) {
        continue;
      }

      issues.push({
        chapterId: snapshot.chapterId,
        issueType: 'writing_rule_no_appearance',
        severity: rule.severity,
        entityType: 'character_state_snapshot',
        entityId: snapshot.id,
        message: `Writing rule "${rule.title}" forbids appearance of ${snapshot.characterName}, but a normal state snapshot was recorded.`,
        evidence: [{ writingRuleId: rule.id, ruleType: rule.ruleType, characterStateSnapshotId: snapshot.id, chapterNo: snapshot.chapterNo, stateType: snapshot.stateType, stateValue: snapshot.stateValue }],
        suggestion: 'Remove the state snapshot or mark the scene as memory/corpse/illusion when that is the intended exception.',
      });
    }
  }

  private addForbiddenRuleIssues(
    issues: ComputedIssue[],
    rule: WritingRuleRow,
    terms: string[],
    storyEvents: StoryEventRow[],
    characterStates: CharacterStateSnapshotRow[],
  ) {
    for (const event of storyEvents) {
      if (!this.isRuleActiveAt(rule, event.chapterNo)) continue;
      const text = `${event.title}\n${event.description ?? ''}`;
      const matchedTerm = this.firstMatchedTerm(text, terms);
      if (!matchedTerm) continue;

      issues.push({
        chapterId: event.chapterId,
        issueType: 'writing_rule_forbidden_text',
        severity: rule.severity,
        entityType: 'story_event',
        entityId: event.id,
        message: `Writing rule "${rule.title}" forbids "${matchedTerm}", but it appears in story event "${event.title}".`,
        evidence: [{ writingRuleId: rule.id, ruleType: rule.ruleType, matchedTerm, storyEventId: event.id, chapterNo: event.chapterNo }],
        suggestion: 'Rewrite the event fact or narrow the writing rule range/entity if this mention is intentional.',
      });
    }

    for (const snapshot of characterStates) {
      if (snapshot.status === 'rejected' || !this.isRuleActiveAt(rule, snapshot.chapterNo)) continue;
      const text = `${snapshot.characterName}\n${snapshot.stateType}\n${snapshot.stateValue}\n${snapshot.summary ?? ''}`;
      const matchedTerm = this.firstMatchedTerm(text, terms);
      if (!matchedTerm) continue;

      issues.push({
        chapterId: snapshot.chapterId,
        issueType: 'writing_rule_forbidden_text',
        severity: rule.severity,
        entityType: 'character_state_snapshot',
        entityId: snapshot.id,
        message: `Writing rule "${rule.title}" forbids "${matchedTerm}", but it appears in a character state snapshot.`,
        evidence: [{ writingRuleId: rule.id, ruleType: rule.ruleType, matchedTerm, characterStateSnapshotId: snapshot.id, chapterNo: snapshot.chapterNo, stateType: snapshot.stateType, stateValue: snapshot.stateValue }],
        suggestion: 'Rewrite the character state or narrow the writing rule if this mention is allowed.',
      });
    }
  }

  private addTimelineEventIssues(
    issues: ComputedIssue[],
    timelineEvents: TimelineEventRow[],
    storyEvents: StoryEventRow[],
    characterStates: CharacterStateSnapshotRow[],
    scopedChapterId?: string,
  ) {
    this.addTimelineOrderIssues(issues, timelineEvents, scopedChapterId);
    this.addTimelineLocationIssues(issues, timelineEvents, scopedChapterId);
    this.addTimelineKnowledgeIssues(issues, timelineEvents, storyEvents, characterStates);
  }

  private addTimelineOrderIssues(issues: ComputedIssue[], timelineEvents: TimelineEventRow[], scopedChapterId?: string) {
    let previous: { id: string; title: string; chapterNo: number | null; eventTime: string; orderValue: number } | undefined;
    const ordered = [...timelineEvents]
      .filter((event) => event.eventTime && typeof event.chapterNo === 'number')
      .sort((a, b) => (a.chapterNo ?? 0) - (b.chapterNo ?? 0));

    for (const event of ordered) {
      const orderValue = this.parseEventOrderValue(event.eventTime);
      if (orderValue == null || !event.eventTime) continue;

      if (previous && orderValue < previous.orderValue && this.isInIssueScope(event.chapterId, scopedChapterId)) {
        issues.push({
          chapterId: event.chapterId,
          issueType: 'timeline_event_order_conflict',
          severity: 'warning',
          entityType: 'timeline_event',
          entityId: event.id,
          message: `Timeline event "${event.title}" has eventTime=${event.eventTime}, earlier than previous chapter timeline event "${previous.title}" (${previous.eventTime}).`,
          evidence: [{ timelineEventId: event.id, chapterNo: event.chapterNo, eventTime: event.eventTime, previousTimelineEventId: previous.id, previousChapterNo: previous.chapterNo, previousEventTime: previous.eventTime }],
          suggestion: 'Check eventTime and chapterNo ordering before generation uses this timeline.',
        });
      }

      if (!previous || orderValue >= previous.orderValue) {
        previous = { id: event.id, title: event.title, chapterNo: event.chapterNo, eventTime: event.eventTime, orderValue };
      }
    }
  }

  private addTimelineLocationIssues(issues: ComputedIssue[], timelineEvents: TimelineEventRow[], scopedChapterId?: string) {
    const groups = new Map<string, Array<{ event: TimelineEventRow; location: string }>>();
    for (const event of timelineEvents) {
      if (!event.eventTime || !event.locationName) continue;
      for (const participant of this.readStringArray(event.participants)) {
        const key = `${this.normalizeSearchText(event.eventTime)}:${this.normalizeSearchText(participant)}`;
        const group = groups.get(key) ?? [];
        group.push({ event, location: event.locationName });
        groups.set(key, group);
      }
    }

    for (const group of groups.values()) {
      const locations = [...new Set(group.map((item) => item.location).filter(Boolean))];
      if (locations.length < 2) continue;
      const scoped = group.find((item) => this.isInIssueScope(item.event.chapterId, scopedChapterId));
      if (!scoped) continue;
      const participant = this.readStringArray(scoped.event.participants)[0] ?? 'unknown';

      issues.push({
        chapterId: scoped.event.chapterId,
        issueType: 'timeline_location_conflict',
        severity: 'warning',
        entityType: 'timeline_event',
        entityId: scoped.event.id,
        message: `Timeline participant "${participant}" appears in multiple locations at eventTime=${scoped.event.eventTime}.`,
        evidence: group.map((item) => ({ timelineEventId: item.event.id, title: item.event.title, chapterNo: item.event.chapterNo, eventTime: item.event.eventTime, locationName: item.location })),
        suggestion: 'Split the eventTime, clarify travel/remote presence, or fix the participant/location data.',
      });
    }
  }

  private addTimelineKnowledgeIssues(
    issues: ComputedIssue[],
    timelineEvents: TimelineEventRow[],
    storyEvents: StoryEventRow[],
    characterStates: CharacterStateSnapshotRow[],
  ) {
    for (const timelineEvent of timelineEvents) {
      const unknownBy = this.readStringArray(timelineEvent.unknownBy);
      const leakTerms = this.extractTimelineLeakTerms(timelineEvent);
      if (!unknownBy.length || !leakTerms.length) continue;

      for (const event of storyEvents) {
        if (!this.isSameOrAfter(timelineEvent.chapterNo, event.chapterNo)) continue;
        const participants = this.readStringArray(event.participants);
        const leakedCharacters = unknownBy.filter((name) => participants.some((participant) => this.equalsLoose(participant, name)));
        if (!leakedCharacters.length) continue;
        const matchedTerm = this.firstMatchedTerm(`${event.title}\n${event.description ?? ''}`, leakTerms);
        if (!matchedTerm) continue;

        issues.push({
          chapterId: event.chapterId,
          issueType: 'timeline_knowledge_leak',
          severity: 'error',
          entityType: 'story_event',
          entityId: event.id,
          message: `Timeline event "${timelineEvent.title}" is unknown to ${leakedCharacters.join(', ')}, but related knowledge appears in story event "${event.title}".`,
          evidence: [{ timelineEventId: timelineEvent.id, unknownBy, leakedCharacters, matchedTerm, storyEventId: event.id, timelineChapterNo: timelineEvent.chapterNo, factChapterNo: event.chapterNo }],
          suggestion: 'Remove the leaked knowledge or update TimelineEvent knownBy/unknownBy when the character has legitimately learned it.',
        });
      }

      for (const snapshot of characterStates) {
        if (snapshot.status === 'rejected' || !this.isSameOrAfter(timelineEvent.chapterNo, snapshot.chapterNo)) continue;
        if (!unknownBy.some((name) => this.equalsLoose(snapshot.characterName, name))) continue;
        const matchedTerm = this.firstMatchedTerm(`${snapshot.stateValue}\n${snapshot.summary ?? ''}`, leakTerms);
        if (!matchedTerm) continue;

        issues.push({
          chapterId: snapshot.chapterId,
          issueType: 'timeline_knowledge_leak',
          severity: 'error',
          entityType: 'character_state_snapshot',
          entityId: snapshot.id,
          message: `Timeline event "${timelineEvent.title}" is unknown to ${snapshot.characterName}, but related knowledge appears in the character state.`,
          evidence: [{ timelineEventId: timelineEvent.id, unknownBy, characterName: snapshot.characterName, matchedTerm, characterStateSnapshotId: snapshot.id, timelineChapterNo: timelineEvent.chapterNo, factChapterNo: snapshot.chapterNo }],
          suggestion: 'Remove the leaked state or update TimelineEvent knownBy/unknownBy if the character has learned it.',
        });
      }
    }
  }

  private ruleEntityNames(rule: WritingRuleRow): string[] {
    return this.uniqueStrings([rule.entityRef, rule.title]).filter((item) => item.length >= 2);
  }

  private extractRuleTerms(rule: WritingRuleRow): string[] {
    const metadataTerms = this.readMetadataStringArray(rule.metadata, 'forbiddenTerms');
    const quoted = `${rule.title}\n${rule.content}`.match(/[「『“"]([^」』”"]{2,40})[」』”"]/g) ?? [];
    const quotedTerms = quoted.map((item) => item.replace(/[「『“"」』”]/g, '').trim());
    const fallbackTerms = rule.entityRef ? [] : [rule.title];
    return this.uniqueStrings([...metadataTerms, ...quotedTerms, ...fallbackTerms]).filter((item) => item.length >= 2).slice(0, 8);
  }

  private extractTimelineLeakTerms(event: TimelineEventRow): string[] {
    return this.uniqueStrings([
      event.title,
      ...this.extractSignificantTerms(event.result),
      ...this.extractSignificantTerms(event.cause),
    ]).filter((item) => item.length >= 2).slice(0, 8);
  }

  private extractSignificantTerms(value: string | null | undefined): string[] {
    if (!value) return [];
    const cjk = value.match(/[\u4e00-\u9fff]{3,}/g) ?? [];
    const latin = value.match(/[A-Za-z0-9_]{4,}/g) ?? [];
    return [...cjk, ...latin].slice(0, 6);
  }

  private isRuleActiveAt(rule: WritingRuleRow, chapterNo: number | null | undefined): boolean {
    if (rule.status !== 'active') return false;
    if (typeof chapterNo !== 'number') {
      return rule.appliesFromChapterNo == null && rule.appliesToChapterNo == null;
    }
    if (rule.appliesFromChapterNo != null && rule.appliesFromChapterNo > chapterNo) return false;
    if (rule.appliesToChapterNo != null && rule.appliesToChapterNo < chapterNo) return false;
    return true;
  }

  private isSameOrAfter(baseChapterNo: number | null | undefined, factChapterNo: number | null | undefined): boolean {
    if (typeof baseChapterNo !== 'number' || typeof factChapterNo !== 'number') return true;
    return factChapterNo >= baseChapterNo;
  }

  private isInIssueScope(issueChapterId: string | null | undefined, scopedChapterId?: string): boolean {
    return !scopedChapterId || issueChapterId === scopedChapterId;
  }

  private parseEventOrderValue(value: string | null | undefined): number | null {
    if (!value?.trim()) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private firstMatchedTerm(text: string, terms: string[]): string | undefined {
    return terms.find((term) => this.includesLoose(text, term));
  }

  private includesLoose(text: string, term: string): boolean {
    const normalizedText = this.normalizeSearchText(text);
    const normalizedTerm = this.normalizeSearchText(term);
    return normalizedTerm.length >= 2 && normalizedText.includes(normalizedTerm);
  }

  private equalsLoose(a: string, b: string): boolean {
    return this.normalizeSearchText(a) === this.normalizeSearchText(b);
  }

  private normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[\s"'“”‘’「」『』《》【】（）(),，。；;、.!！?？:：-]/g, '');
  }

  private severityRank(value: unknown): number {
    return value === 'error' ? 3 : value === 'warning' ? 2 : value === 'info' ? 1 : 0;
  }

  private isNormalAppearanceText(text: string): boolean {
    const normalized = this.normalizeSearchText(text);
    const exceptionTerms = ['回忆', '幻觉', '尸体', '遗体', '尸骸', '死亡', '已死', '鬼魂', '梦境', 'memory', 'flashback', 'corpse', 'body', 'dead', 'deceased', 'ghost', 'illusion'];
    return !exceptionTerms.some((term) => normalized.includes(this.normalizeSearchText(term)));
  }

  private readStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private readMetadataStringArray(metadata: unknown, key: string): string[] {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
    return this.readStringArray((metadata as Record<string, unknown>)[key]);
  }

  private uniqueStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const trimmed = value?.trim();
      if (!trimmed) continue;
      const key = this.normalizeSearchText(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
    return result;
  }
}
