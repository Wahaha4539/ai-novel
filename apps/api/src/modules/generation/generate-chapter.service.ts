import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { RetrievalService } from '../memory/retrieval.service';
import { ValidationService } from '../validation/validation.service';
import { PromptBuilderService } from './prompt-builder.service';

export interface GenerateChapterInput {
  instruction?: string;
  wordCount?: number;
  includeLorebook?: boolean;
  includeMemory?: boolean;
  validateBeforeWrite?: boolean;
  agentRunId?: string;
  userId?: string;
}

export interface GenerateChapterPreflightResult {
  valid: boolean;
  blockers: string[];
  warnings: string[];
  openIssueCount: number;
  openErrorCount: number;
  currentDraftVersionNo?: number;
}

export interface GeneratedDraftQualityGateResult {
  valid: boolean;
  blocked: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmGatewayService,
    private readonly retrieval: RetrievalService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly validation: ValidationService,
  ) {}

  /** 同步生成章节正文，并把生成上下文、召回结果和模型信息记录到草稿元数据。 */
  async run(projectId: string, chapterId: string, input: GenerateChapterInput = {}): Promise<GenerateChapterResult> {
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, include: { project: true, volume: true } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);

    const targetWordCount = input.wordCount ?? chapter.expectedWordCount ?? 3500;
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
    const retrievalBundle = await this.retrieval.retrieveBundle(
      projectId,
      { queryText: input.instruction || chapter.objective, objective: chapter.objective, conflict: chapter.conflict, characters: characters.map((item) => item.name) },
      { includeLorebook: input.includeLorebook ?? true, includeMemory: input.includeMemory ?? true },
    );
    if (retrievalBundle.diagnostics.qualityStatus === 'blocked') {
      throw new BadRequestException(`召回质量不足，已阻断生成：${retrievalBundle.diagnostics.warnings.join('；')}`);
    }

    const prompt = await this.promptBuilder.buildChapterPrompt({
      project: { id: chapter.project.id, title: chapter.project.title, genre: chapter.project.genre, tone: chapter.project.tone, synopsis: chapter.project.synopsis, outline: chapter.project.outline },
      volume: chapter.volume ? { volumeNo: chapter.volume.volumeNo, title: chapter.volume.title, objective: chapter.volume.objective, synopsis: chapter.volume.synopsis } : null,
      styleProfile,
      chapter: { chapterNo: chapter.chapterNo, title: chapter.title, objective: chapter.objective, conflict: chapter.conflict, outline: chapter.outline, revealPoints: chapter.revealPoints, foreshadowPlan: chapter.foreshadowPlan, expectedWordCount: chapter.expectedWordCount },
      characters: characters.map((item) => ({ name: item.name, roleType: item.roleType, personalityCore: item.personalityCore, motivation: item.motivation, speechStyle: item.speechStyle })),
      plannedForeshadows: plannedForeshadows.map((item) => ({ title: item.title, detail: item.detail, status: item.status, firstSeenChapterNo: item.firstSeenChapterNo, lastSeenChapterNo: item.lastSeenChapterNo })),
      previousChapters,
      hardFacts,
      lorebookHits: retrievalBundle.lorebookHits,
      memoryHits: retrievalBundle.rankedHits,
      userInstruction: input.instruction,
      targetWordCount,
    });

    const llmResult = await this.llm.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { appStep: 'generate', maxTokens: Math.min(10_000, Math.max(1800, Math.ceil(targetWordCount * 1.8))), timeoutMs: 180_000, retries: 1, temperature: 0.45 },
    );
    const content = this.stripWrapperTags(llmResult.text);
    if (!content) throw new BadRequestException('write_chapter 生成正文为空');

    const actualWordCount = this.countChineseLikeWords(content);
    const qualityGate = this.assessGeneratedDraftQuality(content, actualWordCount, targetWordCount);
    if (qualityGate.blocked) {
      throw new BadRequestException(`生成后质量门禁未通过：${qualityGate.blockers.join('；')}`);
    }
    const modelInfo = { model: llmResult.model, usage: llmResult.usage, rawPayloadSummary: llmResult.rawPayloadSummary };
    const retrievalPayload = { lorebookHits: retrievalBundle.lorebookHits, memoryHits: retrievalBundle.memoryHits, rankedHits: retrievalBundle.rankedHits, diagnostics: retrievalBundle.diagnostics, preflight, qualityGate };

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

    return { draftId: draft.id, chapterId, versionNo: draft.versionNo, actualWordCount, summary: content.slice(0, 160), retrievalPayload, preflight, qualityGate, promptDebug: prompt.debug, modelInfo };
  }

  /**
   * 生成后质量门禁：阻断明显异常输出，警告低质量但可人工复核的草稿。
   * 该检查只基于确定性文本特征，避免为了“评估”再次调用 LLM 造成额外成本和不稳定性。
   */
  private assessGeneratedDraftQuality(content: string, actualWordCount: number, targetWordCount: number): GeneratedDraftQualityGateResult {
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
    const score = Math.max(0, Math.min(100, 100 - blockers.length * 35 - warnings.length * 10 - Math.round(duplicateParagraphRatio * 40)));

    return {
      valid: blockers.length === 0,
      blocked: blockers.length > 0,
      score,
      blockers,
      warnings,
      metrics: { actualWordCount, targetWordCount, targetRatio, paragraphCount: paragraphs.length, duplicateParagraphCount, duplicateParagraphRatio, hasWrapperOrMarkdown, hasRefusalPattern, hasTemplateMarker },
    };
  }

  /**
   * 生成前质量门禁：先检查章节目标、现有高危校验问题和覆盖风险。
   * validateBeforeWrite=false 可显式跳过阻断，但仍会把检查结果写入草稿上下文便于追踪。
   */
  private async runPreflight(
    projectId: string,
    chapter: { id: string; chapterNo: number; objective: string | null; conflict: string | null; outline: string | null; status: string },
    currentDraftVersionNo: number | undefined,
    input: GenerateChapterInput,
  ): Promise<GenerateChapterPreflightResult> {
    const openIssues = await this.validation.listByChapter(chapter.id);
    const openErrorCount = openIssues.filter((issue) => issue.severity === 'error').length;
    const blockers = [
      ...(!input.instruction?.trim() && !chapter.objective?.trim() && !chapter.outline?.trim() ? ['缺少章节目标/大纲/用户指令，无法构建稳定写作目标。'] : []),
      ...(openErrorCount > 0 ? [`当前章节存在 ${openErrorCount} 个未解决 error 级校验问题。`] : []),
    ];
    const warnings = [
      ...(currentDraftVersionNo ? [`当前已有 v${currentDraftVersionNo} 草稿，本次会创建新版本并设为当前版本。`] : []),
      ...(!chapter.conflict?.trim() ? ['章节冲突为空，生成张力可能不足。'] : []),
      ...(chapter.status === 'reviewed' ? ['章节已处于 reviewed 状态，请确认确实要生成新草稿。'] : []),
      ...(input.validateBeforeWrite === false ? ['调用方显式关闭生成前阻断，仅记录 preflight 结果。'] : []),
    ];
    return { valid: blockers.length === 0, blockers, warnings, openIssueCount: openIssues.length, openErrorCount, currentDraftVersionNo };
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
}