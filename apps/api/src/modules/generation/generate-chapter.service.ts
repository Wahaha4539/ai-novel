import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { RetrievalBundle, RetrievalBundleWithCacheMeta, RetrievalService } from '../memory/retrieval.service';
import { RetrievalPlan, RetrievalPlannerDiagnostics } from '../memory/retrieval-plan.types';
import { ValidationService } from '../validation/validation.service';
import { ChapterContextPack } from './context-pack.types';
import { PromptBuilderService } from './prompt-builder.service';
import { RetrievalPlannerService } from './retrieval-planner.service';

export interface GenerateChapterInput {
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
}

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
  currentDraftVersionNo?: number;
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

export interface GeneratedDraftQualityGateResult {
  valid: boolean;
  blocked: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
  executionCardCoverage?: ExecutionCardCoverageResult;
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
  };
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
  ) {}

  /** 同步生成章节正文，并把生成上下文、召回结果和模型信息记录到草稿元数据。 */
  async run(projectId: string, chapterId: string, input: GenerateChapterInput = {}): Promise<GenerateChapterResult> {
    const runStartedAt = Date.now();
    const logContext = { requestId: input.requestId, jobId: input.jobId, projectId, chapterId };
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, include: { project: { include: { creativeProfile: true } }, volume: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const targetWordCount = input.wordCount ?? chapter.expectedWordCount ?? chapter.project.creativeProfile?.chapterWordCount ?? 3500;
    if (targetWordCount < 200) throw new BadRequestException('章节目标字数不能低于 200。');

    const latest = await this.prisma.chapterDraft.findFirst({ where: { chapterId }, orderBy: { versionNo: 'desc' } });
    const preflight = await this.runPreflight(projectId, chapter, latest?.versionNo, input);
    if (input.validateBeforeWrite !== false && !preflight.valid) {
      throw new BadRequestException(`生成前检查未通过：${preflight.blockers.join('；')}`);
    }

    const [styleProfile, characters, plannedForeshadows, previousChapters] = await Promise.all([
      this.loadStyleProfile(projectId, chapter.project.defaultStyleProfileId),
      this.prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 20 }),
      this.prisma.foreshadowTrack.findMany({
        where: { projectId, OR: [{ chapterId }, { firstSeenChapterNo: { lte: chapter.chapterNo }, lastSeenChapterNo: { gte: chapter.chapterNo } }] },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        take: 12,
      }),
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
    const contextPack = this.buildContextPack({ chapter, input, queryText, includeLorebook, includeMemory, retrievalBundle, retrievalPlan: retrievalPlanResult.plan, plannerDiagnostics: retrievalPlanResult.diagnostics });

    const prompt = await this.promptBuilder.buildChapterPrompt({
      project: { id: chapter.project.id, title: chapter.project.title, genre: chapter.project.genre, tone: chapter.project.tone, synopsis: chapter.project.synopsis, outline: chapter.project.outline },
      volume: chapter.volume ? { volumeNo: chapter.volume.volumeNo, title: chapter.volume.title, objective: chapter.volume.objective, synopsis: chapter.volume.synopsis, narrativePlan: chapter.volume.narrativePlan } : null,
      styleProfile,
      chapter: { chapterNo: chapter.chapterNo, title: chapter.title, objective: chapter.objective, conflict: chapter.conflict, outline: chapter.outline, craftBrief: chapter.craftBrief, revealPoints: chapter.revealPoints, foreshadowPlan: chapter.foreshadowPlan, expectedWordCount: chapter.expectedWordCount },
      characters: characters.map((item) => ({ name: item.name, roleType: item.roleType, personalityCore: item.personalityCore, motivation: item.motivation, speechStyle: item.speechStyle })),
      plannedForeshadows: plannedForeshadows.map((item) => ({ title: item.title, detail: item.detail, status: item.status, firstSeenChapterNo: item.firstSeenChapterNo, lastSeenChapterNo: item.lastSeenChapterNo })),
      previousChapters,
      hardFacts,
      contextPack,
      targetWordCount,
    });

    const llmStartedAt = Date.now();
    const llmResult = await this.llm.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { appStep: 'generate', maxTokens: Math.min(10_000, Math.max(1800, Math.ceil(targetWordCount * 1.8))), timeoutMs: 450_000, retries: 1, temperature: 0.45 },
    );
    this.logger.log('generation.llm.completed', { ...logContext, stage: 'generating_draft', model: llmResult.model, tokenUsage: llmResult.usage, elapsedMs: Date.now() - llmStartedAt });
    const content = this.stripWrapperTags(llmResult.text);
    if (!content) throw new BadRequestException('write_chapter 生成正文为空');

    const actualWordCount = this.countChineseLikeWords(content);
    const qualityGate = this.assessGeneratedDraftQuality(content, actualWordCount, targetWordCount, chapter);
    if (qualityGate.blocked) {
      throw new BadRequestException(`生成后质量门禁未通过：${qualityGate.blockers.join('；')}`);
    }
    const modelInfo = { model: llmResult.model, usage: llmResult.usage, rawPayloadSummary: llmResult.rawPayloadSummary };
    const retrievalPayload = { contextPack, retrievalPlan: retrievalPlanResult.plan, plannerDiagnostics: retrievalPlanResult.diagnostics, retrievalCache: retrievalBundle.cache, lorebookHits: retrievalBundle.lorebookHits, memoryHits: retrievalBundle.memoryHits, structuredHits: retrievalBundle.structuredHits, rankedHits: retrievalBundle.rankedHits, diagnostics: retrievalBundle.diagnostics, preflight, qualityGate };

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
          generationContext: { agentRunId: input.agentRunId, instruction: input.instruction, targetWordCount, preflight, qualityGate, promptDebug: prompt.debug, retrievalPayload } as unknown as Prisma.InputJsonValue,
          isCurrent: true,
          createdBy: input.userId,
        },
      });
      await tx.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount } });
      return created;
    });
    this.logger.log('generation.draft.persisted', { ...logContext, stage: 'draft_persisted', draftId: draft.id, versionNo: draft.versionNo, actualWordCount, model: llmResult.model, tokenUsage: llmResult.usage, elapsedMs: Date.now() - runStartedAt });

    return { draftId: draft.id, chapterId, versionNo: draft.versionNo, actualWordCount, summary: content.slice(0, 160), retrievalPayload, preflight, qualityGate, promptDebug: prompt.debug, modelInfo };
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
  }): ChapterContextPack {
    return {
      schemaVersion: 1,
      verifiedContext: {
        lorebookHits: input.retrievalBundle.lorebookHits,
        memoryHits: input.retrievalBundle.memoryHits,
        structuredHits: input.retrievalBundle.structuredHits,
      },
      userIntent: {
        instruction: input.input.instruction?.trim() || undefined,
        chapterObjective: input.chapter.objective,
        chapterConflict: input.chapter.conflict,
        chapterOutline: input.chapter.outline,
      },
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

  /**
   * 生成后质量门禁：阻断明显异常输出，警告低质量但可人工复核的草稿。
   * 该检查只基于确定性文本特征，避免为了“评估”再次调用 LLM 造成额外成本和不稳定性。
   */
  private assessGeneratedDraftQuality(
    content: string,
    actualWordCount: number,
    targetWordCount: number,
    chapter?: { outline: string | null; craftBrief?: Prisma.JsonValue | null },
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

    const blockers = [
      ...(actualWordCount < Math.min(500, Math.max(120, targetWordCount * 0.18)) ? [`正文过短：${actualWordCount} 字，低于生产写入下限。`] : []),
      ...(hasRefusalPattern ? ['输出疑似包含模型拒答或说明性话术。'] : []),
      ...(duplicateParagraphRatio >= 0.35 && duplicateParagraphCount >= 3 ? ['重复段落比例过高，疑似生成退化。'] : []),
      ...(hasTemplateMarker ? ['输出包含模板占位符或待补充标记。'] : []),
    ];
    const warnings = [
      ...(targetRatio < 0.6 ? [`正文长度仅达到目标的 ${(targetRatio * 100).toFixed(0)}%，建议人工复核或重试。`] : []),
      ...(targetRatio > 1.8 ? [`正文长度达到目标的 ${(targetRatio * 100).toFixed(0)}%，可能超出章节节奏。`] : []),
      ...(duplicateParagraphRatio >= 0.18 && duplicateParagraphRatio < 0.35 ? ['存在一定比例重复段落，建议检查节奏和表达。'] : []),
      ...(hasWrapperOrMarkdown ? ['输出包含 Markdown/包裹标签痕迹，后处理可能需要清理。'] : []),
    ];
    const executionCardCoverage = chapter ? this.assessExecutionCardCoverage(content, chapter) : undefined;
    if (executionCardCoverage?.warnings.length) {
      warnings.push(...executionCardCoverage.warnings);
    }
    const score = Math.max(0, Math.min(100, 100 - blockers.length * 35 - warnings.length * 10 - Math.round(duplicateParagraphRatio * 40)));

    return {
      valid: blockers.length === 0,
      blocked: blockers.length > 0,
      score,
      blockers,
      warnings,
      ...(executionCardCoverage && { executionCardCoverage }),
      metrics: { actualWordCount, targetWordCount, targetRatio, paragraphCount: paragraphs.length, duplicateParagraphCount, duplicateParagraphRatio, hasWrapperOrMarkdown, hasRefusalPattern, hasTemplateMarker },
    };
  }

  /**
   * 生成前质量门禁：先检查章节目标、现有高危校验问题和覆盖风险。
   * validateBeforeWrite=false 可显式跳过阻断，但仍会把检查结果写入草稿上下文便于追踪。
   */
  private async runPreflight(
    projectId: string,
    chapter: { id: string; chapterNo: number; objective: string | null; conflict: string | null; outline: string | null; craftBrief?: Prisma.JsonValue | null; status: string },
    currentDraftVersionNo: number | undefined,
    input: GenerateChapterInput,
  ): Promise<GenerateChapterPreflightResult> {
    const openIssues = await this.validation.listByChapter(chapter.id);
    const openErrorCount = openIssues.filter((issue) => issue.severity === 'error').length;
    const outlineQuality = this.assessOutlineDensity(chapter, input);
    const blockers = [
      ...(!input.instruction?.trim() && !chapter.objective?.trim() && !chapter.outline?.trim() ? ['缺少章节目标/大纲/用户指令，无法构建稳定写作目标。'] : []),
      ...(openErrorCount > 0 ? [`当前章节存在 ${openErrorCount} 个未解决 error 级校验问题。`] : []),
      ...outlineQuality.blockers,
    ];
    const warnings = [
      ...(currentDraftVersionNo ? [`当前已有 v${currentDraftVersionNo} 草稿，本次会创建新版本并设为当前版本。`] : []),
      ...(!chapter.conflict?.trim() ? ['章节冲突为空，生成张力可能不足。'] : []),
      ...(chapter.status === 'reviewed' ? ['章节已处于 reviewed 状态，请确认确实要生成新草稿。'] : []),
      ...(input.validateBeforeWrite === false ? ['调用方显式关闭生成前阻断，仅记录 preflight 结果。'] : []),
      ...outlineQuality.warnings,
    ];
    return { valid: blockers.length === 0, blockers, warnings, openIssueCount: openIssues.length, openErrorCount, outlineQuality, currentDraftVersionNo };
  }

  private assessOutlineDensity(
    chapter: { objective: string | null; conflict: string | null; outline: string | null; craftBrief?: Prisma.JsonValue | null },
    input: GenerateChapterInput,
  ): OutlineDensityCheckResult {
    const brief = this.asRecord(chapter.craftBrief);
    const outline = chapter.outline ?? '';
    const actionBeats = this.stringArray(brief?.actionBeats);
    const clueCount = this.asRecordArray(brief?.concreteClues).filter((item) => this.text(item.name)).length;
    const hasStructuredBrief = actionBeats.length > 0 || clueCount > 0 || Boolean(this.text(brief?.irreversibleConsequence));
    const metrics = {
      outlineLength: outline.replace(/\s+/g, '').length,
      actionBeatCount: actionBeats.length,
      clueCount,
      hasObjective: Boolean(chapter.objective?.trim() || this.text(brief?.visibleGoal)),
      hasConflict: Boolean(chapter.conflict?.trim() || this.text(brief?.coreConflict)),
      hasIrreversibleConsequence: Boolean(this.text(brief?.irreversibleConsequence) || /不可逆后果|后果|代价/.test(outline)),
    };

    const missing = [
      ...(!metrics.hasObjective ? ['objective'] : []),
      ...(!metrics.hasConflict ? ['conflict'] : []),
      ...(metrics.outlineLength < 50 && !hasStructuredBrief ? ['outline_density'] : []),
      ...(actionBeats.length === 0 && !/行动链|关键行动|场景行动/.test(outline) ? ['action_beats'] : []),
      ...(clueCount === 0 && !/物证|线索|证据|道具/.test(outline) ? ['concrete_clues'] : []),
      ...(!metrics.hasIrreversibleConsequence ? ['irreversible_consequence'] : []),
    ];
    const messages = missing.map((item) => {
      switch (item) {
        case 'objective': return '细纲缺少可检验的章节目标。';
        case 'conflict': return '细纲缺少明确冲突或阻力来源。';
        case 'outline_density': return '章节细纲过短，缺少可执行场景密度。';
        case 'action_beats': return '执行卡缺少行动链。';
        case 'concrete_clues': return '执行卡缺少物证/线索。';
        case 'irreversible_consequence': return '执行卡缺少不可逆后果。';
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
      take: 3,
      include: { drafts: { where: { isCurrent: true }, orderBy: { versionNo: 'desc' }, take: 1 } },
    });
    return chapters
      .reverse()
      .map((item) => ({ chapterNo: item.chapterNo, title: item.title, content: item.drafts[0]?.content.slice(0, 6000) ?? '' }))
      .filter((item) => item.content);
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
