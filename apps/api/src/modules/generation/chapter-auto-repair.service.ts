import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';

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

/**
 * 有界自动修复服务：针对当前章节的开放校验问题最多执行一轮 LLM 改写。
 * 输入章节和可选问题；输出修复结果；副作用是必要时创建新的当前草稿版本并同步章节字数。
 */
@Injectable()
export class ChapterAutoRepairService {
  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService) {}

  /** 最多一轮自动修复，避免 Agent 在校验/改写之间无限循环消耗。 */
  async run(projectId: string, chapterId: string, options: { draftId?: string; issues?: unknown[]; instruction?: string; userId?: string; maxRounds?: number } = {}): Promise<ChapterAutoRepairResult> {
    const maxRounds = Math.min(1, Math.max(0, options.maxRounds ?? 1));
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId } });
    if (!chapter) throw new NotFoundException(`章节不存在或不属于当前项目：${chapterId}`);
    if (maxRounds < 1) return { skipped: true, reason: 'max_rounds_zero', chapterId, repairedIssueCount: 0, maxRounds };

    const draft = options.draftId
      ? await this.prisma.chapterDraft.findFirst({ where: { id: options.draftId, chapterId } })
      : await this.prisma.chapterDraft.findFirst({ where: { chapterId, isCurrent: true }, orderBy: { versionNo: 'desc' } });
    if (!draft) throw new NotFoundException(`章节 ${chapterId} 暂无可修复草稿`);

    const providedIssues = this.normalizeIssues(options.issues ?? []);
    const issues = providedIssues.length ? providedIssues : await this.loadOpenIssues(projectId, chapterId);
    const repairableIssues = issues.filter((issue) => ['error', 'warning'].includes(issue.severity)).slice(0, 5);
    const originalWordCount = this.countChineseLikeWords(draft.content.trim());
    if (!repairableIssues.length) return { skipped: true, reason: 'no_repairable_issues', draftId: draft.id, chapterId, originalDraftId: draft.id, originalWordCount, repairedWordCount: originalWordCount, repairedIssueCount: 0, maxRounds, summary: draft.content.trim().slice(0, 160) };

    const originalText = draft.content.trim();
    if (this.countChineseLikeWords(originalText) < 50) throw new BadRequestException('草稿内容过短，无法自动修复。');

    const llmResult = await this.llm.chat(
      [
        { role: 'system', content: '你是小说章节自动修复 Agent。你只能依据给定校验问题对正文做最小必要改写，不得新增重大剧情、角色或设定。只输出修复后的正文。' },
        { role: 'user', content: this.buildRepairPrompt(chapter, originalText, repairableIssues, options.instruction) },
      ],
      { appStep: 'polish', maxTokens: Math.min(9000, Math.max(1800, Math.ceil(originalText.length * 1.35))), timeoutMs: 180_000, retries: 1, temperature: 0.25 },
    );
    const repairedText = this.stripWrapperTags(llmResult.text);
    if (!repairedText) throw new BadRequestException('自动修复返回正文为空');
    if (repairedText === draft.content) return { skipped: true, reason: 'llm_no_change', draftId: draft.id, chapterId, originalDraftId: draft.id, originalWordCount, repairedWordCount: originalWordCount, repairedIssueCount: repairableIssues.length, maxRounds, summary: originalText.slice(0, 160) };

    const latest = await this.prisma.chapterDraft.findFirst({ where: { chapterId }, orderBy: { versionNo: 'desc' } });
    const repairedWordCount = this.countChineseLikeWords(repairedText);
    const finalDraft = await this.prisma.$transaction(async (tx) => {
      await tx.chapterDraft.updateMany({ where: { chapterId, isCurrent: true }, data: { isCurrent: false } });
      const created = await tx.chapterDraft.create({
        data: {
          chapterId,
          versionNo: (latest?.versionNo ?? 0) + 1,
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

    return { skipped: false, draftId: finalDraft.id, chapterId, originalDraftId: draft.id, originalWordCount, repairedWordCount, repairedIssueCount: repairableIssues.length, maxRounds, summary: repairedText.slice(0, 160) };
  }

  private async loadOpenIssues(projectId: string, chapterId: string) {
    const rows = await this.prisma.validationIssue.findMany({ where: { projectId, chapterId, status: 'open' }, orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }], take: 10 });
    return rows.map((row) => ({ severity: row.severity, message: row.message, suggestion: row.suggestion ?? undefined }));
  }

  private normalizeIssues(value: unknown[]): Array<{ severity: string; message: string; suggestion?: string }> {
    return value
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({ severity: String(item.severity ?? 'info'), message: String(item.message ?? ''), suggestion: typeof item.suggestion === 'string' ? item.suggestion : undefined }))
      .filter((item) => item.message);
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