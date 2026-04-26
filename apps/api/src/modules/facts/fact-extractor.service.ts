import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';

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

export interface FactExtractionResult {
  chapterId: string;
  draftId: string;
  summary: string;
  createdEvents: number;
  createdCharacterStates: number;
  createdForeshadows: number;
  events: ExtractedEvent[];
  characterStates: ExtractedCharacterState[];
  foreshadows: ExtractedForeshadow[];
}

const MAX_TEXT_CHARS = 8000;

/**
 * API 内事实抽取服务，迁移 Worker FactExtractor + SummaryService 的核心能力。
 * 输入章节草稿；副作用是替换该草稿来源的自动剧情事件、角色状态和伏笔记录。
 */
@Injectable()
export class FactExtractorService {
  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService) {}

  async extractChapterFacts(projectId: string, chapterId: string, draftId?: string): Promise<FactExtractionResult> {
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, include: { project: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const draft = draftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: draftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!draft) throw new NotFoundException(`章节 ${chapterId} 暂无可抽取事实的草稿`);

    const [summary, events, characterStates, foreshadows] = await Promise.all([
      this.summarizeChapter(chapter.project.title, chapter, draft.content),
      this.extractEvents(chapter.project.title, chapter, draft.content),
      this.extractCharacterStates(chapter.project.title, chapter, draft.content),
      this.extractForeshadows(chapter.project.title, chapter, draft.content),
    ]);

    const created = await this.prisma.$transaction(async (tx) => {
      // 仅替换同一草稿由 Agent 自动抽取的事实，避免删除人工维护或其他草稿来源的事实层数据。
      await Promise.all([
        tx.storyEvent.deleteMany({ where: { projectId, chapterId, sourceDraftId: draft.id, metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } } }),
        tx.characterStateSnapshot.deleteMany({ where: { projectId, chapterId, sourceDraftId: draft.id, metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } } }),
        tx.foreshadowTrack.deleteMany({ where: { projectId, chapterId, sourceDraftId: draft.id, metadata: { path: ['generatedBy'], equals: 'agent_fact_extractor' } } }),
      ]);

      const createdEvents = [];
      for (const event of events) {
        createdEvents.push(
          await tx.storyEvent.create({
            data: {
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
            },
          }),
        );
      }

      const createdStates = [];
      for (const state of characterStates) {
        createdStates.push(
          await tx.characterStateSnapshot.create({
            data: {
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
            },
          }),
        );
      }

      const createdForeshadows = [];
      for (const item of foreshadows) {
        createdForeshadows.push(
          await tx.foreshadowTrack.create({
            data: {
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
            },
          }),
        );
      }

      return { createdEvents, createdStates, createdForeshadows };
    });

    return {
      chapterId,
      draftId: draft.id,
      summary,
      createdEvents: created.createdEvents.length,
      createdCharacterStates: created.createdStates.length,
      createdForeshadows: created.createdForeshadows.length,
      events,
      characterStates,
      foreshadows,
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
}