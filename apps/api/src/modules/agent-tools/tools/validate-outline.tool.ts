import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';

interface ValidateOutlineInput {
  preview?: OutlinePreviewOutput;
}

type OutlineValidationSeverity = 'warning' | 'error';

interface OutlineValidationIssue {
  severity: OutlineValidationSeverity;
  message: string;
  suggestion?: string;
}

export interface ValidateOutlineOutput {
  valid: boolean;
  issueCount: number;
  issues: OutlineValidationIssue[];
  stats: {
    chapterCount: number;
    expectedChapterCount?: number;
    duplicatedChapterNos: number[];
    totalExpectedWordCount: number;
    craftBriefCount: number;
    craftBriefMissingCount: number;
  };
  sourceRisks: string[];
  writePreview?: {
    volume: { action: 'create' | 'update'; volumeNo?: number; existingTitle?: string | null; nextTitle?: string };
    summary: { createCount: number; updateCount: number; skipCount: number };
    chapters: Array<{ chapterNo: number; title: string; action: 'create' | 'update_planned' | 'skip_existing_content'; existingStatus?: string | null }>;
  };
}

/**
 * 大纲预览校验工具：在持久化前检查章节编号、必填字段、字数和连续性风险。
 * 该工具只读取上游 preview，不写业务数据，用于提前暴露可人工修正的问题。
 */
@Injectable()
export class ValidateOutlineTool implements BaseTool<ValidateOutlineInput, ValidateOutlineOutput> {
  name = 'validate_outline';
  description = '校验大纲预览的章节编号、必填字段、字数和连续性风险。';
  inputSchema = { type: 'object' as const, properties: { preview: { type: 'object' as const } } };
  outputSchema = {
    type: 'object' as const,
    required: ['valid', 'issueCount', 'issues', 'stats', 'sourceRisks'],
    properties: { valid: { type: 'boolean' as const }, issueCount: { type: 'number' as const }, issues: { type: 'array' as const }, stats: { type: 'object' as const }, sourceRisks: { type: 'array' as const, items: { type: 'string' as const } } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ValidateOutlineInput, _context: ToolContext): Promise<ValidateOutlineOutput> {
    const issues: OutlineValidationIssue[] = [];
    const preview = args.preview;

    if (!preview) {
      issues.push({ severity: 'error', message: '缺少大纲预览，无法执行写入前校验。', suggestion: '请先重新生成大纲预览。' });
      return this.buildOutput(issues, [], undefined, []);
    }

    const chapters = preview.chapters ?? [];
    if (!chapters.length) {
      issues.push({ severity: 'error', message: '大纲预览中没有章节。', suggestion: '至少需要 1 个章节才能写入卷和章节表。' });
    }

    if (!Number.isFinite(preview.volume?.volumeNo) || preview.volume.volumeNo <= 0) {
      issues.push({ severity: 'error', message: '卷号必须是正数。', suggestion: '请重新生成或手动修正 volume.volumeNo。' });
    }

    const expectedChapterCount = preview.volume?.chapterCount;
    if (expectedChapterCount && expectedChapterCount !== chapters.length) {
      issues.push({ severity: 'warning', message: `卷声明章节数为 ${expectedChapterCount}，但实际预览为 ${chapters.length} 章。`, suggestion: '确认是否需要补齐或删减章节。' });
    }

    const chapterNos = chapters.map((chapter) => Number(chapter.chapterNo));
    const duplicatedChapterNos = this.findDuplicatedNumbers(chapterNos);
    if (duplicatedChapterNos.length) {
      issues.push({ severity: 'error', message: `存在重复章节编号：${duplicatedChapterNos.join(', ')}。`, suggestion: '章节编号重复会导致写入时覆盖判断不清晰，请先修正。' });
    }

    const sortedNos = [...new Set(chapterNos.filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
    if (sortedNos.length > 1 && sortedNos.some((value, index) => index > 0 && value !== sortedNos[index - 1] + 1)) {
      issues.push({ severity: 'warning', message: '章节编号不连续。', suggestion: '如需连续阅读体验，建议补齐缺失编号或重新排序。' });
    }

    chapters.forEach((chapter, index) => {
      const label = `第 ${chapter.chapterNo || index + 1} 章`;
      if (!Number.isFinite(Number(chapter.chapterNo)) || Number(chapter.chapterNo) <= 0) {
        issues.push({ severity: 'error', message: `${label} 的 chapterNo 必须是正数。` });
      }
      if (!this.text(chapter.title).trim()) issues.push({ severity: 'warning', message: `${label} 缺少标题。`, suggestion: '补充标题可提升后续章节定位和导航体验。' });
      if (!this.text(chapter.objective).trim()) issues.push({ severity: 'warning', message: `${label} 缺少目标。`, suggestion: '补充 objective 便于正文生成保持主线推进。' });
      if (!this.text(chapter.conflict).trim()) issues.push({ severity: 'warning', message: `${label} 缺少冲突。`, suggestion: '补充 conflict 可避免章节节奏过平。' });
      if (!this.text(chapter.outline).trim()) issues.push({ severity: 'warning', message: `${label} 缺少章节梗概。`, suggestion: '补充 outline 后再写入更利于后续生成正文。' });
      if (!Number.isFinite(Number(chapter.expectedWordCount)) || Number(chapter.expectedWordCount) <= 0) {
        issues.push({ severity: 'warning', message: `${label} 的 expectedWordCount 无效。`, suggestion: '建议设置一个正数字数目标。' });
      } else if (Number(chapter.expectedWordCount) < 500) {
        issues.push({ severity: 'warning', message: `${label} 的预期字数偏低。`, suggestion: '如非短篇/片段，建议提高到更合理的章节字数。' });
      }
      this.validateCraftBrief(chapter.craftBrief, label, issues);
    });

    const writePreview = await this.buildWritePreview(preview, _context);
    return this.buildOutput(issues, chapters, expectedChapterCount, preview.risks ?? [], writePreview);
  }

  /** 统一构建输出，确保前端和 report_result 都能稳定读取 issueCount/stats。 */
  private buildOutput(issues: OutlineValidationIssue[], chapters: OutlinePreviewOutput['chapters'], expectedChapterCount: number | undefined, sourceRisks: string[], writePreview?: ValidateOutlineOutput['writePreview']): ValidateOutlineOutput {
    const duplicatedChapterNos = this.findDuplicatedNumbers(chapters.map((chapter) => Number(chapter.chapterNo)));
    const craftBriefCount = chapters.filter((chapter) => Object.keys(this.asRecord(chapter.craftBrief)).length > 0).length;
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      stats: {
        chapterCount: chapters.length,
        expectedChapterCount,
        duplicatedChapterNos,
        totalExpectedWordCount: chapters.reduce((sum, chapter) => sum + (Number(chapter.expectedWordCount) || 0), 0),
        craftBriefCount,
        craftBriefMissingCount: Math.max(0, chapters.length - craftBriefCount),
      },
      sourceRisks,
      ...(writePreview ? { writePreview } : {}),
    };
  }

  /**
   * 在 Plan 阶段提前派生写入 diff，让审批台能说明哪些章节会创建、更新或跳过。
   * 这里只读数据库，不改变正式业务数据；真正写入仍由 persist_outline 在 Act 阶段执行。
   */
  private async buildWritePreview(preview: OutlinePreviewOutput, context: ToolContext): Promise<ValidateOutlineOutput['writePreview']> {
    const validChapterNos = preview.chapters.map((chapter) => Number(chapter.chapterNo)).filter((value) => Number.isFinite(value) && value > 0);
    const [existingVolume, existingChapters] = await Promise.all([
      this.prisma.volume.findUnique({ where: { projectId_volumeNo: { projectId: context.projectId, volumeNo: preview.volume.volumeNo } }, select: { title: true } }),
      validChapterNos.length
        ? this.prisma.chapter.findMany({ where: { projectId: context.projectId, chapterNo: { in: validChapterNos } }, select: { chapterNo: true, status: true, title: true } })
        : Promise.resolve([]),
    ]);
    const existingByNo = new Map(existingChapters.map((chapter) => [chapter.chapterNo, chapter]));
    const chapters = preview.chapters.map((chapter) => {
      const existing = existingByNo.get(Number(chapter.chapterNo));
      const action: 'create' | 'update_planned' | 'skip_existing_content' = !existing ? 'create' : existing.status === 'planned' ? 'update_planned' : 'skip_existing_content';
      return { chapterNo: Number(chapter.chapterNo), title: this.text(chapter.title), action, existingStatus: existing?.status ?? null };
    });
    return {
      volume: { action: existingVolume ? 'update' : 'create', volumeNo: preview.volume.volumeNo, existingTitle: existingVolume?.title ?? null, nextTitle: preview.volume.title },
      summary: {
        createCount: chapters.filter((chapter) => chapter.action === 'create').length,
        updateCount: chapters.filter((chapter) => chapter.action === 'update_planned').length,
        skipCount: chapters.filter((chapter) => chapter.action === 'skip_existing_content').length,
      },
      chapters,
    };
  }

  private findDuplicatedNumbers(values: number[]): number[] {
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    values.forEach((value) => {
      if (!Number.isFinite(value)) return;
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    });
    return [...duplicated].sort((a, b) => a - b);
  }

  private validateCraftBrief(value: unknown, label: string, issues: OutlineValidationIssue[]) {
    const brief = this.asRecord(value);
    if (!Object.keys(brief).length) {
      issues.push({
        severity: 'warning',
        message: `${label} 缺少 craftBrief 执行卡。`,
        suggestion: '旧 outline_preview 可以继续写入，但建议补齐 visibleGoal/coreConflict/actionBeats/concreteClues/irreversibleConsequence 后再用于正文生成。',
      });
      return;
    }
    if (!this.text(brief.visibleGoal).trim()) {
      issues.push({ severity: 'warning', message: `${label} 的 craftBrief.visibleGoal 为空。`, suggestion: '补充可被正文检验的表层目标。' });
    }
    if (!this.text(brief.coreConflict).trim()) {
      issues.push({ severity: 'warning', message: `${label} 的 craftBrief.coreConflict 为空。`, suggestion: '补充阻力来源和阻力方式。' });
    }
    const actionBeats = this.stringArray(brief.actionBeats);
    if (actionBeats.length < 3) {
      issues.push({ severity: 'warning', message: `${label} 的 craftBrief.actionBeats 少于 3 个节点。`, suggestion: '行动链建议至少包含起手行动、正面受阻、阶段结果。' });
    }
    const clues = this.asRecordArray(brief.concreteClues).filter((item) => this.text(item.name).trim());
    if (!clues.length) {
      issues.push({ severity: 'warning', message: `${label} 缺少 craftBrief.concreteClues。`, suggestion: '至少补 1 个具象线索、物证或可回收细节。' });
    }
    if (!this.text(brief.irreversibleConsequence).trim()) {
      issues.push({ severity: 'warning', message: `${label} 的 craftBrief.irreversibleConsequence 为空。`, suggestion: '结尾后果应改变事实、关系、资源、地位、规则或危险等级之一。' });
    }
  }

  /** 将上游 LLM 预览字段安全转换为文本，避免非字符串内容导致校验阶段 500。 */
  private text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return '';
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private asRecordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter((item) => Object.keys(item).length > 0)
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }
}
