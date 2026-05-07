import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';
import { QualityReportsService } from './quality-reports.service';

export interface AiQualityReviewInput {
  chapterId?: string;
  draftId?: string;
  instruction?: string;
  focus?: string[];
}

export interface AiQualityReviewRuntime {
  agentRunId?: string;
  userId?: string;
  progress?: AiQualityReviewProgressReporter;
}

interface AiQualityReviewProgressPatch {
  phase?: string;
  phaseMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  timeoutMs?: number;
  deadlineMs?: number;
}

interface AiQualityReviewProgressReporter {
  updateProgress?: (patch: AiQualityReviewProgressPatch) => Promise<void>;
  heartbeat?: (patch?: AiQualityReviewProgressPatch) => Promise<void>;
}

const AI_QUALITY_REVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const AI_QUALITY_REVIEW_LLM_RETRIES = 1;
const AI_QUALITY_REVIEW_LLM_PHASE_TIMEOUT_MS = AI_QUALITY_REVIEW_LLM_TIMEOUT_MS * (AI_QUALITY_REVIEW_LLM_RETRIES + 1) + 5_000;

export interface AiQualityReviewResult {
  reportId: string;
  projectId: string;
  chapterId: string;
  draftId: string;
  sourceType: 'ai_review';
  reportType: 'ai_chapter_review';
  verdict: 'pass' | 'warn' | 'fail';
  summary: string;
  scores: Record<string, number>;
  issues: AiQualityReviewIssue[];
  model?: string;
  normalizationWarnings?: string[];
}

interface AiQualityReviewIssue {
  severity: 'info' | 'warning' | 'error';
  issueType: string;
  dimension: string;
  message: string;
  evidence?: string;
  suggestion?: string;
}

type DraftWithChapter = {
  id: string;
  versionNo: number;
  content: string;
  source: string;
  modelInfo: Prisma.JsonValue;
  generationContext: Prisma.JsonValue;
  createdAt: Date;
  chapter: {
    id: string;
    chapterNo: number;
    title: string | null;
    objective: string | null;
    conflict: string | null;
    revealPoints: string | null;
    foreshadowPlan: string | null;
    outline: string | null;
    craftBrief: Prisma.JsonValue;
    expectedWordCount: number | null;
    volume: {
      id: string;
      volumeNo: number;
      title: string | null;
      synopsis: string | null;
      objective: string | null;
      narrativePlan: Prisma.JsonValue;
    } | null;
  };
};

type ExistingAiReviewReport = {
  id: string;
  projectId: string;
  chapterId: string | null;
  draftId: string | null;
  sourceType: string;
  reportType: string;
  verdict: string;
  summary: string | null;
  scores: Prisma.JsonValue;
  issues: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
};

const SCORE_DIMENSIONS = [
  'plotProgress',
  'characterConsistency',
  'proseStyle',
  'pacing',
  'foreshadowing',
  'worldbuildingConsistency',
  'timelineKnowledge',
  'ruleCompliance',
] as const;

const PROMPT_VERSION = 'ai_quality_review.v1';

@Injectable()
export class AiQualityReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmGatewayService,
    private readonly qualityReports: QualityReportsService,
  ) {}

  async reviewAndCreate(projectId: string, input: AiQualityReviewInput, runtime: AiQualityReviewRuntime = {}): Promise<AiQualityReviewResult> {
    await runtime.progress?.updateProgress?.({ phase: 'preparing_context', phaseMessage: '正在读取 AI 审稿草稿' });
    const draft = await this.resolveDraft(projectId, input);
    const reviewIdentity = this.buildReviewIdentity(draft.id, input);
    const duplicate = await this.findDuplicateReview(projectId, draft, reviewIdentity);
    if (duplicate) {
      await runtime.progress?.heartbeat?.({ phase: 'validating', phaseMessage: '复用已有 AI 审稿报告', progressCurrent: 1, progressTotal: 1 });
      return this.toResultFromExistingReport(projectId, draft, duplicate);
    }

    await runtime.progress?.heartbeat?.({ phase: 'preparing_context', phaseMessage: '正在读取 AI 审稿上下文' });
    const context = await this.loadReviewContext(projectId, draft.chapter.id, draft.chapter.chapterNo);
    await runtime.progress?.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在进行 AI 审稿',
      progressCurrent: 0,
      progressTotal: 1,
      timeoutMs: AI_QUALITY_REVIEW_LLM_PHASE_TIMEOUT_MS,
    });
    const { data, result } = await this.llm.chatJson<unknown>(
      [
        {
          role: 'system',
          content: [
            '你是长篇小说 AI 审稿员。只输出严格 JSON，不要 Markdown，不要写入建议以外的任何说明。',
            '只基于输入的章节草稿、章节目标和项目上下文审阅，不把计划资产当作已经发生的正文事实。',
            '评分必须是 0 到 100 的数字；issues 必须是可执行、克制、可追踪的问题列表。',
            '输出字段：summary、verdict、scores、issues、strengths。',
            'verdict 只能是 pass、warn、fail。',
            'scores 至少包含 overall、plotProgress、characterConsistency、proseStyle、pacing、foreshadowing、worldbuildingConsistency、timelineKnowledge、ruleCompliance。',
            'issues 每项包含 severity(info|warning|error)、issueType、dimension、message、evidence、suggestion。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'ai_chapter_quality_review',
            promptVersion: PROMPT_VERSION,
            userInstruction: input.instruction ?? '',
            focus: this.stringArray(input.focus),
            project: context.project,
            chapter: this.chapterBrief(draft),
            relatedContext: context,
            draft: {
              id: draft.id,
              versionNo: draft.versionNo,
              source: draft.source,
              wordCount: this.countWords(draft.content),
              content: this.compactText(draft.content, 36000),
            },
            scoringDimensions: SCORE_DIMENSIONS,
          }),
        },
      ],
      { appStep: 'summary', temperature: 0.1, maxTokens: 1800, timeoutMs: AI_QUALITY_REVIEW_LLM_TIMEOUT_MS, retries: AI_QUALITY_REVIEW_LLM_RETRIES },
    );

    const normalized = this.normalizeReview(data);
    await runtime.progress?.heartbeat?.({ phase: 'validating', phaseMessage: '正在校验 AI 审稿结果', progressCurrent: 1, progressTotal: 1 });
    await runtime.progress?.updateProgress?.({ phase: 'persisting', phaseMessage: '正在写入质量报告', progressCurrent: 0, progressTotal: 1, timeoutMs: 60_000 });
    const report = await this.qualityReports.create(projectId, {
      chapterId: draft.chapter.id,
      draftId: draft.id,
      agentRunId: runtime.agentRunId,
      sourceType: 'ai_review',
      sourceId: draft.id,
      reportType: 'ai_chapter_review',
      scores: normalized.scores,
      issues: normalized.issues,
      verdict: normalized.verdict,
      summary: normalized.summary,
      metadata: {
        promptVersion: PROMPT_VERSION,
        sourceTrace: {
          sourceType: 'chapter_draft',
          sourceId: draft.id,
          chapterId: draft.chapter.id,
          chapterNo: draft.chapter.chapterNo,
          agentRunId: runtime.agentRunId ?? null,
        },
        focus: this.stringArray(input.focus),
        instruction: input.instruction ?? null,
        idempotency: {
          strategy: 'reuse_same_draft_focus_instruction_prompt_version',
          key: reviewIdentity.key,
          promptVersion: PROMPT_VERSION,
          draftId: draft.id,
          focus: reviewIdentity.focus,
          instruction: reviewIdentity.instruction || null,
          allowsMultipleReportsWhen: 'Different focus, instruction, draft, or promptVersion creates a new trend point.',
          requiresSchemaMigration: false,
        },
        llm: {
          model: result.model,
          usage: result.usage ?? null,
          rawPayloadSummary: result.rawPayloadSummary ?? null,
        },
        strengths: normalized.strengths,
        normalizationWarnings: normalized.normalizationWarnings,
      },
    });
    await runtime.progress?.heartbeat?.({ phase: 'persisting', phaseMessage: '质量报告写入完成', progressCurrent: 1, progressTotal: 1 });

    return {
      reportId: report.id,
      projectId,
      chapterId: draft.chapter.id,
      draftId: draft.id,
      sourceType: 'ai_review',
      reportType: 'ai_chapter_review',
      verdict: normalized.verdict,
      summary: normalized.summary,
      scores: normalized.scores,
      issues: normalized.issues,
      model: result.model,
      normalizationWarnings: normalized.normalizationWarnings,
    };
  }

  private buildReviewIdentity(draftId: string, input: AiQualityReviewInput) {
    const focus = this.normalizeFocus(input.focus);
    const instruction = this.normalizeInstruction(input.instruction);
    return {
      draftId,
      focus,
      instruction,
      key: [PROMPT_VERSION, draftId, focus.join(','), instruction].join('|'),
    };
  }

  private async findDuplicateReview(projectId: string, draft: DraftWithChapter, identity: ReturnType<AiQualityReviewService['buildReviewIdentity']>): Promise<ExistingAiReviewReport | undefined> {
    const reports = await this.prisma.qualityReport.findMany({
      where: {
        projectId,
        draftId: draft.id,
        sourceType: 'ai_review',
        reportType: 'ai_chapter_review',
        sourceId: draft.id,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        projectId: true,
        chapterId: true,
        draftId: true,
        sourceType: true,
        reportType: true,
        verdict: true,
        summary: true,
        scores: true,
        issues: true,
        metadata: true,
      },
    });

    return (reports as ExistingAiReviewReport[]).find((report) => this.matchesReviewIdentity(report.metadata, identity));
  }

  private matchesReviewIdentity(metadata: unknown, identity: ReturnType<AiQualityReviewService['buildReviewIdentity']>): boolean {
    const record = this.asRecord(metadata);
    if (record.promptVersion !== PROMPT_VERSION) return false;

    const idempotency = this.asRecord(record.idempotency);
    const storedKey = this.text(idempotency.key, '');
    if (storedKey && storedKey === identity.key) return true;

    const storedDraftId = this.text(idempotency.draftId, '');
    const storedFocus = this.normalizeFocus(idempotency.focus ?? record.focus);
    const storedInstruction = this.normalizeInstruction(idempotency.instruction ?? record.instruction);
    return (!storedDraftId || storedDraftId === identity.draftId)
      && this.sameStringArray(storedFocus, identity.focus)
      && storedInstruction === identity.instruction;
  }

  private toResultFromExistingReport(projectId: string, draft: DraftWithChapter, report: ExistingAiReviewReport): AiQualityReviewResult {
    const metadata = this.asRecord(report.metadata);
    const llm = this.asRecord(metadata.llm);
    return {
      reportId: report.id,
      projectId,
      chapterId: report.chapterId ?? draft.chapter.id,
      draftId: report.draftId ?? draft.id,
      sourceType: 'ai_review',
      reportType: 'ai_chapter_review',
      verdict: this.normalizeVerdict(report.verdict, this.score(this.asRecord(report.scores).overall, 70), []),
      summary: report.summary ?? this.defaultSummary(this.normalizeVerdict(report.verdict, 70, []), 70),
      scores: this.normalizeScores(report.scores),
      issues: this.normalizeIssues(report.issues).issues,
      model: this.text(llm.model, '') || undefined,
      normalizationWarnings: this.stringArray(metadata.normalizationWarnings),
    };
  }

  private async resolveDraft(projectId: string, input: AiQualityReviewInput): Promise<DraftWithChapter> {
    if (!input.draftId && !input.chapterId) throw new BadRequestException('AI 审稿需要 chapterId 或 draftId');
    if (input.draftId) {
      const draft = await this.prisma.chapterDraft.findFirst({
        where: {
          id: input.draftId,
          chapter: { projectId, ...(input.chapterId ? { id: input.chapterId } : {}) },
        },
        select: this.draftSelect(),
      });
      if (!draft) throw new NotFoundException(`Draft not found in project: ${input.draftId}`);
      return draft as DraftWithChapter;
    }

    const current = await this.prisma.chapterDraft.findFirst({
      where: { chapterId: input.chapterId, isCurrent: true, chapter: { projectId } },
      orderBy: { versionNo: 'desc' },
      select: this.draftSelect(),
    });
    if (current) return current as DraftWithChapter;

    const latest = await this.prisma.chapterDraft.findFirst({
      where: { chapterId: input.chapterId, chapter: { projectId } },
      orderBy: { versionNo: 'desc' },
      select: this.draftSelect(),
    });
    if (!latest) throw new NotFoundException(`No draft found for chapter: ${input.chapterId}`);
    return latest as DraftWithChapter;
  }

  private draftSelect() {
    return {
      id: true,
      versionNo: true,
      content: true,
      source: true,
      modelInfo: true,
      generationContext: true,
      createdAt: true,
      chapter: {
        select: {
          id: true,
          chapterNo: true,
          title: true,
          objective: true,
          conflict: true,
          revealPoints: true,
          foreshadowPlan: true,
          outline: true,
          craftBrief: true,
          expectedWordCount: true,
          volume: { select: { id: true, volumeNo: true, title: true, synopsis: true, objective: true, narrativePlan: true } },
        },
      },
    };
  }

  private async loadReviewContext(projectId: string, chapterId: string, chapterNo: number) {
    const [project, validationIssues, writingRules, relationshipEdges, timelineEvents, foreshadows, sceneCards, pacingBeats, recentReports] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
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
      }),
      this.prisma.validationIssue.findMany({
        where: { projectId, status: 'open', OR: [{ chapterId }, { chapterId: null }] },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { issueType: true, severity: true, message: true, suggestion: true, evidence: true },
      }),
      this.prisma.writingRule.findMany({
        where: {
          projectId,
          status: 'active',
          OR: [
            { appliesFromChapterNo: null, appliesToChapterNo: null },
            { appliesFromChapterNo: { lte: chapterNo }, appliesToChapterNo: null },
            { appliesFromChapterNo: null, appliesToChapterNo: { gte: chapterNo } },
            { appliesFromChapterNo: { lte: chapterNo }, appliesToChapterNo: { gte: chapterNo } },
          ],
        },
        orderBy: [{ severity: 'desc' }, { updatedAt: 'desc' }],
        take: 20,
        select: { ruleType: true, title: true, content: true, severity: true, entityType: true, entityRef: true },
      }),
      this.prisma.relationshipEdge.findMany({
        where: { projectId, status: 'active' },
        orderBy: { updatedAt: 'desc' },
        take: 16,
        select: { characterAName: true, characterBName: true, relationType: true, publicState: true, hiddenState: true, conflictPoint: true, emotionalArc: true },
      }),
      this.prisma.timelineEvent.findMany({
        where: { projectId, eventStatus: { not: 'archived' }, OR: [{ chapterId }, { chapterNo: { lte: chapterNo } }] },
        orderBy: [{ chapterNo: 'desc' }, { updatedAt: 'desc' }],
        take: 20,
        select: { chapterNo: true, title: true, eventTime: true, locationName: true, participants: true, result: true, isPublic: true, knownBy: true, unknownBy: true },
      }),
      this.prisma.foreshadowTrack.findMany({
        where: { projectId, status: { not: 'archived' }, OR: [{ chapterId }, { firstSeenChapterNo: { lte: chapterNo } }, { firstSeenChapterNo: null }] },
        orderBy: { updatedAt: 'desc' },
        take: 16,
        select: { title: true, detail: true, status: true, scope: true, firstSeenChapterNo: true, lastSeenChapterNo: true },
      }),
      this.prisma.sceneCard.findMany({
        where: { projectId, chapterId, status: { not: 'archived' } },
        orderBy: [{ sceneNo: 'asc' }, { updatedAt: 'desc' }],
        take: 12,
        select: { sceneNo: true, title: true, locationName: true, participants: true, purpose: true, conflict: true, emotionalTone: true, keyInformation: true, result: true },
      }),
      this.prisma.pacingBeat.findMany({
        where: { projectId, OR: [{ chapterId }, { chapterNo }, { chapterId: null, chapterNo: null }] },
        orderBy: { updatedAt: 'desc' },
        take: 12,
        select: { beatType: true, emotionalTone: true, emotionalIntensity: true, tensionLevel: true, payoffLevel: true, notes: true },
      }),
      this.prisma.qualityReport.findMany({
        where: { projectId, chapterId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { sourceType: true, reportType: true, verdict: true, summary: true, scores: true, issues: true, createdAt: true },
      }),
    ]);

    if (!project) throw new NotFoundException(`Project not found: ${projectId}`);
    return {
      project,
      validationIssues,
      writingRules,
      relationshipEdges,
      timelineEvents,
      foreshadows,
      sceneCards,
      pacingBeats,
      recentQualityReports: recentReports,
    };
  }

  private chapterBrief(draft: DraftWithChapter) {
    return {
      id: draft.chapter.id,
      chapterNo: draft.chapter.chapterNo,
      title: draft.chapter.title,
      objective: draft.chapter.objective,
      conflict: draft.chapter.conflict,
      outline: draft.chapter.outline,
      revealPoints: draft.chapter.revealPoints,
      foreshadowPlan: draft.chapter.foreshadowPlan,
      expectedWordCount: draft.chapter.expectedWordCount,
      craftBrief: draft.chapter.craftBrief,
      volume: draft.chapter.volume,
    };
  }

  private normalizeReview(value: unknown): {
    summary: string;
    verdict: 'pass' | 'warn' | 'fail';
    scores: Record<string, number>;
    issues: AiQualityReviewIssue[];
    strengths: string[];
    normalizationWarnings: string[];
  } {
    const record = this.asRecord(value);
    const scores = this.normalizeScores(record.scores);
    const normalizedIssues = this.normalizeIssues(record.issues);
    const issues = normalizedIssues.issues;
    const verdict = this.normalizeVerdict(record.verdict, scores.overall, issues);
    return {
      summary: this.text(record.summary, this.defaultSummary(verdict, scores.overall)),
      verdict,
      scores,
      issues,
      strengths: this.stringArray(record.strengths).slice(0, 8),
      normalizationWarnings: normalizedIssues.warnings,
    };
  }

  private normalizeScores(value: unknown): Record<string, number> {
    const raw = this.asRecord(value);
    const scores: Record<string, number> = {};
    for (const dimension of SCORE_DIMENSIONS) {
      scores[dimension] = this.score(raw[dimension], 70);
    }
    const average = SCORE_DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension], 0) / SCORE_DIMENSIONS.length;
    scores.overall = this.score(raw.overall, Math.round(average));
    return scores;
  }

  private normalizeIssues(value: unknown): { issues: AiQualityReviewIssue[]; warnings: string[] } {
    const warnings: string[] = [];
    const issues = this.asArray(value).slice(0, 30).flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warnings.push(`issues[${index}] skipped: missing issue object`);
        return [];
      }
      const record = this.asRecord(item);
      const message = this.text(record.message, '').slice(0, 1000);
      if (!message) {
        warnings.push(`issues[${index}] skipped: missing non-empty message`);
        return [];
      }
      return {
        severity: this.normalizeSeverity(record.severity),
        issueType: this.text(record.issueType, `ai_review_issue_${index + 1}`).slice(0, 100),
        dimension: this.text(record.dimension, 'general').slice(0, 80),
        message,
        ...(this.text(record.evidence, '') ? { evidence: this.text(record.evidence, '').slice(0, 1000) } : {}),
        ...(this.text(record.suggestion, '') ? { suggestion: this.text(record.suggestion, '').slice(0, 1000) } : {}),
      };
    });
    return { issues, warnings };
  }

  private normalizeVerdict(value: unknown, overall: number, issues: AiQualityReviewIssue[]): 'pass' | 'warn' | 'fail' {
    if (value === 'pass' || value === 'warn' || value === 'fail') return value;
    if (issues.some((issue) => issue.severity === 'error') || overall < 60) return 'fail';
    if (issues.length > 0 || overall < 80) return 'warn';
    return 'pass';
  }

  private normalizeSeverity(value: unknown): AiQualityReviewIssue['severity'] {
    if (value === 'error' || value === 'warning' || value === 'info') return value;
    if (value === 'warn') return 'warning';
    return 'warning';
  }

  private defaultSummary(verdict: 'pass' | 'warn' | 'fail', overall: number) {
    if (verdict === 'pass') return `AI 审稿通过，综合评分 ${overall}。`;
    if (verdict === 'warn') return `AI 审稿发现可改进问题，综合评分 ${overall}。`;
    return `AI 审稿发现高风险质量问题，综合评分 ${overall}。`;
  }

  private score(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : fallback;
  }

  private countWords(content: string): number {
    const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = content.replace(/[\u4e00-\u9fff]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    return cjk + words;
  }

  private compactText(value: unknown, maxLength: number): string {
    const text = this.text(value, '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  private text(value: unknown, fallback: string): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
  }

  private normalizeFocus(value: unknown): string[] {
    return [...new Set(this.stringArray(value).map((item) => item.replace(/\s+/g, ' ').trim().toLowerCase()))].sort();
  }

  private normalizeInstruction(value: unknown): string {
    return this.text(value, '').replace(/\s+/g, ' ').trim();
  }

  private sameStringArray(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }
}
