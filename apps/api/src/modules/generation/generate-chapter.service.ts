import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { PrismaService } from '../../prisma/prisma.service';
import { buildGenerationProfileSnapshot, GenerationProfileSnapshot } from '../generation-profile/generation-profile.defaults';
import { LlmChatResult } from '../llm/dto/llm-chat.dto';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';
import { RetrievalBundle, RetrievalBundleWithCacheMeta, RetrievalService } from '../memory/retrieval.service';
import { RetrievalPlan, RetrievalPlannerDiagnostics } from '../memory/retrieval-plan.types';
import { ValidationService } from '../validation/validation.service';
import { ChapterRewriteCleanupResult, ChapterRewriteCleanupService } from './chapter-rewrite-cleanup.service';
import { ChapterContextPack, PlannedTimelineEvent, SceneExecutionPlan } from './context-pack.types';
import { PromptBuilderService } from './prompt-builder.service';
import { RetrievalPlannerService } from './retrieval-planner.service';

export interface GenerateChapterInput {
  mode?: 'draft' | 'rewrite';
  instruction?: string;
  wordCount?: number;
  includeLorebook?: boolean;
  includeMemory?: boolean;
  validateBeforeWrite?: boolean;
  outlineQualityGate?: 'warning' | 'blocker';
  agentRunId?: string;
  userId?: string;
  requestId?: string;
  jobId?: string;
  progress?: ChapterGenerationProgressReporter;
}

interface ChapterGenerationProgressPatch {
  phase?: string;
  phaseMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  timeoutMs?: number;
  deadlineMs?: number;
}

interface ChapterGenerationProgressReporter {
  updateProgress?: (patch: ChapterGenerationProgressPatch) => Promise<void>;
  heartbeat?: (patch?: ChapterGenerationProgressPatch) => Promise<void>;
}

const GENERATE_CHAPTER_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const GENERATE_CHAPTER_LLM_RETRIES = 1;
const GENERATE_CHAPTER_LLM_PHASE_TIMEOUT_MS = GENERATE_CHAPTER_LLM_TIMEOUT_MS * (GENERATE_CHAPTER_LLM_RETRIES + 1) + 5_000;
const GENERATE_CHAPTER_MAX_TOKEN_FLOOR = 1_400;
const GENERATE_CHAPTER_MAX_TOKEN_CEILING = 12_000;
const GENERATE_CHAPTER_LENGTH_REPAIR_RETRIES = 0;
const PREVIOUS_CHAPTER_CONTEXT_TAKE = 2;
const PREVIOUS_CHAPTER_CONTEXT_CHAR_LIMIT = 2_200;
const GENERATED_DRAFT_WORD_COUNT_MIN_RATIO = 0.85;
const GENERATED_DRAFT_WORD_COUNT_MAX_RATIO = 1.3;
const GENERATED_DRAFT_WORD_COUNT_WARN_MIN_RATIO = 0.85;
const GENERATED_DRAFT_WORD_COUNT_WARN_MAX_RATIO = 1.15;

export interface OutlineDensityCheckResult {
  valid: boolean;
  gateMode: 'warning' | 'blocker';
  blockers: string[];
  warnings: string[];
  missing: string[];
  metrics: {
    outlineLength: number;
    actionBeatCount: number;
    clueCount: number;
    hasObjective: boolean;
    hasConflict: boolean;
    hasStoryUnit: boolean;
    hasIrreversibleConsequence: boolean;
  };
}

export interface GenerateChapterPreflightResult {
  valid: boolean;
  blockers: string[];
  warnings: string[];
  openIssueCount: number;
  openErrorCount: number;
  outlineQuality: OutlineDensityCheckResult;
  newEntityPolicy: NewEntityPolicyCheckResult;
  currentDraftVersionNo?: number;
}

export interface NewEntityPolicyCandidate {
  type: 'character' | 'location' | 'foreshadow';
  source: string;
  evidence: string;
}

export interface NewEntityPolicyCheckResult {
  valid: boolean;
  blockMode: boolean;
  blockers: string[];
  warnings: string[];
  candidates: NewEntityPolicyCandidate[];
  allowNewCharacters: boolean;
  allowNewLocations: boolean;
  allowNewForeshadows: boolean;
}

export interface ExecutionCardCoverageResult {
  warnings: string[];
  checked: {
    clueNames: string[];
    irreversibleConsequence?: string;
  };
  missing: {
    clueNames: string[];
    irreversibleConsequence?: string;
  };
}

export interface SceneCardCoverageResult {
  warnings: string[];
  checked: Array<{
    sourceTrace: SceneExecutionPlan['sourceTrace'];
    sceneNo: number | null;
    title: string;
    fields: Array<{ field: string; value: string }>;
    relatedForeshadowIds: string[];
  }>;
  missing: Array<{
    sourceTrace: SceneExecutionPlan['sourceTrace'];
    sceneNo: number | null;
    title: string;
    missingFields: Array<{ field: string; value: string }>;
    relatedForeshadowIds: string[];
  }>;
}

export interface GeneratedDraftQualityGateResult {
  valid: boolean;
  blocked: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
  executionCardCoverage?: ExecutionCardCoverageResult;
  sceneCardCoverage?: SceneCardCoverageResult;
  metrics: {
    actualWordCount: number;
    targetWordCount: number;
    targetRatio: number;
    paragraphCount: number;
    duplicateParagraphCount: number;
    duplicateParagraphRatio: number;
    hasWrapperOrMarkdown: boolean;
    hasRefusalPattern: boolean;
    hasTemplateMarker: boolean;
    aiTasteHitCount: number;
    aiTasteHits: string[];
    simileCount: number;
    ornamentalParagraphCount: number;
    hasScenicOpeningRisk: boolean;
  };
}

interface AiTasteCheckResult {
  warnings: string[];
  hitCount: number;
  hits: string[];
  simileCount: number;
  ornamentalParagraphCount: number;
  hasScenicOpeningRisk: boolean;
}

export interface GenerateChapterResult {
  draftId: string;
  chapterId: string;
  versionNo: number;
  actualWordCount: number;
  summary: string;
  retrievalPayload: Record<string, unknown>;
  preflight: GenerateChapterPreflightResult;
  qualityGate: GeneratedDraftQualityGateResult;
  promptDebug: Record<string, unknown>;
  modelInfo: Record<string, unknown>;
  rewriteCleanup?: ChapterRewriteCleanupResult;
}

interface TimelinePlanningEventRow {
  id: string;
  projectId: string;
  chapterId: string | null;
  chapterNo: number | null;
  title: string;
  eventTime: string | null;
  locationName: string | null;
  participants: Prisma.JsonValue;
  cause: string | null;
  result: string | null;
  impactScope: string | null;
  isPublic: boolean;
  knownBy: Prisma.JsonValue;
  unknownBy: Prisma.JsonValue;
  eventStatus: string;
  sourceType: string;
  metadata: Prisma.JsonValue;
  updatedAt?: Date;
}

/**
 * API 内章节生成主链路，迁移 Worker GenerateChapterPipeline 的 PromptBuilder/Retrieval/LLM/草稿写入核心能力。
 * 输入章节和写作参数；输出草稿元数据；副作用是创建 ChapterDraft 并更新章节状态与字数。
 */
@Injectable()
export class GenerateChapterService {
  private readonly logger = new StructuredLogger(GenerateChapterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmGatewayService,
    private readonly retrieval: RetrievalService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly retrievalPlanner: RetrievalPlannerService,
    private readonly validation: ValidationService,
    private readonly cacheService?: NovelCacheService,
    private readonly rewriteCleanup?: ChapterRewriteCleanupService,
  ) {}

  /** 同步生成章节正文，并把生成上下文、召回结果和模型信息记录到草稿元数据。 */
  async run(projectId: string, chapterId: string, input: GenerateChapterInput = {}): Promise<GenerateChapterResult> {
    const runStartedAt = Date.now();
    const logContext = { requestId: input.requestId, jobId: input.jobId, projectId, chapterId };
    await input.progress?.updateProgress?.({ phase: 'preparing_context', phaseMessage: '正在读取章节与项目上下文' });
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, include: { project: { include: { creativeProfile: true, generationProfile: true } }, volume: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const generationProfile = buildGenerationProfileSnapshot(chapter.project.generationProfile);
    const targetWordCount = this.resolveTargetWordCount(input, chapter, generationProfile);
    if (targetWordCount < 200) throw new BadRequestException('章节目标字数不能低于 200。');

    const rewriteCleanup = input.mode === 'rewrite' ? await this.resetChapterForRewrite(projectId, chapterId) : undefined;
    const latest = await this.prisma.chapterDraft.findFirst({ where: { chapterId }, orderBy: { versionNo: 'desc' } });
    await input.progress?.heartbeat?.({ phase: 'preflight', phaseMessage: '正在进行章节生成前检查' });
    const preflight = await this.runPreflight(projectId, chapter, latest?.versionNo, input, generationProfile);
    if (input.validateBeforeWrite !== false && !preflight.valid) {
      throw new BadRequestException(`生成前检查未通过：${preflight.blockers.join('；')}`);
    }

    await input.progress?.heartbeat?.({ phase: 'retrieving_context', phaseMessage: '正在召回章节写作上下文' });
    const [styleProfile, characters, plannedForeshadows, sceneCards, plannedTimelineEvents, previousChapters] = await Promise.all([
      this.loadStyleProfile(projectId, chapter.project.defaultStyleProfileId),
      this.prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 20 }),
      this.prisma.foreshadowTrack.findMany({
        where: {
          projectId,
          status: { in: ['planned', 'planted', 'triggered'] },
          OR: [
            { chapterId },
            { firstSeenChapterNo: { lte: chapter.chapterNo }, lastSeenChapterNo: { gte: chapter.chapterNo } },
            { firstSeenChapterNo: { lte: chapter.chapterNo }, lastSeenChapterNo: null },
            { firstSeenChapterNo: null, lastSeenChapterNo: null, scope: { in: ['book', 'cross_volume', 'volume'] } },
          ],
          NOT: {
            AND: [
              { chapterId },
              { source: 'auto_extracted' },
            ],
          },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        take: 12,
      }),
      this.loadSceneCardsForChapter(projectId, chapter.id, chapter.chapterNo),
      this.loadPlannedTimelineEventsForChapter(projectId, chapter.id, chapter.chapterNo),
      this.loadPreviousChapters(projectId, chapter.chapterNo),
    ]);

    const hardFacts = this.buildHardFacts(chapter, characters, styleProfile);
    const queryText = input.instruction || chapter.objective;
    const includeLorebook = input.includeLorebook ?? true;
    const includeMemory = input.includeMemory ?? true;
    const retrievalPlanResult = await this.retrievalPlanner.createPlan({
      project: { id: chapter.project.id, title: chapter.project.title, genre: chapter.project.genre, tone: chapter.project.tone, synopsis: chapter.project.synopsis, outline: chapter.project.outline },
      volume: chapter.volume ? { volumeNo: chapter.volume.volumeNo, title: chapter.volume.title, objective: chapter.volume.objective, synopsis: chapter.volume.synopsis } : null,
      chapter: { chapterNo: chapter.chapterNo, title: chapter.title, objective: chapter.objective, conflict: chapter.conflict, outline: chapter.outline, revealPoints: chapter.revealPoints, foreshadowPlan: chapter.foreshadowPlan },
      characters: characters.map((item) => ({ name: item.name, roleType: item.roleType, personalityCore: item.personalityCore, motivation: item.motivation })),
      previousChapters,
      userInstruction: input.instruction,
      requestId: input.requestId,
      jobId: input.jobId,
    });
    const retrievalStartedAt = Date.now();
    const retrievalBundle = await this.retrieval.retrieveBundleWithCacheMeta(
      projectId,
      {
        queryText: this.buildPlannerAwareQueryText(queryText, retrievalPlanResult.plan),
        objective: chapter.objective,
        conflict: chapter.conflict,
        characters: this.mergeCharactersForRetrieval(characters.map((item) => item.name), retrievalPlanResult.plan.entities.characters),
        chapterId,
        chapterNo: chapter.chapterNo,
        excludeCurrentChapter: true,
        requestId: input.requestId,
        jobId: input.jobId,
        plannerQueries: {
          lorebook: retrievalPlanResult.plan.lorebookQueries,
          memory: retrievalPlanResult.plan.memoryQueries,
          relationship: retrievalPlanResult.plan.relationshipQueries,
          timeline: retrievalPlanResult.plan.timelineQueries,
          writingRule: retrievalPlanResult.plan.writingRuleQueries,
          foreshadow: retrievalPlanResult.plan.foreshadowQueries,
        },
      },
      { includeLorebook, includeMemory },
    );
    this.logger.log('generation.retrieval.completed', {
      ...logContext,
      stage: 'retrieving_context',
      queryText: this.truncateForLog(queryText, 500),
      includeLorebook,
      includeMemory,
      lorebookHitCount: retrievalBundle.lorebookHits.length,
      memoryHitCount: retrievalBundle.memoryHits.length,
      structuredHitCount: retrievalBundle.structuredHits.length,
      rankedHitCount: retrievalBundle.rankedHits.length,
      retrievalPlanner: retrievalPlanResult.diagnostics,
      retrievalCache: retrievalBundle.cache,
      diagnostics: retrievalBundle.diagnostics,
      elapsedMs: Date.now() - retrievalStartedAt,
    });
    if (retrievalBundle.diagnostics.qualityStatus === 'blocked') {
      throw new BadRequestException(`召回质量不足，已阻断生成：${retrievalBundle.diagnostics.warnings.join('；')}`);
    }
    const contextPack = this.buildContextPack({
      chapter,
      input,
      queryText,
      includeLorebook,
      includeMemory,
      retrievalBundle,
      retrievalPlan: retrievalPlanResult.plan,
      plannerDiagnostics: retrievalPlanResult.diagnostics,
      generationProfile,
      sceneCards: this.buildSceneExecutionPlans(sceneCards, chapter),
      plannedTimelineEvents: this.buildPlannedTimelineEvents(plannedTimelineEvents, chapter),
    });

    const prompt = await this.promptBuilder.buildChapterPrompt({
      project: { id: chapter.project.id, title: chapter.project.title, genre: chapter.project.genre, tone: chapter.project.tone, synopsis: chapter.project.synopsis, outline: chapter.project.outline },
      volume: chapter.volume ? { volumeNo: chapter.volume.volumeNo, title: chapter.volume.title, objective: chapter.volume.objective, synopsis: chapter.volume.synopsis, narrativePlan: chapter.volume.narrativePlan } : null,
      styleProfile,
      chapter: { chapterNo: chapter.chapterNo, title: chapter.title, objective: chapter.objective, conflict: chapter.conflict, outline: chapter.outline, craftBrief: chapter.craftBrief, revealPoints: chapter.revealPoints, foreshadowPlan: chapter.foreshadowPlan, expectedWordCount: chapter.expectedWordCount },
      characters: characters.map((item) => ({ name: item.name, roleType: item.roleType, personalityCore: item.personalityCore, motivation: item.motivation, speechStyle: item.speechStyle })),
      plannedForeshadows: plannedForeshadows.map((item) => ({ title: item.title, detail: item.detail, status: item.status, scope: item.scope, firstSeenChapterNo: item.firstSeenChapterNo, lastSeenChapterNo: item.lastSeenChapterNo })),
      previousChapters,
      hardFacts,
      contextPack,
      generationProfile,
      targetWordCount,
    });

    const llmStartedAt = Date.now();
    await input.progress?.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成章节正文',
      progressCurrent: 0,
      progressTotal: 1,
      timeoutMs: GENERATE_CHAPTER_LLM_PHASE_TIMEOUT_MS,
    });
    let llmResult = await this.llm.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { appStep: 'generate', maxTokens: this.estimateGenerateMaxTokens(targetWordCount), timeoutMs: GENERATE_CHAPTER_LLM_TIMEOUT_MS, retries: GENERATE_CHAPTER_LLM_RETRIES, temperature: 0.45 },
    );
    this.logger.log('generation.llm.completed', { ...logContext, stage: 'generating_draft', model: llmResult.model, tokenUsage: llmResult.usage, elapsedMs: Date.now() - llmStartedAt });
    if (this.isLengthFinishReason(llmResult.rawPayloadSummary.finishReason)) {
      throw new BadRequestException('write_chapter LLM 输出被提供商截断，未写入章节正文；请重试或检查模型输出上限配置。');
    }
    let content = this.stripWrapperTags(llmResult.text);
    if (!content) throw new BadRequestException('write_chapter 生成正文为空');

    let actualWordCount = this.countChineseLikeWords(content);
    await input.progress?.heartbeat?.({ phase: 'validating', phaseMessage: '正在校验生成章节质量', progressCurrent: 1, progressTotal: 1 });
    let qualityGate = this.assessGeneratedDraftQuality(content, actualWordCount, targetWordCount, chapter, contextPack.planningContext?.sceneCards ?? []);
    let lengthRepair: Record<string, unknown> | undefined;
    if (qualityGate.blocked && this.canRepairGeneratedDraftLength(qualityGate)) {
      await input.progress?.heartbeat?.({ phase: 'validating', phaseMessage: '正在重写字数失衡的章节正文', progressCurrent: 1, progressTotal: 1 });
      const repair = await this.repairGeneratedDraftLength({
        content,
        targetWordCount,
        chapter,
        sceneCards: contextPack.planningContext?.sceneCards ?? [],
        blockers: qualityGate.blockers,
      });
      lengthRepair = {
        initialActualWordCount: actualWordCount,
        initialTargetRatio: qualityGate.metrics.targetRatio,
        blockers: qualityGate.blockers,
        repairedActualWordCount: repair.actualWordCount,
        repairedTargetRatio: repair.qualityGate.metrics.targetRatio,
        model: repair.result.model,
        usage: repair.result.usage,
        rawPayloadSummary: repair.result.rawPayloadSummary,
      };
      llmResult = repair.result;
      content = repair.content;
      actualWordCount = repair.actualWordCount;
      qualityGate = repair.qualityGate;
    }
    if (qualityGate.blocked) {
      throw new BadRequestException(`生成后质量门禁未通过：${qualityGate.blockers.join('；')}`);
    }
    const modelInfo = { model: llmResult.model, usage: llmResult.usage, rawPayloadSummary: llmResult.rawPayloadSummary, lengthRepair };
    const retrievalPayload = { contextPack, generationProfile, retrievalPlan: retrievalPlanResult.plan, plannerDiagnostics: retrievalPlanResult.diagnostics, retrievalCache: retrievalBundle.cache, lorebookHits: retrievalBundle.lorebookHits, memoryHits: retrievalBundle.memoryHits, structuredHits: retrievalBundle.structuredHits, rankedHits: retrievalBundle.rankedHits, diagnostics: retrievalBundle.diagnostics, preflight, qualityGate, rewriteCleanup };

    await input.progress?.updateProgress?.({ phase: 'persisting', phaseMessage: '正在写入章节草稿与质量报告', progressCurrent: 0, progressTotal: 1, timeoutMs: 60_000 });
    const draft = await this.prisma.$transaction(async (tx) => {
      // 版本号必须在事务内重新读取，避免并发生成同一章节时用到过期 latest 导致版本冲突。
      const latestInTransaction = await tx.chapterDraft.findFirst({ where: { chapterId }, orderBy: { versionNo: 'desc' } });
      await tx.chapterDraft.updateMany({ where: { chapterId, isCurrent: true }, data: { isCurrent: false } });
      const created = await tx.chapterDraft.create({
        data: {
          chapterId,
          versionNo: (latestInTransaction?.versionNo ?? 0) + 1,
          content,
          source: 'agent_generate_service',
          modelInfo: modelInfo as Prisma.InputJsonValue,
          generationContext: { agentRunId: input.agentRunId, mode: input.mode ?? 'draft', instruction: input.instruction, targetWordCount, generationProfile, preflight, qualityGate, promptDebug: prompt.debug, retrievalPayload, rewriteCleanup } as unknown as Prisma.InputJsonValue,
          isCurrent: true,
          createdBy: input.userId,
        },
      });
      await tx.qualityReport.create({
        data: this.buildGenerationQualityReportData({
          projectId,
          chapterId,
          draftId: created.id,
          agentRunId: input.agentRunId,
          qualityGate,
          actualWordCount,
          targetWordCount,
          summary: content.slice(0, 160),
          modelInfo,
        }),
      });
      await tx.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount } });
      return created;
    });
    await this.cacheService?.deleteProjectRecallResults(projectId);
    await input.progress?.heartbeat?.({ phase: 'persisting', phaseMessage: '章节草稿写入完成', progressCurrent: 1, progressTotal: 1 });
    this.logger.log('generation.draft.persisted', { ...logContext, stage: 'draft_persisted', draftId: draft.id, versionNo: draft.versionNo, actualWordCount, model: llmResult.model, tokenUsage: llmResult.usage, elapsedMs: Date.now() - runStartedAt });

    return { draftId: draft.id, chapterId, versionNo: draft.versionNo, actualWordCount, summary: content.slice(0, 160), retrievalPayload, preflight, qualityGate, promptDebug: prompt.debug, modelInfo, rewriteCleanup };
  }

  async loadGenerationProfileSnapshot(projectId: string): Promise<GenerationProfileSnapshot> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { generationProfile: true },
    });
    if (!project) throw new NotFoundException(`项目不存在：${projectId}`);
    return buildGenerationProfileSnapshot(project.generationProfile);
  }

  private async resetChapterForRewrite(projectId: string, chapterId: string): Promise<ChapterRewriteCleanupResult> {
    if (!this.rewriteCleanup) {
      throw new BadRequestException('rewrite mode requires ChapterRewriteCleanupService.');
    }
    return this.rewriteCleanup.cleanupChapter(projectId, chapterId);
  }

  /**
   * 将写作上下文显式分层：verifiedContext 可进入 Prompt，userIntent 作为本章要求进入 Prompt，retrievalDiagnostics 只进日志/元数据。
   * 这样可以防止未来 LLM Retrieval Planner 的未命中查询被误当作既有事实注入正文。
   */
  private buildContextPack(input: {
    chapter: { objective: string | null; conflict: string | null; outline: string | null };
    input: GenerateChapterInput;
    queryText?: string | null;
    includeLorebook: boolean;
    includeMemory: boolean;
    retrievalBundle: RetrievalBundle | RetrievalBundleWithCacheMeta;
    retrievalPlan: RetrievalPlan;
    plannerDiagnostics: RetrievalPlannerDiagnostics;
    generationProfile: GenerationProfileSnapshot;
    sceneCards?: SceneExecutionPlan[];
    plannedTimelineEvents?: PlannedTimelineEvent[];
  }): ChapterContextPack {
    return {
      schemaVersion: 1,
      verifiedContext: {
        lorebookHits: input.retrievalBundle.lorebookHits,
        memoryHits: input.retrievalBundle.memoryHits,
        structuredHits: input.retrievalBundle.structuredHits,
      },
      planningContext: {
        sceneCards: input.sceneCards ?? [],
        plannedTimelineEvents: input.plannedTimelineEvents ?? [],
      },
      userIntent: {
        instruction: input.input.instruction?.trim() || undefined,
        chapterObjective: input.chapter.objective,
        chapterConflict: input.chapter.conflict,
        chapterOutline: input.chapter.outline,
      },
      generationProfile: input.generationProfile,
      retrievalDiagnostics: {
        queryText: input.queryText,
        includeLorebook: input.includeLorebook,
        includeMemory: input.includeMemory,
        diagnostics: input.retrievalBundle.diagnostics,
        retrievalPlan: input.retrievalPlan as unknown as Record<string, unknown>,
        plannerDiagnostics: input.plannerDiagnostics as unknown as Record<string, unknown>,
      },
    };
  }

  private buildPlannerAwareQueryText(baseQuery: string | null | undefined, plan: RetrievalPlan): string {
    const plannerQueries = [
      ...plan.lorebookQueries,
      ...plan.memoryQueries,
      ...plan.relationshipQueries,
      ...plan.timelineQueries,
      ...plan.writingRuleQueries,
      ...plan.foreshadowQueries,
    ].map((item) => item.query);
    return [baseQuery, ...plan.chapterTasks, ...plannerQueries, ...plan.constraints].filter(Boolean).join('\n').slice(0, 4000);
  }

  private mergeCharactersForRetrieval(projectCharacters: string[], plannedCharacters: string[]): string[] {
    return [...new Set([...projectCharacters, ...plannedCharacters].filter(Boolean))].slice(0, 30);
  }

  private resolveTargetWordCount(
    input: GenerateChapterInput,
    chapter: { expectedWordCount: number | null; project: { creativeProfile?: { chapterWordCount: number | null } | null } },
    generationProfile: GenerationProfileSnapshot,
  ): number {
    return input.wordCount ?? chapter.expectedWordCount ?? chapter.project.creativeProfile?.chapterWordCount ?? generationProfile.defaultChapterWordCount ?? 3500;
  }

  private estimateGenerateMaxTokens(targetWordCount: number): number {
    const normalizedTarget = Number.isFinite(targetWordCount) && targetWordCount > 0 ? targetWordCount : 3500;
    const fullChapterTokenFloor = normalizedTarget >= 2800 ? 6_500 : GENERATE_CHAPTER_MAX_TOKEN_FLOOR;
    const estimated =
      normalizedTarget >= 1_000
        ? Math.ceil(normalizedTarget * 1.85 + 1_300)
        : Math.ceil(normalizedTarget * 1.6 + 800);
    return Math.min(GENERATE_CHAPTER_MAX_TOKEN_CEILING, Math.max(fullChapterTokenFloor, estimated));
  }

  private canRepairGeneratedDraftLength(qualityGate: GeneratedDraftQualityGateResult): boolean {
    return qualityGate.blocked && qualityGate.blockers.length > 0 && qualityGate.blockers.every((message) => message.startsWith('正文长度'));
  }

  private async repairGeneratedDraftLength(input: {
    content: string;
    targetWordCount: number;
    chapter: { chapterNo: number; title: string | null; outline: string | null; craftBrief?: Prisma.JsonValue | null };
    sceneCards: SceneExecutionPlan[];
    blockers: string[];
  }): Promise<{ result: LlmChatResult; content: string; actualWordCount: number; qualityGate: GeneratedDraftQualityGateResult }> {
    const hardMin = Math.round(input.targetWordCount * GENERATED_DRAFT_WORD_COUNT_MIN_RATIO);
    const hardMax = Math.round(input.targetWordCount * GENERATED_DRAFT_WORD_COUNT_MAX_RATIO);
    const preferredMin = Math.round(input.targetWordCount * 0.94);
    const preferredMax = Math.round(input.targetWordCount * 1.12);
    const result = await this.llm.chat(
      [
        {
          role: 'system',
          content: [
            '你是长篇小说章节正文修订器。',
            '任务：只在不改变剧情事实、人物关系、时间线、叙事视角、关键结果和已给线索的前提下，重写一版字数合格的完整章节正文。',
            '严禁输出标题、摘要、解释、Markdown、检查清单或标签；只输出正文。',
            '不得用提纲、占位、跳写或“略写”替代完整正文。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `第${input.chapter.chapterNo}章「${input.chapter.title || '未命名'}」上一版不能写入，因为：${input.blockers.join('；')}。`,
            `目标字数：${input.targetWordCount} 字；硬性可接受范围：${hardMin}-${hardMax} 字；优先范围：${preferredMin}-${preferredMax} 字。`,
            '修订策略：只保留本章 3 个主场景；压缩背景解释、重复心理、额外争执、复述前文和环境铺陈；如果原文过短，则只补足场景中的可见动作、阻力、转折和结果。',
            '必须保持章节细纲、Chapter.craftBrief、角色关系、时间线、伏笔和结局不变，不新增无审批的重要长期角色或主线设定。',
            '下面是需要修订的上一版正文。请直接输出修订后的完整正文：',
            input.content,
          ].join('\n\n'),
        },
      ],
      {
        appStep: 'generate.length_repair',
        maxTokens: this.estimateGenerateMaxTokens(input.targetWordCount),
        timeoutMs: GENERATE_CHAPTER_LLM_TIMEOUT_MS,
        retries: GENERATE_CHAPTER_LENGTH_REPAIR_RETRIES,
        temperature: 0.25,
      },
    );
    if (this.isLengthFinishReason(result.rawPayloadSummary.finishReason)) {
      throw new BadRequestException('write_chapter 字数修订输出被提供商截断，未写入章节正文；请重试或检查模型输出上限配置。');
    }
    const content = this.stripWrapperTags(result.text);
    if (!content) throw new BadRequestException('write_chapter 字数修订正文为空');
    const actualWordCount = this.countChineseLikeWords(content);
    const qualityGate = this.assessGeneratedDraftQuality(content, actualWordCount, input.targetWordCount, input.chapter, input.sceneCards);
    return { result, content, actualWordCount, qualityGate };
  }

  private buildGenerationQualityReportData(input: {
    projectId: string;
    chapterId: string;
    draftId: string;
    agentRunId?: string;
    qualityGate: GeneratedDraftQualityGateResult;
    actualWordCount: number;
    targetWordCount: number;
    summary: string;
    modelInfo: Record<string, unknown>;
  }): Prisma.QualityReportUncheckedCreateInput {
    const issues = [
      ...input.qualityGate.blockers.map((message) => ({
        severity: 'error',
        issueType: 'generation_quality_gate_blocker',
        message,
      })),
      ...input.qualityGate.warnings.map((message) => ({
        severity: 'warning',
        issueType: 'generation_quality_gate_warning',
        message,
      })),
    ];
    const verdict = input.qualityGate.blocked ? 'fail' : issues.length > 0 ? 'warn' : 'pass';

    return {
      projectId: input.projectId,
      chapterId: input.chapterId,
      draftId: input.draftId,
      agentRunId: this.uuidOrUndefined(input.agentRunId),
      sourceType: 'generation',
      sourceId: input.draftId,
      reportType: 'generation_quality_gate',
      scores: {
        overall: input.qualityGate.score,
        actualWordCount: input.actualWordCount,
        targetWordCount: input.targetWordCount,
        targetRatio: input.qualityGate.metrics.targetRatio,
        duplicateParagraphRatio: input.qualityGate.metrics.duplicateParagraphRatio,
      } as Prisma.InputJsonValue,
      issues: issues as Prisma.InputJsonValue,
      verdict,
      summary: input.qualityGate.blocked
        ? `Generation quality gate failed with score ${input.qualityGate.score}.`
        : `Generation quality gate ${verdict} with score ${input.qualityGate.score}.`,
      metadata: {
        qualityGate: input.qualityGate,
        modelInfo: input.modelInfo,
        summary: input.summary,
        agentRunId: input.agentRunId,
      } as unknown as Prisma.InputJsonValue,
    };
  }

  /**
   * 生成后质量门禁：阻断明显异常输出，警告低质量但可人工复核的草稿。
   * 该检查只基于确定性文本特征，避免为了“评估”再次调用 LLM 造成额外成本和不稳定性。
   */
  private assessGeneratedDraftQuality(
    content: string,
    actualWordCount: number,
    targetWordCount: number,
    chapter?: { outline: string | null; craftBrief?: Prisma.JsonValue | null },
    sceneCards: SceneExecutionPlan[] = [],
  ): GeneratedDraftQualityGateResult {
    const paragraphs = content
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const normalizedParagraphs = paragraphs.map((item) => item.replace(/\s+/g, '')).filter((item) => item.length >= 24);
    const seen = new Set<string>();
    let duplicateParagraphCount = 0;
    for (const paragraph of normalizedParagraphs) {
      if (seen.has(paragraph)) duplicateParagraphCount += 1;
      seen.add(paragraph);
    }

    const targetRatio = targetWordCount > 0 ? actualWordCount / targetWordCount : 1;
    const duplicateParagraphRatio = normalizedParagraphs.length ? duplicateParagraphCount / normalizedParagraphs.length : 0;
    const hasWrapperOrMarkdown = /```|^#{1,6}\s|<\/?(?:rewrite|chapter|正文)>/im.test(content);
    const hasRefusalPattern = /作为(?:一个)?AI|我无法|不能完成(?:该|这个)?请求|以下是(?:你要的)?章节|当然可以/im.test(content);
    const hasTemplateMarker = /{{[^}]+}}|\[[^\]]*(?:待补充|TODO|占位)[^\]]*\]|TODO|待补充/im.test(content);
    const aiTaste = this.assessAiTaste(content, paragraphs);
    const belowProductionFloor = actualWordCount < Math.min(500, Math.max(120, targetWordCount * 0.18));
    const belowTargetRange = targetRatio < GENERATED_DRAFT_WORD_COUNT_MIN_RATIO;
    const aboveTargetRange = targetRatio > GENERATED_DRAFT_WORD_COUNT_MAX_RATIO;

    const blockers = [
      ...(belowProductionFloor ? [`正文过短：${actualWordCount} 字，低于生产写入下限。`] : []),
      ...(belowTargetRange ? [`正文长度仅达到目标的 ${(targetRatio * 100).toFixed(0)}%，低于允许下限 ${Math.round(GENERATED_DRAFT_WORD_COUNT_MIN_RATIO * 100)}%。`] : []),
      ...(aboveTargetRange ? [`正文长度达到目标的 ${(targetRatio * 100).toFixed(0)}%，超过允许上限 ${Math.round(GENERATED_DRAFT_WORD_COUNT_MAX_RATIO * 100)}%。`] : []),
      ...(hasRefusalPattern ? ['输出疑似包含模型拒答或说明性话术。'] : []),
      ...(duplicateParagraphRatio >= 0.35 && duplicateParagraphCount >= 3 ? ['重复段落比例过高，疑似生成退化。'] : []),
      ...(hasTemplateMarker ? ['输出包含模板占位符或待补充标记。'] : []),
    ];
    const warnings = [
      ...(!belowTargetRange && targetRatio < GENERATED_DRAFT_WORD_COUNT_WARN_MIN_RATIO ? [`正文长度仅达到目标的 ${(targetRatio * 100).toFixed(0)}%，建议人工复核或重试。`] : []),
      ...(!aboveTargetRange && targetRatio > GENERATED_DRAFT_WORD_COUNT_WARN_MAX_RATIO ? [`正文长度达到目标的 ${(targetRatio * 100).toFixed(0)}%，可能超出章节节奏。`] : []),
      ...(duplicateParagraphRatio >= 0.18 && duplicateParagraphRatio < 0.35 ? ['存在一定比例重复段落，建议检查节奏和表达。'] : []),
      ...(hasWrapperOrMarkdown ? ['输出包含 Markdown/包裹标签痕迹，后处理可能需要清理。'] : []),
      ...aiTaste.warnings,
    ];
    const executionCardCoverage = chapter ? this.assessExecutionCardCoverage(content, chapter) : undefined;
    if (executionCardCoverage?.warnings.length) {
      warnings.push(...executionCardCoverage.warnings);
    }
    const sceneCardCoverage = sceneCards.length ? this.assessSceneCardCoverage(content, sceneCards) : undefined;
    if (sceneCardCoverage?.warnings.length) {
      warnings.push(...sceneCardCoverage.warnings);
    }
    const aiTastePenalty = Math.min(20, aiTaste.hitCount * 3 + aiTaste.ornamentalParagraphCount * 4 + (aiTaste.hasScenicOpeningRisk ? 6 : 0));
    const score = Math.max(0, Math.min(100, 100 - blockers.length * 35 - warnings.length * 10 - Math.round(duplicateParagraphRatio * 40) - aiTastePenalty));

    return {
      valid: blockers.length === 0,
      blocked: blockers.length > 0,
      score,
      blockers,
      warnings,
      ...(executionCardCoverage && { executionCardCoverage }),
      ...(sceneCardCoverage && { sceneCardCoverage }),
      metrics: {
        actualWordCount,
        targetWordCount,
        targetRatio,
        paragraphCount: paragraphs.length,
        duplicateParagraphCount,
        duplicateParagraphRatio,
        hasWrapperOrMarkdown,
        hasRefusalPattern,
        hasTemplateMarker,
        aiTasteHitCount: aiTaste.hitCount,
        aiTasteHits: aiTaste.hits,
        simileCount: aiTaste.simileCount,
        ornamentalParagraphCount: aiTaste.ornamentalParagraphCount,
        hasScenicOpeningRisk: aiTaste.hasScenicOpeningRisk,
      },
    };
  }

  private assessAiTaste(content: string, paragraphs: string[]): AiTasteCheckResult {
    const hits = new Set<string>();
    const fatiguePatterns: Array<{ label: string; pattern: RegExp }> = [
      { label: '独立成段的戏剧化反转短句', pattern: /(?:^|\n)\s*(?:不是|并非).{1,10}[。！？!?]\s*(?=\n|$)/m },
      { label: '预告片式段尾或命运句', pattern: /(?:真正的风暴才刚刚开始|只是开始|再也回不去了|这一刻[，,].{0,12}终于明白|命运的齿轮)/ },
      { label: '高修辞比喻句', pattern: /(?:细如|宛如|如同|仿佛|像被.{0,8}(?:刀|火|冰|针)|像.{0,12}(?:刮过|碾过|吞没|压下))/ },
      { label: '空镜式天象开场', pattern: /^[\s\S]{0,220}(?:天上|天穹|云层|海面|潮腹|白沫|夜色|雨|雾)/ },
    ];
    for (const item of fatiguePatterns) {
      if (item.pattern.test(content)) hits.add(item.label);
    }

    const simileCount = content.match(/像|仿佛|似乎|好像|宛如|如同|细如/g)?.length ?? 0;
    const simileThreshold = Math.max(4, Math.floor(content.length / 1200));
    if (simileCount > simileThreshold) hits.add('比喻词密度偏高');

    const ornamentalParagraphCount = paragraphs.filter((paragraph) => {
      const sensoryCount = paragraph.match(/盐|潮|雾|海|雨|水|白|青|黑|光|声|响|味|臭|腥|铁锈|血|冷|热|湿|泥|风|烟|尘|疼|痛/g)?.length ?? 0;
      const paragraphSimiles = paragraph.match(/像|仿佛|似乎|好像|宛如|如同|细如/g)?.length ?? 0;
      return sensoryCount >= 5 && (paragraphSimiles >= 1 || paragraph.length > 90);
    }).length;
    if (ornamentalParagraphCount >= 2) hits.add('感官/修辞堆叠段落偏多');

    const opening = content.slice(0, 420);
    const hasSceneryOpening = /天上|天穹|云层|海面|潮腹|白沫|夜色|雨|雾|风声|潮声/.test(opening);
    const hasActionAnchor = /说|问|骂|吼|拽|推|抓|砍|拔|跑|走|退|递|抬头|低头|转身|伸手|撞|摔|跪|拉/.test(opening);
    const hasPressureAnchor = /必须|不能|来不及|赶|阻|拦|逃|救|杀|抢|封|追|押|锁|链|刀|伤|塌|断|裂/.test(opening);
    const hasScenicOpeningRisk = hasSceneryOpening && (!hasActionAnchor || !hasPressureAnchor);

    const warnings = [
      ...(hits.size ? [`疑似 AI 味表达：${[...hits].slice(0, 4).join('、')}。建议改成更朴素的动作后果和人物选择。`] : []),
      ...(hasScenicOpeningRisk ? ['开场环境/天象气氛偏重，人物目标或选择压力不够靠前。'] : []),
    ];

    return {
      warnings,
      hitCount: hits.size,
      hits: [...hits],
      simileCount,
      ornamentalParagraphCount,
      hasScenicOpeningRisk,
    };
  }

  private isLengthFinishReason(finishReason: unknown): boolean {
    const value = Array.isArray(finishReason) ? finishReason.join(' ') : String(finishReason ?? '');
    return /length|max[_ -]?tokens?|token[_ -]?limit/i.test(value);
  }

  /**
   * 生成前质量门禁：先检查章节目标、现有高危校验问题和覆盖风险。
   * validateBeforeWrite=false 可显式跳过阻断，但仍会把检查结果写入草稿上下文便于追踪。
   */
  private async runPreflight(
    projectId: string,
    chapter: { id: string; chapterNo: number; objective: string | null; conflict: string | null; outline: string | null; revealPoints?: string | null; foreshadowPlan?: string | null; craftBrief?: Prisma.JsonValue | null; status: string },
    currentDraftVersionNo: number | undefined,
    input: GenerateChapterInput,
    generationProfile: GenerationProfileSnapshot = buildGenerationProfileSnapshot(),
  ): Promise<GenerateChapterPreflightResult> {
    const openIssues = await this.validation.listByChapter(chapter.id);
    const openErrorCount = openIssues.filter((issue) => issue.severity === 'error').length;
    const outlineQuality = this.assessOutlineDensity(chapter, input);
    const newEntityPolicy = this.assessNewEntityPolicy(chapter, input, generationProfile);
    const blockers = [
      ...(!input.instruction?.trim() && !chapter.objective?.trim() && !chapter.outline?.trim() ? ['缺少章节目标/大纲/用户指令，无法构建稳定写作目标。'] : []),
      ...(openErrorCount > 0 ? [`当前章节存在 ${openErrorCount} 个未解决 error 级校验问题。`] : []),
      ...outlineQuality.blockers,
      ...newEntityPolicy.blockers,
    ];
    const warnings = [
      ...(currentDraftVersionNo ? [`当前已有 v${currentDraftVersionNo} 草稿，本次会创建新版本并设为当前版本。`] : []),
      ...(!chapter.conflict?.trim() ? ['章节冲突为空，生成张力可能不足。'] : []),
      ...(chapter.status === 'reviewed' ? ['章节已处于 reviewed 状态，请确认确实要生成新草稿。'] : []),
      ...(input.validateBeforeWrite === false ? ['调用方显式关闭生成前阻断，仅记录 preflight 结果。'] : []),
      ...outlineQuality.warnings,
      ...newEntityPolicy.warnings,
    ];
    return { valid: blockers.length === 0, blockers, warnings, openIssueCount: openIssues.length, openErrorCount, outlineQuality, newEntityPolicy, currentDraftVersionNo };
  }

  private assessOutlineDensity(
    chapter: { objective: string | null; conflict: string | null; outline: string | null; craftBrief?: Prisma.JsonValue | null },
    input: GenerateChapterInput,
  ): OutlineDensityCheckResult {
    const brief = this.asRecord(chapter.craftBrief);
    const outline = chapter.outline ?? '';
    const actionBeats = this.stringArray(brief?.actionBeats);
    const sceneBeatCount = this.asRecordArray(brief?.sceneBeats).length;
    const clueCount = this.asRecordArray(brief?.concreteClues).filter((item) => this.text(item.name)).length;
    const storyUnit = this.asRecord(brief?.storyUnit);
    const hasStructuredBrief = actionBeats.length > 0 || sceneBeatCount > 0 || clueCount > 0 || Boolean(this.text(brief?.irreversibleConsequence));
    const metrics = {
      outlineLength: outline.replace(/\s+/g, '').length,
      actionBeatCount: actionBeats.length,
      sceneBeatCount,
      clueCount,
      hasObjective: Boolean(chapter.objective?.trim() || this.text(brief?.visibleGoal)),
      hasConflict: Boolean(chapter.conflict?.trim() || this.text(brief?.coreConflict)),
      hasStoryUnit: Boolean(storyUnit && this.text(storyUnit.unitId) && this.text(storyUnit.chapterRole) && this.stringArray(storyUnit.serviceFunctions).length >= 3),
      hasIrreversibleConsequence: Boolean(this.text(brief?.irreversibleConsequence) || /不可逆后果|后果|代价/.test(outline)),
      hasChapterHandoff: Boolean(this.text(brief?.entryState) && this.text(brief?.exitState) && this.text(brief?.handoffToNextChapter)),
    };

    const missing = [
      ...(!metrics.hasObjective ? ['objective'] : []),
      ...(!metrics.hasConflict ? ['conflict'] : []),
      ...(metrics.outlineLength < 50 && !hasStructuredBrief ? ['outline_density'] : []),
      ...(actionBeats.length === 0 && !/行动链|关键行动|场景行动/.test(outline) ? ['action_beats'] : []),
      ...(!metrics.hasStoryUnit ? ['story_unit'] : []),
      ...(sceneBeatCount === 0 && !/场景链|场景段|入场状态|下一章交接/.test(outline) ? ['scene_beats'] : []),
      ...(clueCount === 0 && !/物证|线索|证据|道具/.test(outline) ? ['concrete_clues'] : []),
      ...(!metrics.hasIrreversibleConsequence ? ['irreversible_consequence'] : []),
      ...(!metrics.hasChapterHandoff ? ['chapter_handoff'] : []),
    ];
    const messages = missing.map((item) => {
      switch (item) {
        case 'objective': return '细纲缺少可检验的章节目标。';
        case 'conflict': return '细纲缺少明确冲突或阻力来源。';
        case 'outline_density': return '章节细纲过短，缺少可执行场景密度。';
        case 'action_beats': return '执行卡缺少行动链。';
        case 'story_unit': return '执行卡缺少单元故事 storyUnit，正文可能只推进主线而缺少阶段小故事。';
        case 'scene_beats': return '执行卡缺少场景链 sceneBeats，正文可能无法保持场面连续。';
        case 'concrete_clues': return '执行卡缺少物证/线索。';
        case 'irreversible_consequence': return '执行卡缺少不可逆后果。';
        case 'chapter_handoff': return '执行卡缺少入场状态、离场状态或下一章交接。';
        default: return `细纲缺少 ${item}。`;
      }
    });
    const gateMode = this.resolveOutlineQualityGateMode(input);
    const blockers = gateMode === 'blocker' ? messages : [];
    const warnings = gateMode === 'warning'
      ? messages
      : (messages.length ? [`细纲质量门禁已配置为 blocker：${messages.join('；')}`] : []);

    return { valid: blockers.length === 0, gateMode, blockers, warnings, missing, metrics };
  }

  private resolveOutlineQualityGateMode(input: GenerateChapterInput): 'warning' | 'blocker' {
    if (input.outlineQualityGate) return input.outlineQualityGate;
    return process.env.OUTLINE_QUALITY_GATE === 'blocker' ? 'blocker' : 'warning';
  }

  private assessNewEntityPolicy(
    chapter: { objective: string | null; conflict: string | null; outline: string | null; revealPoints?: string | null; foreshadowPlan?: string | null; craftBrief?: Prisma.JsonValue | null },
    input: GenerateChapterInput,
    generationProfile: GenerationProfileSnapshot,
  ): NewEntityPolicyCheckResult {
    const candidates = this.collectNewEntityCandidates(chapter, input);
    const blockedCandidates = candidates.filter((candidate) => {
      if (candidate.type === 'character') return !generationProfile.allowNewCharacters;
      if (candidate.type === 'location') return !generationProfile.allowNewLocations;
      return !generationProfile.allowNewForeshadows;
    });
    const blockMode = this.shouldBlockNewEntityPolicy(generationProfile);
    const messages = blockedCandidates.map((candidate) => (
      `生成配置禁止新增${this.newEntityLabel(candidate.type)}，但${candidate.source}包含疑似新增候选：${candidate.evidence}。`
      + '该检测仅作诊断提示，不因自然语言关键词阻断；请让写作 LLM 遵守生成配置。'
    ));

    return {
      valid: true,
      blockMode,
      blockers: [],
      warnings: messages,
      candidates,
      allowNewCharacters: generationProfile.allowNewCharacters,
      allowNewLocations: generationProfile.allowNewLocations,
      allowNewForeshadows: generationProfile.allowNewForeshadows,
    };
  }

  private collectNewEntityCandidates(
    chapter: { objective: string | null; conflict: string | null; outline: string | null; revealPoints?: string | null; foreshadowPlan?: string | null; craftBrief?: Prisma.JsonValue | null },
    input: GenerateChapterInput,
  ): NewEntityPolicyCandidate[] {
    // Natural-language mentions of "new role/location/clue" are diagnostics only; negation and scope require LLM judgment.
    const sources = [
      { source: '用户指令', value: input.instruction },
      { source: '章节目标', value: chapter.objective },
      { source: '章节冲突', value: chapter.conflict },
      { source: '章节大纲', value: chapter.outline },
      { source: '揭示点', value: chapter.revealPoints },
      { source: '伏笔计划', value: chapter.foreshadowPlan },
      { source: '执行卡', value: this.hasRecordContent(chapter.craftBrief) ? JSON.stringify(chapter.craftBrief) : '' },
    ];
    const patterns: Array<{ type: NewEntityPolicyCandidate['type']; pattern: RegExp }> = [
      { type: 'character', pattern: /(?:新增角色|新角色|新增人物|新人物|首次登场|首次出场|引入.{0,12}(?:角色|人物|配角|反派|敌人|同伴))/i },
      { type: 'location', pattern: /(?:新增地点|新地点|新增场景|新场景|新增地图|新地图|首次到达|进入新.{0,12}(?:地点|场景|城市|宗门|秘境|城镇|村镇))/i },
      { type: 'foreshadow', pattern: /(?:新增伏笔|新伏笔|埋下伏笔|埋设伏笔|新增线索|新线索|埋下线索|新增悬念|新悬念|新增暗线)/i },
    ];
    const candidates: NewEntityPolicyCandidate[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
      const value = source.value?.trim();
      if (!value) continue;
      for (const item of patterns) {
        const match = value.match(item.pattern);
        if (!match) continue;
        const evidence = this.truncateForLog(value.replace(/\s+/g, ' '), 180) ?? match[0];
        const key = `${item.type}:${source.source}:${evidence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ type: item.type, source: source.source, evidence });
      }
    }

    return candidates;
  }

  private shouldBlockNewEntityPolicy(generationProfile: GenerationProfileSnapshot): boolean {
    return generationProfile.preGenerationChecks.some((item) => {
      if (typeof item === 'string') {
        return /^(?:blockedNewEntities|blockNewEntities|newEntityPolicy:blocker)$/i.test(item.trim());
      }
      const record = this.asRecord(item);
      if (!record) return false;
      const key = String(record.key ?? record.id ?? record.type ?? record.name ?? '');
      const mode = String(record.mode ?? record.severity ?? record.level ?? '');
      return /new.?entit/i.test(key) && /block|error|阻断/.test(mode);
    });
  }

  private newEntityLabel(type: NewEntityPolicyCandidate['type']): string {
    if (type === 'character') return '角色';
    if (type === 'location') return '地点';
    return '伏笔';
  }

  private assessExecutionCardCoverage(
    content: string,
    chapter: { outline: string | null; craftBrief?: Prisma.JsonValue | null },
  ): ExecutionCardCoverageResult {
    const requirements = this.extractExecutionCardRequirements(chapter);
    const missingClueNames = requirements.clueNames.filter((name) => !this.includesLoose(content, name));
    const missingConsequence = requirements.irreversibleConsequence && !this.hasMeaningfulCoverage(content, requirements.irreversibleConsequence)
      ? requirements.irreversibleConsequence
      : undefined;
    const warnings = [
      ...(missingClueNames.length ? [`正文未覆盖执行卡关键物证/线索：${missingClueNames.join('、')}。`] : []),
      ...(missingConsequence ? ['正文未落地执行卡中的不可逆后果。'] : []),
    ];

    return {
      warnings,
      checked: {
        clueNames: requirements.clueNames,
        ...(requirements.irreversibleConsequence && { irreversibleConsequence: requirements.irreversibleConsequence }),
      },
      missing: {
        clueNames: missingClueNames,
        ...(missingConsequence && { irreversibleConsequence: missingConsequence }),
      },
    };
  }

  private extractExecutionCardRequirements(chapter: { outline: string | null; craftBrief?: Prisma.JsonValue | null }) {
    const brief = this.asRecord(chapter.craftBrief);
    const structuredClues = this.asRecordArray(brief?.concreteClues)
      .map((item) => this.text(item.name))
      .filter((item): item is string => Boolean(item));
    const markdownClues = structuredClues.length
      ? []
      : this.extractExecutionCardList(chapter.outline ?? '', '物证/线索')
        .map((line) => line.replace(/^名称[:：]\s*/, '').split(/[；;，,：:]/)[0]?.trim())
        .filter((item): item is string => Boolean(item));

    return {
      clueNames: [...new Set([...structuredClues, ...markdownClues])].slice(0, 8),
      irreversibleConsequence: this.text(brief?.irreversibleConsequence) ?? this.extractExecutionCardSection(chapter.outline ?? '', '不可逆后果'),
    };
  }

  private assessSceneCardCoverage(content: string, sceneCards: SceneExecutionPlan[]): SceneCardCoverageResult {
    const checked = sceneCards.map((scene) => ({
      sourceTrace: scene.sourceTrace,
      sceneNo: scene.sceneNo,
      title: scene.title,
      fields: this.sceneCardCoverageFields(scene),
      relatedForeshadowIds: scene.relatedForeshadowIds,
    }));
    const missing = checked
      .map((scene) => ({
        sourceTrace: scene.sourceTrace,
        sceneNo: scene.sceneNo,
        title: scene.title,
        missingFields: scene.fields.filter((field) => !this.hasMeaningfulCoverage(content, field.value)),
        relatedForeshadowIds: scene.relatedForeshadowIds,
      }))
      .filter((scene) => scene.missingFields.length > 0);
    const warnings = missing.length
      ? [`SceneCard coverage warning: ${missing.length} planned scene(s) have missing fields: ${missing.map((scene) => `${scene.sceneNo ?? '?'}:${scene.title}(${scene.missingFields.map((field) => field.field).join(',')})`).join('; ')}`]
      : [];

    return { warnings, checked, missing };
  }

  private sceneCardCoverageFields(scene: SceneExecutionPlan): Array<{ field: string; value: string }> {
    const fields = [
      { field: 'keyInformation', value: scene.keyInformation },
      { field: 'result', value: scene.result },
      { field: 'purpose', value: scene.purpose },
      { field: 'conflict', value: scene.conflict },
      { field: 'locationName', value: scene.locationName },
    ]
      .map((item) => ({ field: item.field, value: this.text(item.value) }))
      .filter((item): item is { field: string; value: string } => Boolean(item.value));

    return (fields.length ? fields : [{ field: 'title', value: scene.title }]).slice(0, 8);
  }

  private hasMeaningfulCoverage(content: string, requirement: string): boolean {
    if (this.includesLoose(content, requirement)) return true;
    return this.extractCoverageTerms(requirement).some((term) => this.includesLoose(content, term));
  }

  private includesLoose(content: string, needle: string): boolean {
    const normalizedContent = this.normalizeSearchText(content);
    const normalizedNeedle = this.normalizeSearchText(needle);
    return normalizedNeedle.length >= 2 && normalizedContent.includes(normalizedNeedle);
  }

  private extractCoverageTerms(value: string): string[] {
    return value
      .split(/[，。；;、,.!?！？\s]+/)
      .map((item) => this.normalizeSearchText(item))
      .filter((item) => item.length >= 4)
      .slice(0, 8);
  }

  private normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[\s"'“”‘’《》「」『』【】（）()，。；;、,.!?！？:：-]/g, '');
  }

  private extractExecutionCardSection(outline: string, label: string): string | undefined {
    if (!outline.includes(label)) return undefined;
    const labels = ['表层目标', '隐藏情绪', '核心冲突', '行动链', '物证/线索', '物证', '线索', '对话潜台词', '人物变化', '不可逆后果'];
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const otherLabels = labels
      .filter((item) => item !== label)
      .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const match = outline.match(new RegExp(`${escapedLabel}\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n\\s*(?:${otherLabels})\\s*[:：]|$)`, 'i'));
    return match?.[1]?.trim().replace(/^\s*[-\d.、]+\s*/gm, '').trim() || undefined;
  }

  private extractExecutionCardList(outline: string, label: string): string[] {
    const section = this.extractExecutionCardSection(outline, label);
    if (!section) return [];
    return section
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.、])\s*/, '').trim())
      .filter(Boolean);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private uuidOrUndefined(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : undefined;
  }

  private hasRecordContent(value: unknown): boolean {
    const record = this.asRecord(value);
    return Boolean(record && Object.keys(record).length > 0);
  }

  private async loadSceneCardsForChapter(projectId: string, chapterId: string, chapterNo: number) {
    return this.prisma.sceneCard.findMany({
      where: {
        projectId,
        chapterId,
        NOT: { status: 'archived' },
      },
      orderBy: [{ updatedAt: 'asc' }],
      take: 30,
    }).then((items) => items.map((item) => ({ ...item, chapterNo })));
  }

  private async loadPlannedTimelineEventsForChapter(projectId: string, chapterId: string, chapterNo: number): Promise<TimelinePlanningEventRow[]> {
    const client = (this.prisma as unknown as { timelineEvent?: { findMany(args: unknown): Promise<TimelinePlanningEventRow[]> } }).timelineEvent;
    if (!client) return [];
    const rows = await client.findMany({
      where: {
        projectId,
        eventStatus: 'planned',
        OR: [{ chapterId }, { chapterNo }],
      },
      orderBy: [{ eventTime: 'asc' }, { updatedAt: 'asc' }],
      take: 50,
    });
    return rows
      .filter((row) => row.projectId === projectId && row.eventStatus === 'planned' && (row.chapterId === chapterId || row.chapterNo === chapterNo))
      .slice(0, 30);
  }

  private buildPlannedTimelineEvents(events: TimelinePlanningEventRow[], chapter: { id: string; chapterNo: number }): PlannedTimelineEvent[] {
    return [...events].sort((left, right) => this.comparePlannedTimelineEvents(left, right)).slice(0, 12).map((event) => {
      const metadata = this.asRecord(event.metadata) ?? {};
      const storedSourceTrace = this.asRecord(metadata.sourceTrace);
      const sourceKind = this.text(storedSourceTrace?.sourceKind) ?? this.text(metadata.sourceKind);
      return {
        id: event.id,
        title: event.title,
        chapterId: event.chapterId ?? chapter.id,
        chapterNo: event.chapterNo ?? chapter.chapterNo,
        eventTime: event.eventTime,
        locationName: event.locationName,
        participants: this.stringArray(event.participants),
        cause: event.cause,
        result: event.result,
        impactScope: event.impactScope,
        isPublic: event.isPublic,
        knownBy: this.stringArray(event.knownBy),
        unknownBy: this.stringArray(event.unknownBy),
        eventStatus: event.eventStatus,
        sourceType: event.sourceType,
        metadata,
        sourceTrace: {
          sourceType: 'timeline_event',
          sourceId: event.id,
          projectId: event.projectId,
          chapterId: event.chapterId ?? chapter.id,
          chapterNo: event.chapterNo ?? chapter.chapterNo,
          eventStatus: event.eventStatus,
          ...(sourceKind ? { sourceKind } : {}),
        },
      };
    });
  }

  private comparePlannedTimelineEvents(left: TimelinePlanningEventRow, right: TimelinePlanningEventRow): number {
    const timeDelta = (left.eventTime ?? '').localeCompare(right.eventTime ?? '');
    if (timeDelta !== 0) return timeDelta;
    const updatedDelta = (left.updatedAt?.getTime() ?? 0) - (right.updatedAt?.getTime() ?? 0);
    return updatedDelta !== 0 ? updatedDelta : left.id.localeCompare(right.id);
  }

  private buildSceneExecutionPlans(
    sceneCards: Array<{
      id: string;
      projectId: string;
      volumeId: string | null;
      chapterId: string | null;
      chapterNo: number;
      sceneNo: number | null;
      title: string;
      locationName: string | null;
      participants: Prisma.JsonValue;
      purpose: string | null;
      conflict: string | null;
      emotionalTone: string | null;
      keyInformation: string | null;
      result: string | null;
      relatedForeshadowIds: Prisma.JsonValue;
      status: string;
      metadata: Prisma.JsonValue;
      updatedAt: Date;
    }>,
    chapter: { id: string; chapterNo: number },
  ): SceneExecutionPlan[] {
    return [...sceneCards].sort((left, right) => this.compareSceneCards(left, right)).slice(0, 12).map((scene) => ({
      id: scene.id,
      sceneNo: scene.sceneNo,
      title: scene.title,
      locationName: scene.locationName,
      participants: this.stringArray(scene.participants),
      purpose: scene.purpose,
      conflict: scene.conflict,
      emotionalTone: scene.emotionalTone,
      keyInformation: scene.keyInformation,
      result: scene.result,
      relatedForeshadowIds: this.stringArray(scene.relatedForeshadowIds),
      status: scene.status,
      metadata: this.asRecord(scene.metadata) ?? {},
      sourceTrace: {
        sourceType: 'scene_card',
        sourceId: scene.id,
        projectId: scene.projectId,
        volumeId: scene.volumeId,
        chapterId: scene.chapterId ?? chapter.id,
        chapterNo: chapter.chapterNo,
        sceneNo: scene.sceneNo,
      },
    }));
  }

  private compareSceneCards(
    left: { id: string; title: string; sceneNo: number | null; updatedAt?: Date },
    right: { id: string; title: string; sceneNo: number | null; updatedAt?: Date },
  ): number {
    if (left.sceneNo !== null && right.sceneNo !== null && left.sceneNo !== right.sceneNo) {
      return left.sceneNo - right.sceneNo;
    }
    if (left.sceneNo === null && right.sceneNo !== null) return 1;
    if (left.sceneNo !== null && right.sceneNo === null) return -1;
    const updatedDelta = (left.updatedAt?.getTime() ?? 0) - (right.updatedAt?.getTime() ?? 0);
    if (updatedDelta !== 0) return updatedDelta;
    const titleDelta = left.title.localeCompare(right.title);
    return titleDelta !== 0 ? titleDelta : left.id.localeCompare(right.id);
  }

  private async loadStyleProfile(projectId: string, defaultStyleProfileId?: string | null) {
    if (defaultStyleProfileId) {
      const style = await this.prisma.styleProfile.findFirst({ where: { id: defaultStyleProfileId, projectId } });
      if (style) return style;
    }
    return this.prisma.styleProfile.findFirst({ where: { projectId }, orderBy: { updatedAt: 'desc' } });
  }

  private async loadPreviousChapters(projectId: string, chapterNo: number) {
    const chapters = await this.prisma.chapter.findMany({
      where: { projectId, chapterNo: { lt: chapterNo } },
      orderBy: { chapterNo: 'desc' },
      take: PREVIOUS_CHAPTER_CONTEXT_TAKE,
      include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: 1 } },
    });
    return chapters
      .reverse()
      .map((item) => ({ chapterNo: item.chapterNo, title: item.title, content: this.extractPreviousChapterContext(item.drafts[0]?.content) }))
      .filter((item) => item.content);
  }

  private extractPreviousChapterContext(content: string | null | undefined): string {
    const text = content?.trim();
    if (!text) return '';
    if (text.length <= PREVIOUS_CHAPTER_CONTEXT_CHAR_LIMIT) return text;
    return `（前文仅保留结尾摘录，完整正文请依赖记忆召回与事实层校准。）\n${text.slice(-PREVIOUS_CHAPTER_CONTEXT_CHAR_LIMIT)}`;
  }

  private buildHardFacts(chapter: { conflict: string | null }, characters: Array<{ name: string }>, styleProfile?: { pov: string | null } | null): string[] {
    return [
      `POV 必须维持 ${styleProfile?.pov || '第三人称限制'} 视角。`,
      characters.length ? `当前项目已登记角色：${characters.slice(0, 8).map((item) => item.name).join('、')}。` : '',
      chapter.conflict ? `本章核心冲突：${chapter.conflict}` : '',
    ].filter(Boolean);
  }

  private stripWrapperTags(text: string): string {
    return text
      .trim()
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  private countChineseLikeWords(content: string): number {
    const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return cjk + words;
  }

  private truncateForLog(value: string | null | undefined, maxLength: number): string | undefined {
    if (!value) return undefined;
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }
}
