import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';

interface ChapterAutoRepairProgressPatch {
  phase?: string;
  phaseMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  timeoutMs?: number;
  deadlineMs?: number;
}

interface ChapterAutoRepairProgressReporter {
  updateProgress?: (patch: ChapterAutoRepairProgressPatch) => Promise<void>;
  heartbeat?: (patch?: ChapterAutoRepairProgressPatch) => Promise<void>;
}

export interface ChapterAutoRepairResult {
  skipped: boolean;
  reason?: string;
  draftId?: string;
  chapterId: string;
  originalDraftId?: string;
  originalWordCount?: number;
  repairedWordCount?: number;
  repairedIssueCount: number;
  maxRounds: number;
  summary?: string;
}

const CHAPTER_AUTO_REPAIR_LLM_TIMEOUT_MS = 180_000;
const CHAPTER_AUTO_REPAIR_LLM_RETRIES = 1;
const CHAPTER_AUTO_REPAIR_PHASE_TIMEOUT_MS = CHAPTER_AUTO_REPAIR_LLM_TIMEOUT_MS * (CHAPTER_AUTO_REPAIR_LLM_RETRIES + 1) + 5_000;

/**
 * 有界自动修复服务：针对当前章节的开放校验问题最多执行一轮 LLM 改写。
 * 输入章节和可选问题；输出修复结果；副作用是必要时创建新的当前草稿版本并同步章节字数。
 */
@Injectable()
export class ChapterAutoRepairService {
  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService) {}

  /** 最多一轮自动修复，避免 Agent 在校验/改写之间无限循环消耗。 */
  async run(projectId: string, chapterId: string, options: { draftId?: string; issues?: unknown[]; executionCardCoverage?: unknown; instruction?: string; userId?: string; maxRounds?: number; progress?: ChapterAutoRepairProgressReporter } = {}): Promise<ChapterAutoRepairResult> {
    const maxRounds = Math.min(1, Math.max(0, options.maxRounds ?? 1));
    await options.progress?.updateProgress?.({ phase: 'preparing_context', phaseMessage: '正在读取自动修复上下文', timeoutMs: 60_000 });
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);
    if (maxRounds < 1) return { skipped: true, reason: 'max_rounds_zero', chapterId, repairedIssueCount: 0, maxRounds };

    const draft = options.draftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: options.draftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!draft) throw new NotFoundException(`章节 ${chapterId} 暂无可修复草稿`);

    const hasExplicitIssues = options.issues !== undefined;
    const providedIssues = this.normalizeIssues(options.issues ?? []);
    const coverageIssues = this.buildCoverageRepairIssues(options.executionCardCoverage)
      .concat(this.buildCoverageRepairIssues(this.readDraftExecutionCardCoverage(draft.generationContext)));
    const issues = hasExplicitIssues
      ? [...providedIssues, ...coverageIssues]
      : [...await this.loadOpenIssues(projectId, chapterId), ...await this.loadQualityReportIssues(projectId, chapterId, draft.id), ...coverageIssues];
    const repairableIssues = issues.filter((issue) => ['error', 'warning'].includes(issue.severity)).slice(0, 5);
    const originalWordCount = this.countChineseLikeWords(draft.content.trim());
    if (!repairableIssues.length) {
      await options.progress?.heartbeat?.({ phase: 'validating', phaseMessage: '没有可自动修复的问题', progressCurrent: 1, progressTotal: 1 });
      return { skipped: true, reason: 'no_repairable_issues', draftId: draft.id, chapterId, originalDraftId: draft.id, originalWordCount, repairedWordCount: originalWordCount, repairedIssueCount: 0, maxRounds, summary: draft.content.trim().slice(0, 160) };
    }

    const originalText = draft.content.trim();
    if (this.countChineseLikeWords(originalText) < 50) throw new BadRequestException('草稿内容过短，无法自动修复。');

    await options.progress?.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在自动修复章节草稿',
      progressCurrent: 0,
      progressTotal: repairableIssues.length,
      timeoutMs: CHAPTER_AUTO_REPAIR_PHASE_TIMEOUT_MS,
    });
    const llmResult = await this.llm.chat(
      [
        { role: 'system', content: '你是小说章节自动修复 Agent。你只能依据给定校验问题对正文做最小必要改写，不得新增重大剧情、角色或设定。只输出修复后的正文。' },
        { role: 'user', content: this.buildRepairPrompt(chapter, originalText, repairableIssues, options.instruction) },
      ],
      { appStep: 'polish', maxTokens: Math.min(9000, Math.max(1800, Math.ceil(originalText.length * 1.35))), timeoutMs: CHAPTER_AUTO_REPAIR_LLM_TIMEOUT_MS, retries: CHAPTER_AUTO_REPAIR_LLM_RETRIES, temperature: 0.25 },
    );
    const repairedText = this.stripWrapperTags(llmResult.text);
    if (!repairedText) throw new BadRequestException('自动修复返回正文为空');
    if (repairedText === draft.content) {
      await options.progress?.heartbeat?.({ phase: 'validating', phaseMessage: '自动修复未产生正文变更', progressCurrent: repairableIssues.length, progressTotal: repairableIssues.length });
      return { skipped: true, reason: 'llm_no_change', draftId: draft.id, chapterId, originalDraftId: draft.id, originalWordCount, repairedWordCount: originalWordCount, repairedIssueCount: repairableIssues.length, maxRounds, summary: originalText.slice(0, 160) };
    }

    const repairedWordCount = this.countChineseLikeWords(repairedText);
    await options.progress?.updateProgress?.({ phase: 'persisting', phaseMessage: '正在写入自动修复草稿', progressCurrent: 0, progressTotal: 1, timeoutMs: 60_000 });
    const finalDraft = await this.prisma.$transaction(async (tx) => {
      // 自动修复写入新草稿时重新读取最新版本，避免与其他写稿 Tool 并发导致 versionNo 冲突。
      const latestInTransaction = await tx.chapterDraft.findFirst({ where: { chapterId }, orderBy: { versionNo: 'desc' } });
      await tx.chapterDraft.updateMany({ where: { chapterId, isCurrent: true }, data: { isCurrent: false } });
      const created = await tx.chapterDraft.create({
        data: {
          chapterId,
          versionNo: (latestInTransaction?.versionNo ?? 0) + 1,
          content: repairedText,
          source: 'agent_auto_repair',
          modelInfo: { model: llmResult.model, usage: llmResult.usage, rawPayloadSummary: llmResult.rawPayloadSummary } as Prisma.InputJsonValue,
          generationContext: { originalDraftId: draft.id, repairedIssues: repairableIssues, maxRounds, instruction: options.instruction } as Prisma.InputJsonValue,
          isCurrent: true,
          createdBy: options.userId ?? draft.createdBy,
        },
      });
      await tx.chapter.update({ where: { id: chapterId }, data: { status: 'drafted', actualWordCount: repairedWordCount } });
      return created;
    });

    await options.progress?.heartbeat?.({ phase: 'persisting', phaseMessage: '自动修复草稿写入完成', progressCurrent: 1, progressTotal: 1 });
    return { skipped: false, draftId: finalDraft.id, chapterId, originalDraftId: draft.id, originalWordCount, repairedWordCount, repairedIssueCount: repairableIssues.length, maxRounds, summary: repairedText.slice(0, 160) };
  }

  private async loadOpenIssues(projectId: string, chapterId: string) {
    const rows = await this.prisma.validationIssue.findMany({ where: { projectId, chapterId, status: 'open' }, orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }], take: 10 });
    return rows.map((row) => ({ severity: row.severity, message: row.message, suggestion: row.suggestion ?? undefined }));
  }

  private async loadQualityReportIssues(projectId: string, chapterId: string, draftId: string) {
    const reports = await this.prisma.qualityReport.findMany({
      where: {
        projectId,
        chapterId,
        draftId,
        sourceType: 'generation',
        reportType: 'generation_quality_gate',
        verdict: { in: ['warn', 'fail'] },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 5,
    });

    return reports.flatMap((report) => {
      const issues = this.normalizeIssues(Array.isArray(report.issues) ? report.issues : []);
      if (issues.length > 0) {
        return issues.map((issue) => ({
          ...issue,
          message: `[${report.reportType}] ${issue.message}`,
        }));
      }
      return report.verdict === 'fail' && report.summary
        ? [{ severity: 'error', message: `[${report.reportType}] ${report.summary}` }]
        : [];
    });
  }

  private normalizeIssues(value: unknown[]): Array<{ severity: string; message: string; suggestion?: string }> {
    return value
      .map((item) => {
        if (typeof item === 'string') return { severity: 'warning', message: item };
        return item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
      })
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({ severity: this.normalizeIssueSeverity(String(item.severity ?? 'info')), message: String(item.message ?? item.summary ?? item.title ?? ''), suggestion: typeof item.suggestion === 'string' ? item.suggestion : undefined }))
      .filter((item) => item.message);
  }

  private normalizeIssueSeverity(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (['error', 'critical', 'fail', 'blocker'].includes(normalized)) return 'error';
    if (['warning', 'warn'].includes(normalized)) return 'warning';
    return 'info';
  }

  private readDraftExecutionCardCoverage(generationContext: unknown): unknown {
    const context = this.asRecord(generationContext);
    const qualityGate = this.asRecord(context?.qualityGate);
    return qualityGate?.executionCardCoverage;
  }

  private buildCoverageRepairIssues(value: unknown): Array<{ severity: string; message: string; suggestion?: string }> {
    const coverage = this.asRecord(value);
    if (!coverage) return [];
    const missing = this.asRecord(coverage.missing);
    const warnings = Array.isArray(coverage.warnings)
      ? coverage.warnings.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const missingClues = Array.isArray(missing?.clueNames)
      ? missing.clueNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const missingConsequence = typeof missing?.irreversibleConsequence === 'string'
      ? missing.irreversibleConsequence.trim()
      : '';

    const issues = warnings.map((message) => ({
      severity: 'warning',
      message: `执行卡覆盖检查：${message}`,
      suggestion: '在保留原剧情的前提下，补写缺失的物证、行动节点或不可逆后果。',
    }));
    if (missingClues.length > 0) {
      issues.push({
        severity: 'warning',
        message: `执行卡覆盖检查：正文缺少关键物证/线索 ${missingClues.join('、')}。`,
        suggestion: '把这些物证/线索写成可感知细节，并让它们影响角色选择。',
      });
    }
    if (missingConsequence) {
      issues.push({
        severity: 'warning',
        message: `执行卡覆盖检查：正文缺少不可逆后果「${missingConsequence}」。`,
        suggestion: '在章节结尾前补足事实、关系、资源、地位、规则或危险的不可逆变化。',
      });
    }

    return issues;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private buildRepairPrompt(chapter: { chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null }, originalText: string, issues: Array<{ severity: string; message: string; suggestion?: string }>, instruction?: string): string {
    const issueBlock = issues.map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.message}${issue.suggestion ? `\n建议：${issue.suggestion}` : ''}`).join('\n');
    // 修复提示强调“最小必要改写”，防止自动修复阶段把章节重写成新剧情。
    return `【章节】第${chapter.chapterNo}章「${chapter.title || '未命名'}」\n【目标】${chapter.objective || '无'}\n【冲突】${chapter.conflict || '无'}\n【大纲】${chapter.outline || '无'}\n\n【用户修复要求】\n${instruction || '修正校验问题，保留原剧情和叙事风格。'}\n\n【需要修复的问题】\n${issueBlock}\n\n【原正文】\n${originalText}`;
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
