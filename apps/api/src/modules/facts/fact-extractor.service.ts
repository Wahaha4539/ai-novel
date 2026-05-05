import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { ChapterFirstAppearanceMemoryInput, MemoryWriterService } from '../memory/memory-writer.service';

interface ExtractedEvent {
  title: string;
  eventType: string;
  description: string;
  participants: string[];
  timelineSeq?: number;
}

interface ExtractedCharacterState {
  character: string;
  stateType: string;
  stateValue: string;
  summary?: string;
}

interface ExtractedForeshadow {
  title: string;
  detail: string;
  status?: string;
}

type FirstAppearanceEntityType = ChapterFirstAppearanceMemoryInput['entityType'];

interface ExtractedFirstAppearance {
  entityType: FirstAppearanceEntityType;
  title: string;
  detail: string;
  significance: 'minor' | 'major' | 'key';
  evidence?: string;
  status: 'auto' | 'pending_review';
}

interface ExtractedRelationshipChange {
  characterA: string;
  characterB: string;
  relationType: string;
  change: string;
  evidence?: string;
  summary?: string;
}

export interface FactExtractionResult {
  chapterId: string;
  draftId: string;
  summary: string;
  createdEvents: number;
  createdCharacterStates: number;
  createdForeshadows: number;
  createdCharacters: number;
  createdLorebookCandidates: number;
  firstAppearanceCandidates: number;
  createdMemoryChunks: number;
  pendingReviewMemoryChunks: number;
  events: ExtractedEvent[];
  characterStates: ExtractedCharacterState[];
  foreshadows: ExtractedForeshadow[];
  firstAppearances: ExtractedFirstAppearance[];
  relationshipChanges: ExtractedRelationshipChange[];
}

const MAX_TEXT_CHARS = 8000;

/**
 * API 内事实抽取服务，迁移 Worker FactExtractor + SummaryService 的核心能力。
 * 输入章节草稿；副作用是替换该草稿来源的自动剧情事件、角色状态和伏笔记录。
 */
@Injectable()
export class FactExtractorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmGatewayService,
    private readonly memoryWriter: MemoryWriterService,
    private readonly cacheService?: NovelCacheService,
  ) {}

  async extractChapterFacts(projectId: string, chapterId: string, draftId?: string): Promise<FactExtractionResult> {
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, include: { project: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const draft = draftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: draftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!draft) throw new NotFoundException(`章节 ${chapterId} 暂无可抽取事实的草稿`);

    const [summary, events, characterStates, foreshadows, firstAppearances, relationshipChanges] = await Promise.all([
      this.summarizeChapter(chapter.project.title, chapter, draft.content),
      this.extractEvents(chapter.project.title, chapter, draft.content),
      this.extractCharacterStates(chapter.project.title, chapter, draft.content),
      this.extractForeshadows(chapter.project.title, chapter, draft.content),
      this.extractFirstAppearances(chapter.project.title, chapter, draft.content),
      this.extractRelationshipChanges(chapter.project.title, chapter, draft.content),
    ]);
    const eventInputs = this.dedupeEvents([...events, ...this.relationshipChangesToEvents(relationshipChanges, chapter)]);
    const firstAppearanceWrite = await this.persistFirstAppearanceCandidates(projectId, chapter, draft.id, firstAppearances);
    if (firstAppearanceWrite.createdLorebookCandidates > 0) {
      await this.cacheService?.deleteProjectRecallResults(projectId);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // 仅替换同一草稿由 Agent 自动抽取的事实，避免删除人工维护或其他草稿来源的事实层数据。
      await Promise.all([
        tx.storyEvent.deleteMany({ where: { projectId, chapterId, sourceDraftId: draft.id, metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } } }),
        tx.characterStateSnapshot.deleteMany({ where: { projectId, chapterId, sourceDraftId: draft.id, metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } } }),
        tx.foreshadowTrack.deleteMany({ where: { projectId, chapterId, sourceDraftId: draft.id, metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } } }),
      ]);

      // 批量写入可显著缩短 interactive transaction 时间，避免 Prisma 默认事务超时后 tx 被关闭。
      const createdEvents = eventInputs.length
        ? await tx.storyEvent.createMany({
            data: eventInputs.map((event) => ({
              projectId,
              chapterId,
              chapterNo: chapter.chapterNo,
              sourceDraftId: draft.id,
              title: event.title,
              eventType: event.eventType,
              description: event.description,
              participants: event.participants as Prisma.InputJsonValue,
              timelineSeq: event.timelineSeq ?? chapter.timelineSeq ?? chapter.chapterNo,
              status: 'detected',
              metadata: { generatedBy: 'agent_fact_extractor', summary } as Prisma.InputJsonValue,
            })),
          })
        : { count: 0 };

      const createdStates = characterStates.length
        ? await tx.characterStateSnapshot.createMany({
            data: characterStates.map((state) => ({
              projectId,
              chapterId,
              chapterNo: chapter.chapterNo,
              sourceDraftId: draft.id,
              characterName: state.character,
              stateType: state.stateType,
              stateValue: state.stateValue,
              summary: state.summary,
              status: 'auto',
              metadata: { generatedBy: 'agent_fact_extractor' } as Prisma.InputJsonValue,
            })),
          })
        : { count: 0 };

      const createdForeshadows = foreshadows.length
        ? await tx.foreshadowTrack.createMany({
            data: foreshadows.map((item) => ({
              projectId,
              chapterId,
              chapterNo: chapter.chapterNo,
              sourceDraftId: draft.id,
              title: item.title,
              detail: item.detail,
              status: item.status ?? 'planted',
              scope: 'chapter',
              source: 'auto_extracted',
              firstSeenChapterNo: chapter.chapterNo,
              lastSeenChapterNo: chapter.chapterNo,
              metadata: { generatedBy: 'agent_fact_extractor' } as Prisma.InputJsonValue,
            })),
          })
        : { count: 0 };

      return { createdEvents, createdStates, createdForeshadows };
    }, { timeout: 30_000, maxWait: 10_000 });

    // 与旧 Worker rebuild/generate 链路保持一致：事实抽取后同步生成 MemoryChunk。
    // 其中角色状态和伏笔会进入 pending_review，供后续 review_memory 自动采纳或拒绝。
    const memory = await this.memoryWriter.replaceGeneratedChapterFactMemories({
      projectId,
      chapter: { id: chapter.id, chapterNo: chapter.chapterNo },
      generatedBy: 'agent_fact_extractor',
      summary,
      events: eventInputs,
      characterStates,
      foreshadows,
      firstAppearances,
    });
    const pendingReviewMemoryChunks = memory.chunks.filter((chunk) => chunk.status === 'pending_review').length;

    return {
      chapterId,
      draftId: draft.id,
      summary,
      createdEvents: created.createdEvents.count,
      createdCharacterStates: created.createdStates.count,
      createdForeshadows: created.createdForeshadows.count,
      createdCharacters: firstAppearanceWrite.createdCharacters,
      createdLorebookCandidates: firstAppearanceWrite.createdLorebookCandidates,
      firstAppearanceCandidates: firstAppearances.length,
      createdMemoryChunks: memory.createdCount,
      pendingReviewMemoryChunks,
      events: eventInputs,
      characterStates,
      foreshadows,
      firstAppearances,
      relationshipChanges,
    };
  }

  private async summarizeChapter(projectTitle: string, chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null }, text: string): Promise<string> {
    const result = await this.llm.chat(
      [
        { role: 'system', content: '你是一名专业小说分析助手。请输出 80~200 字章节摘要，覆盖核心事件、角色变化、结尾悬念或转折。只输出摘要正文。' },
        { role: 'user', content: `作品：《${projectTitle}》\n章节：第${chapter.chapterNo}章「${chapter.title ?? ''}」\n章节目标：${chapter.objective ?? ''}\n核心冲突：${chapter.conflict ?? ''}\n\n--- 正文 ---\n${text.slice(0, MAX_TEXT_CHARS)}\n--- 正文结束 ---\n\n请输出本章摘要：` },
      ],
      { appStep: 'summary', maxTokens: 700, timeoutMs: 120_000, retries: 1, temperature: 0.2 },
    );
    const summary = result.text.trim().slice(0, 500);
    if (!summary) throw new Error(`第${chapter.chapterNo}章摘要抽取为空，已拒绝写入低质量事实层。`);
    return summary;
  }

  private async extractEvents(projectTitle: string, chapter: { chapterNo: number; title: string | null }, text: string): Promise<ExtractedEvent[]> {
    return this.extractJsonArray<ExtractedEvent>('fact_extractor.events', '你是小说叙事分析师。只输出 JSON 数组，提取 3~6 个关键剧情事件。字段：title,eventType,description,participants,timelineSeq。eventType 限定为 plot_turning/dialogue_conflict/action_event/revelation/relationship_shift。', projectTitle, chapter, text, (item, index) => ({
      title: item.title || `事件 ${index + 1}`,
      eventType: item.eventType || 'plot_turning',
      description: item.description || '',
      participants: Array.isArray(item.participants) ? item.participants.map(String) : [],
      timelineSeq: Number(item.timelineSeq) || chapter.chapterNo,
    }));
  }

  private async extractCharacterStates(projectTitle: string, chapter: { chapterNo: number; title: string | null }, text: string): Promise<ExtractedCharacterState[]> {
    return this.extractJsonArray<ExtractedCharacterState>('fact_extractor.states', '你是小说角色心理分析师。只输出 JSON 数组，提取本章显著角色状态变化。字段：character,stateType,stateValue,summary。stateType 限定为 mental_state/physical_state/social_state/knowledge_state。', projectTitle, chapter, text, (item) => ({
      character: item.character || '未知角色',
      stateType: item.stateType || 'mental_state',
      stateValue: item.stateValue || '',
      summary: item.summary || '',
    }));
  }

  private async extractForeshadows(projectTitle: string, chapter: { chapterNo: number; title: string | null }, text: string): Promise<ExtractedForeshadow[]> {
    return this.extractJsonArray<ExtractedForeshadow>('fact_extractor.foreshadows', '你是小说伏笔分析专家。只输出 JSON 数组，识别 2~5 个本章已埋设但尚未解决的伏笔。字段：title,detail,status。status 固定 planted。', projectTitle, chapter, text, (item, index) => ({
      title: item.title || `伏笔 ${index + 1}`,
      detail: item.detail || '',
      status: item.status || 'planted',
    }));
  }

  private async extractFirstAppearances(projectTitle: string, chapter: { chapterNo: number; title: string | null }, text: string): Promise<ExtractedFirstAppearance[]> {
    const { data } = await this.llm.chatJson<unknown>(
      [
        { role: 'system', content: '你是小说事实层抽取器。只输出 JSON 数组，识别本章文本中明确首次登场或疑似首次出现的人物、地点、道具、组织、规则或设定。字段：entityType(character/location/item/faction/rule/setting),title,detail,significance(minor/major/key),evidence。不要推断正文没有明确出现的内容。' },
        { role: 'user', content: `作品：《${projectTitle}》\n章节：第${chapter.chapterNo}章「${chapter.title ?? ''}」\n\n--- 正文 ---\n${text.slice(0, MAX_TEXT_CHARS)}\n--- 正文结束 ---` },
      ],
      { appStep: 'fact_extractor.first_appearances', maxTokens: 1400, timeoutMs: 120_000, retries: 1, temperature: 0.1 },
    );
    if (!Array.isArray(data)) return [];
    const allowed = new Set<FirstAppearanceEntityType>(['character', 'location', 'item', 'faction', 'rule', 'setting']);
    const normalized = data
      .map((item): ExtractedFirstAppearance | null => {
        const record = this.asRecord(item);
        const entityType = String(record.entityType ?? '').toLowerCase() as FirstAppearanceEntityType;
        const title = this.cleanText(record.title, 80);
        if (!allowed.has(entityType) || !title) return null;
        const significance = this.normalizeSignificance(record.significance);
        const status = this.statusForFirstAppearance(entityType, significance);
        return {
          entityType,
          title,
          detail: this.cleanText(record.detail, 500) || title,
          significance,
          evidence: this.cleanText(record.evidence, 300),
          status,
        };
      })
      .filter((item): item is ExtractedFirstAppearance => Boolean(item));
    return this.dedupeBy(normalized, (item) => `${item.entityType}:${item.title}`.toLowerCase()).slice(0, 12);
  }

  private async extractRelationshipChanges(projectTitle: string, chapter: { chapterNo: number; title: string | null }, text: string): Promise<ExtractedRelationshipChange[]> {
    const { data } = await this.llm.chatJson<unknown>(
      [
        { role: 'system', content: '你是小说人物关系抽取器。只输出 JSON 数组，提取本章明确发生的人物关系变化。字段：characterA,characterB,relationType,change,evidence,summary。没有明确关系变化则输出 []。' },
        { role: 'user', content: `作品：《${projectTitle}》\n章节：第${chapter.chapterNo}章「${chapter.title ?? ''}」\n\n--- 正文 ---\n${text.slice(0, MAX_TEXT_CHARS)}\n--- 正文结束 ---` },
      ],
      { appStep: 'fact_extractor.relationships', maxTokens: 1000, timeoutMs: 120_000, retries: 1, temperature: 0.1 },
    );
    if (!Array.isArray(data)) return [];
    const normalized = data
      .map((item): ExtractedRelationshipChange | null => {
        const record = this.asRecord(item);
        const characterA = this.cleanText(record.characterA, 80);
        const characterB = this.cleanText(record.characterB, 80);
        const change = this.cleanText(record.change, 400);
        if (!characterA || !characterB || !change || characterA === characterB) return null;
        return {
          characterA,
          characterB,
          relationType: this.cleanText(record.relationType, 60) || 'relationship_shift',
          change,
          evidence: this.cleanText(record.evidence, 300),
          summary: this.cleanText(record.summary, 160),
        };
      })
      .filter((item): item is ExtractedRelationshipChange => Boolean(item));
    return this.dedupeBy(normalized, (item) => `${item.characterA}:${item.characterB}:${item.change}`.toLowerCase()).slice(0, 8);
  }

  private async extractJsonArray<T>(appStep: string, system: string, projectTitle: string, chapter: { chapterNo: number; title: string | null }, text: string, normalize: (item: Partial<T> & Record<string, unknown>, index: number) => T): Promise<T[]> {
    const { data } = await this.llm.chatJson<unknown>(
      [
        { role: 'system', content: system },
        { role: 'user', content: `作品：《${projectTitle}》\n章节：第${chapter.chapterNo}章「${chapter.title ?? ''}」\n\n--- 正文 ---\n${text.slice(0, MAX_TEXT_CHARS)}\n--- 正文结束 ---` },
      ],
      { appStep, maxTokens: 1400, timeoutMs: 120_000, retries: 1, temperature: 0.1 },
    );
    if (!Array.isArray(data)) throw new Error(`${appStep} 未返回 JSON 数组，已拒绝降级为空事实。`);
    return data.filter((item): item is Partial<T> & Record<string, unknown> => Boolean(item && typeof item === 'object')).slice(0, 8).map(normalize);
  }

  /** 将首次出现候选写入事实层入口：人物直接登记为 auto_extracted，设定类只创建候选 LorebookEntry。 */
  private async persistFirstAppearanceCandidates(
    projectId: string,
    chapter: { id: string; chapterNo: number },
    draftId: string,
    appearances: ExtractedFirstAppearance[],
  ): Promise<{ createdCharacters: number; updatedCharacters: number; createdLorebookCandidates: number; skippedExisting: number }> {
    const candidates = this.dedupeBy(appearances, (item) => `${item.entityType}:${item.title}`.toLowerCase());
    if (!candidates.length) return { createdCharacters: 0, updatedCharacters: 0, createdLorebookCandidates: 0, skippedExisting: 0 };

    const characterNames = candidates.filter((item) => item.entityType === 'character').map((item) => item.title);
    const lorebookTitles = candidates.filter((item) => item.entityType !== 'character').map((item) => item.title);
    const [existingCharacters, existingLorebookEntries] = await Promise.all([
      characterNames.length ? this.prisma.character.findMany({ where: { projectId, name: { in: characterNames } } }) : Promise.resolve([]),
      lorebookTitles.length ? this.prisma.lorebookEntry.findMany({ where: { projectId, title: { in: lorebookTitles } } }) : Promise.resolve([]),
    ]);
    const existingCharacterByName = new Map(existingCharacters.map((item) => [item.name, item]));
    const existingLorebookTitles = new Set(existingLorebookEntries.map((item) => item.title));

    return this.prisma.$transaction(async (tx) => {
      let createdCharacters = 0;
      let updatedCharacters = 0;
      let createdLorebookCandidates = 0;
      let skippedExisting = 0;

      for (const item of candidates) {
        if (item.entityType === 'character') {
          const existing = existingCharacterByName.get(item.title);
          if (existing) {
            const shouldUpdateFirstSeen = existing.activeFromChapter == null || existing.activeFromChapter > chapter.chapterNo;
            if (shouldUpdateFirstSeen) {
              await tx.character.update({
                where: { id: existing.id },
                data: { activeFromChapter: chapter.chapterNo, metadata: this.mergeJsonObject(existing.metadata, { firstSeenChapterNo: chapter.chapterNo, firstSeenDraftId: draftId }) as Prisma.InputJsonValue },
              });
              updatedCharacters += 1;
            } else {
              skippedExisting += 1;
            }
            continue;
          }

          await tx.character.create({
            data: {
              projectId,
              name: item.title,
              roleType: 'supporting',
              backstory: item.detail,
              scope: 'chapter',
              activeFromChapter: chapter.chapterNo,
              source: 'auto_extracted',
              metadata: { generatedBy: 'agent_fact_extractor', firstSeenChapterNo: chapter.chapterNo, firstSeenDraftId: draftId, evidence: item.evidence ?? '', significance: item.significance } as Prisma.InputJsonValue,
            },
          });
          createdCharacters += 1;
          continue;
        }

        if (existingLorebookTitles.has(item.title)) {
          skippedExisting += 1;
          continue;
        }

        await tx.lorebookEntry.create({
          data: {
            projectId,
            title: item.title,
            entryType: this.mapFirstAppearanceEntryType(item.entityType),
            content: [`首次出现章节：第${chapter.chapterNo}章`, item.detail, item.evidence ? `证据：${item.evidence}` : ''].filter(Boolean).join('\n'),
            summary: item.detail.slice(0, 240),
            tags: ['first_appearance', item.entityType, `chapter_${chapter.chapterNo}`] as Prisma.InputJsonValue,
            priority: item.significance === 'key' ? 80 : item.significance === 'major' ? 70 : 50,
            status: item.status === 'pending_review' ? 'pending_review' : 'active',
            sourceType: 'auto_extracted',
            metadata: {
              generatedBy: 'agent_fact_extractor',
              firstSeenChapterNo: chapter.chapterNo,
              firstSeenDraftId: draftId,
              evidence: item.evidence ?? '',
              significance: item.significance,
              sourceType: 'auto_extracted',
            } as Prisma.InputJsonValue,
          },
        });
        createdLorebookCandidates += 1;
      }

      return { createdCharacters, updatedCharacters, createdLorebookCandidates, skippedExisting };
    }, { timeout: 30_000, maxWait: 10_000 });
  }

  private relationshipChangesToEvents(changes: ExtractedRelationshipChange[], chapter: { chapterNo: number; timelineSeq?: number | null }): ExtractedEvent[] {
    return changes.map((change) => ({
      title: change.summary || `${change.characterA}与${change.characterB}关系变化`,
      eventType: 'relationship_shift',
      description: change.evidence ? `${change.change}\n证据：${change.evidence}` : change.change,
      participants: [change.characterA, change.characterB],
      timelineSeq: chapter.timelineSeq ?? chapter.chapterNo,
    }));
  }

  private dedupeEvents(events: ExtractedEvent[]): ExtractedEvent[] {
    return this.dedupeBy(events, (event) => `${event.title}:${event.description}`.toLowerCase()).slice(0, 12);
  }

  private statusForFirstAppearance(entityType: FirstAppearanceEntityType, significance: ExtractedFirstAppearance['significance']): 'auto' | 'pending_review' {
    if (significance === 'key' || significance === 'major') return 'pending_review';
    return ['faction', 'rule', 'setting'].includes(entityType) ? 'pending_review' : 'auto';
  }

  private normalizeSignificance(value: unknown): ExtractedFirstAppearance['significance'] {
    return value === 'key' || value === 'major' || value === 'minor' ? value : 'minor';
  }

  private mapFirstAppearanceEntryType(entityType: FirstAppearanceEntityType): string {
    if (entityType === 'faction') return 'faction';
    if (entityType === 'location') return 'location';
    if (entityType === 'item') return 'item';
    if (entityType === 'rule') return 'forbidden_rule';
    return 'world_rule';
  }

  private dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = keyOf(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private cleanText(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return '';
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private mergeJsonObject(value: unknown, patch: Record<string, unknown>): Record<string, unknown> {
    return { ...this.asRecord(value), ...patch };
  }
}
