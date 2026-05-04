import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { ToolManifestForPlanner } from '../agent-tools/tool-manifest.types';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';

export interface GuidedAgentContext {
  currentStep?: string;
  currentStepLabel?: string;
  currentStepData?: Record<string, unknown>;
  completedSteps?: string[];
  documentDraft?: Record<string, unknown>;
}

export interface AgentContextAttachment {
  id: string;
  kind: 'creative_document';
  fileName: string;
  extension: string;
  mimeType?: string;
  size?: number;
  url: string;
  provider?: string;
}

export interface AgentContextV2 {
  schemaVersion: 2;
  userMessage: string;
  runtime: {
    mode: 'plan' | 'act';
    agentRunId?: string;
    planVersion?: number;
    locale: string;
    timezone?: string;
    maxSteps: number;
    maxLlmCalls: number;
  };
  session: {
    currentProjectId?: string;
    currentProjectTitle?: string;
    currentVolumeId?: string;
    currentVolumeTitle?: string;
    currentChapterId?: string;
    currentChapterTitle?: string;
    currentChapterIndex?: number;
    currentDraftId?: string;
    currentDraftVersion?: number;
    selectedText?: string;
    selectedRange?: { start: number; end: number };
    sourcePage?: string;
    clarification?: {
      latestChoice?: { id?: string; label?: string; payload?: unknown; message?: string; answeredAt?: string };
      history: Array<{ roundNo?: number; question?: string; selectedChoice?: unknown; answeredAt?: string }>;
    };
    guided?: GuidedAgentContext;
  };
  project?: {
    id: string;
    title: string;
    genre?: string | null;
    style?: string | null;
    synopsis?: string | null;
    defaultWordCount?: number | null;
    status?: string;
  };
  currentChapter?: {
    id: string;
    title?: string | null;
    index: number;
    status: string;
    outline?: string | null;
    summary?: string | null;
    draftId?: string;
    draftVersion?: number;
    endingSummary?: string | null;
  };
  recentChapters: Array<{ id: string; title?: string | null; index: number; summary: string; keyEvents?: string[] }>;
  knownCharacters: Array<{ id: string; name: string; aliases: string[]; role?: string | null; currentState?: string | null; relationshipHints?: string[] }>;
  worldFacts: Array<{ id: string; type: 'setting' | 'rule' | 'location' | 'faction' | 'timeline' | 'foreshadowing'; title: string; content: string; locked?: boolean }>;
  memoryHints: Array<{ id: string; type: string; content: string; relevance: number; source?: string }>;
  attachments: AgentContextAttachment[];
  constraints: { hardRules: string[]; styleRules: string[]; approvalRules: string[]; idPolicy: string[] };
  availableTools: ToolManifestForPlanner[];
}

/**
 * AgentContext V2 构造器只聚合运行上下文，不做 taskType 判断，也不猜测自然语言实体。
 * 副作用：无业务写入；Runtime 会把输出快照写回 AgentRun.input 供审计和 Executor 引用。
 */
@Injectable()
export class AgentContextBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: ToolRegistryService,
    private readonly rules: RuleEngineService,
  ) {}

  async buildForPlan(run: { id: string; projectId: string; chapterId?: string | null; goal: string; input: Prisma.JsonValue | null }): Promise<AgentContextV2> {
    const input = this.asRecord(run.input);
    const sessionHints = this.asRecord(input.context);
    const currentChapterId = this.stringValue(sessionHints.currentChapterId) ?? run.chapterId ?? undefined;
    const clarification = this.clarificationValue(input);
    const attachments = this.attachmentSummaries(input.attachments);

    const [project, currentChapter, recentChapters, knownCharacters, worldFacts, memoryHints] = await Promise.all([
      this.prisma.project.findUnique({ where: { id: run.projectId } }),
      currentChapterId
        ? this.prisma.chapter.findFirst({ where: { id: currentChapterId, projectId: run.projectId }, include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: 1 } } })
        : Promise.resolve(null),
      this.loadRecentChapters(run.projectId, currentChapterId),
      this.loadKnownCharacters(run.projectId),
      this.loadWorldFacts(run.projectId),
      this.loadMemoryHints(run.projectId),
    ]);

    const currentDraft = currentChapter?.drafts[0];
    const policy = this.rules.getPolicy();
    return {
      schemaVersion: 2,
      userMessage: run.goal,
      runtime: { mode: 'plan', agentRunId: run.id, locale: 'zh-CN', timezone: 'Asia/Shanghai', maxSteps: policy.limits.maxSteps, maxLlmCalls: policy.limits.maxLlmCalls },
      session: {
        currentProjectId: run.projectId,
        currentProjectTitle: project?.title,
        currentVolumeId: this.stringValue(sessionHints.currentVolumeId) ?? currentChapter?.volumeId ?? undefined,
        currentVolumeTitle: this.stringValue(sessionHints.currentVolumeTitle),
        currentChapterId,
        currentChapterTitle: this.stringValue(sessionHints.currentChapterTitle) ?? currentChapter?.title ?? undefined,
        currentChapterIndex: this.numberValue(sessionHints.currentChapterIndex) ?? currentChapter?.chapterNo,
        currentDraftId: this.stringValue(sessionHints.currentDraftId) ?? currentDraft?.id,
        currentDraftVersion: this.numberValue(sessionHints.currentDraftVersion) ?? currentDraft?.versionNo,
        selectedText: this.stringValue(sessionHints.selectedText),
        selectedRange: this.rangeValue(sessionHints.selectedRange),
        sourcePage: this.stringValue(sessionHints.sourcePage),
        clarification: clarification.history.length || clarification.latestChoice ? clarification : undefined,
        guided: this.guidedValue(sessionHints.guided),
      },
      project: project
        ? { id: project.id, title: project.title, genre: project.genre, style: project.tone, synopsis: project.synopsis, defaultWordCount: project.targetWordCount, status: project.status }
        : undefined,
      currentChapter: currentChapter
        ? {
            id: currentChapter.id,
            title: currentChapter.title,
            index: currentChapter.chapterNo,
            status: currentChapter.status,
            outline: currentChapter.outline,
            summary: currentChapter.objective ?? currentChapter.conflict,
            draftId: currentDraft?.id,
            draftVersion: currentDraft?.versionNo,
            endingSummary: currentDraft ? this.createEndingSummary(currentDraft.content) : null,
          }
        : undefined,
      recentChapters,
      knownCharacters,
      worldFacts,
      memoryHints,
      attachments,
      constraints: {
        hardRules: this.rules.listHardRules(),
        styleRules: project?.tone ? [`项目默认语气/风格：${project.tone}`] : [],
        approvalRules: ['Plan 阶段不得写正式业务表。', '有副作用或写入类工具必须等待用户审批后在 Act 阶段执行。'],
        idPolicy: [
          '不要编造 projectId、volumeId、chapterId、characterId、draftId、lorebookEntryId、memoryChunkId。',
          '自然语言引用（如“第十二章”“下一章”“男主”）必须通过 resolver 或上下文明确字段转换为真实 ID。',
          '如果无法解析必要 ID，写入 missingInfo 或要求用户选择，不要硬猜。',
        ],
      },
      availableTools: this.tools.listManifestsForPlanner(),
    };
  }

  createDigest(context: AgentContextV2) {
    const raw = JSON.stringify(context);
    let hash = 0;
    for (let index = 0; index < raw.length; index += 1) hash = (hash * 31 + raw.charCodeAt(index)) >>> 0;
    return `ctxv2_${hash.toString(36)}_${raw.length}`;
  }

  private async loadRecentChapters(projectId: string, currentChapterId?: string) {
    const current = currentChapterId ? await this.prisma.chapter.findFirst({ where: { id: currentChapterId, projectId }, select: { chapterNo: true } }) : null;
    const where = current ? { projectId, chapterNo: { lt: current.chapterNo } } : { projectId };
    const chapters = await this.prisma.chapter.findMany({ where, orderBy: { chapterNo: 'desc' }, take: 5 });
    return chapters.reverse().map((chapter) => ({ id: chapter.id, title: chapter.title, index: chapter.chapterNo, summary: chapter.objective ?? chapter.outline ?? chapter.conflict ?? '暂无摘要' }));
  }

  private async loadKnownCharacters(projectId: string) {
    const characters = await this.prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 20 });
    return characters.map((character) => ({ id: character.id, name: character.name, aliases: this.stringArray(character.alias), role: character.roleType, currentState: character.personalityCore ?? character.motivation }));
  }

  private async loadWorldFacts(projectId: string) {
    const facts = await this.prisma.lorebookEntry.findMany({ where: { projectId, status: 'active' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 12 });
    return facts.map((fact) => ({ id: fact.id, type: this.mapWorldFactType(fact.entryType), title: fact.title, content: fact.summary ?? fact.content.slice(0, 600), locked: fact.status === 'locked' }));
  }

  private async loadMemoryHints(projectId: string) {
    const chunks = await this.prisma.memoryChunk.findMany({ where: { projectId }, orderBy: [{ importanceScore: 'desc' }, { recencyScore: 'desc' }], take: 8 });
    return chunks.map((chunk) => ({ id: chunk.id, type: chunk.memoryType, content: chunk.summary ?? chunk.content.slice(0, 500), relevance: Math.max(chunk.importanceScore, chunk.recencyScore), source: chunk.sourceType }));
  }

  private mapWorldFactType(value: string): AgentContextV2['worldFacts'][number]['type'] {
    if (['location', 'faction', 'timeline', 'foreshadowing', 'rule', 'setting'].includes(value)) return value as AgentContextV2['worldFacts'][number]['type'];
    return 'setting';
  }

  private createEndingSummary(content: string) {
    return content.trim().slice(-360) || null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private numberValue(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private stringArray(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  }

  private rangeValue(value: unknown) {
    const record = this.asRecord(value);
    const start = this.numberValue(record.start);
    const end = this.numberValue(record.end);
    return start !== undefined && end !== undefined ? { start, end } : undefined;
  }

  private guidedValue(value: unknown): GuidedAgentContext | undefined {
    const record = this.asRecord(value);
    const currentStepData = this.nonEmptyRecord(record.currentStepData);
    const documentDraft = this.nonEmptyRecord(record.documentDraft);
    const guided: GuidedAgentContext = {
      currentStep: this.stringValue(record.currentStep),
      currentStepLabel: this.stringValue(record.currentStepLabel),
      ...(currentStepData ? { currentStepData } : {}),
      completedSteps: this.stringArray(record.completedSteps),
      ...(documentDraft ? { documentDraft } : {}),
    };
    return Object.values(guided).some((item) => Array.isArray(item) ? item.length > 0 : item !== undefined) ? guided : undefined;
  }

  private nonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
    const record = this.asRecord(value);
    return Object.keys(record).length ? record : undefined;
  }

  private attachmentSummaries(value: unknown): AgentContextAttachment[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const record = this.asRecord(item);
      if (this.stringValue(record.kind) !== 'creative_document') return [];
      const id = this.stringValue(record.id);
      const fileName = this.stringValue(record.fileName);
      const extension = this.stringValue(record.extension);
      const url = this.stringValue(record.url);
      if (!id || !fileName || !extension || !url) return [];

      return [{
        id,
        kind: 'creative_document' as const,
        fileName,
        extension,
        mimeType: this.stringValue(record.mimeType),
        size: this.numberValue(record.size),
        url,
        provider: this.stringValue(record.provider),
      }];
    });
  }

  /**
   * 将 Runtime 保存的多轮澄清状态注入 Planner session。
   * 只透传用户显式选择与候选上下文，不替 Planner 自动选择新实体，避免扩大写入范围。
   */
  private clarificationValue(input: Record<string, unknown>): NonNullable<AgentContextV2['session']['clarification']> {
    const state = this.asRecord(input.clarificationState);
    const history = Array.isArray(state.history)
      ? state.history.map((item) => {
          const record = this.asRecord(item);
          return {
            roundNo: this.numberValue(record.roundNo),
            question: this.stringValue(record.question),
            selectedChoice: record.selectedChoice,
            answeredAt: this.stringValue(record.answeredAt),
          };
        })
      : [];
    const latestChoice = this.asRecord(state.latestChoice);
    const legacyChoice = this.asRecord(this.asRecord(input.context).clarificationChoice);
    const selected = Object.keys(latestChoice).length ? latestChoice : legacyChoice;
    return {
      latestChoice: Object.keys(selected).length
        ? {
            id: this.stringValue(selected.id),
            label: this.stringValue(selected.label),
            payload: selected.payload,
            message: this.stringValue(selected.message),
            answeredAt: this.stringValue(selected.answeredAt),
          }
        : undefined,
      history,
    };
  }
}
