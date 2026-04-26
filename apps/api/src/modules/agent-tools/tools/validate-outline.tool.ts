import { Injectable } from '@nestjs/common';
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
  };
  sourceRisks: string[];
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
      if (!chapter.title?.trim()) issues.push({ severity: 'warning', message: `${label} 缺少标题。`, suggestion: '补充标题可提升后续章节定位和导航体验。' });
      if (!chapter.objective?.trim()) issues.push({ severity: 'warning', message: `${label} 缺少目标。`, suggestion: '补充 objective 便于正文生成保持主线推进。' });
      if (!chapter.conflict?.trim()) issues.push({ severity: 'warning', message: `${label} 缺少冲突。`, suggestion: '补充 conflict 可避免章节节奏过平。' });
      if (!chapter.outline?.trim()) issues.push({ severity: 'warning', message: `${label} 缺少章节梗概。`, suggestion: '补充 outline 后再写入更利于后续生成正文。' });
      if (!Number.isFinite(Number(chapter.expectedWordCount)) || Number(chapter.expectedWordCount) <= 0) {
        issues.push({ severity: 'warning', message: `${label} 的 expectedWordCount 无效。`, suggestion: '建议设置一个正数字数目标。' });
      } else if (Number(chapter.expectedWordCount) < 500) {
        issues.push({ severity: 'warning', message: `${label} 的预期字数偏低。`, suggestion: '如非短篇/片段，建议提高到更合理的章节字数。' });
      }
    });

    return this.buildOutput(issues, chapters, expectedChapterCount, preview.risks ?? []);
  }

  /** 统一构建输出，确保前端和 report_result 都能稳定读取 issueCount/stats。 */
  private buildOutput(issues: OutlineValidationIssue[], chapters: OutlinePreviewOutput['chapters'], expectedChapterCount: number | undefined, sourceRisks: string[]): ValidateOutlineOutput {
    const duplicatedChapterNos = this.findDuplicatedNumbers(chapters.map((chapter) => Number(chapter.chapterNo)));
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      stats: {
        chapterCount: chapters.length,
        expectedChapterCount,
        duplicatedChapterNos,
        totalExpectedWordCount: chapters.reduce((sum, chapter) => sum + (Number(chapter.expectedWordCount) || 0), 0),
      },
      sourceRisks,
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
}