import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';
import { ImportPreviewOutput } from './build-import-preview.tool';

interface ValidateImportedAssetsInput {
  preview?: ImportPreviewOutput;
}

type ImportValidationArea = 'project' | 'characters' | 'lorebook' | 'volumes' | 'chapters';
type ImportValidationSeverity = 'warning' | 'error';

interface ImportedAssetsValidationIssue {
  severity: ImportValidationSeverity;
  area: ImportValidationArea;
  message: string;
  suggestion?: string;
}

export interface ValidateImportedAssetsOutput {
  valid: boolean;
  issueCount: number;
  issues: ImportedAssetsValidationIssue[];
  stats: {
    characterCount: number;
    lorebookCount: number;
    volumeCount: number;
    chapterCount: number;
    duplicatedCharacterNames: string[];
    duplicatedVolumeNos: number[];
    duplicatedChapterNos: number[];
  };
  sourceRisks: string[];
}

/**
 * 导入预览校验工具：在写入项目前检查资料、角色、设定、卷和章节的完整性。
 * 它不做数据库写入，只把结构性问题显式返回给审批台和最终报告。
 */
@Injectable()
export class ValidateImportedAssetsTool implements BaseTool<ValidateImportedAssetsInput, ValidateImportedAssetsOutput> {
  name = 'validate_imported_assets';
  description = '校验文案拆解导入预览的项目资料、角色、设定、卷和章节完整性。';
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

  async run(args: ValidateImportedAssetsInput, _context: ToolContext): Promise<ValidateImportedAssetsOutput> {
    const issues: ImportedAssetsValidationIssue[] = [];
    const preview = args.preview;

    if (!preview) {
      issues.push({ severity: 'error', area: 'project', message: '缺少导入预览，无法执行写入前校验。', suggestion: '请先重新构建导入预览。' });
      return this.buildOutput(issues, undefined);
    }

    const profile = preview.projectProfile ?? {};
    if (!profile.title && !profile.logline && !profile.synopsis && !profile.outline) {
      issues.push({ severity: 'warning', area: 'project', message: '项目资料过少，缺少 title/logline/synopsis/outline。', suggestion: '建议补充至少一个项目简介字段，便于后续创作上下文使用。' });
    }

    const duplicatedCharacterNames = this.findDuplicatedStrings((preview.characters ?? []).map((character) => character.name));
    if (duplicatedCharacterNames.length) {
      issues.push({ severity: 'warning', area: 'characters', message: `存在重复角色名：${duplicatedCharacterNames.join(', ')}。`, suggestion: '写入时会按名称去重，重复项可能被跳过。' });
    }

    (preview.characters ?? []).forEach((character, index) => {
      if (!character.name?.trim()) issues.push({ severity: 'error', area: 'characters', message: `第 ${index + 1} 个角色缺少 name。` });
    });

    (preview.lorebookEntries ?? []).forEach((entry, index) => {
      const label = entry.title || `第 ${index + 1} 条设定`;
      if (!entry.title?.trim()) issues.push({ severity: 'error', area: 'lorebook', message: `${label} 缺少 title。` });
      if (!entry.content?.trim()) issues.push({ severity: 'error', area: 'lorebook', message: `${label} 缺少 content。` });
    });

    const volumeNos = (preview.volumes ?? []).map((volume) => Number(volume.volumeNo));
    const duplicatedVolumeNos = this.findDuplicatedNumbers(volumeNos);
    if (duplicatedVolumeNos.length) {
      issues.push({ severity: 'error', area: 'volumes', message: `存在重复卷号：${duplicatedVolumeNos.join(', ')}。`, suggestion: '卷号重复会影响 upsert，请先修正。' });
    }

    const validVolumeNos = new Set(volumeNos.filter((value) => Number.isFinite(value) && value > 0));
    (preview.volumes ?? []).forEach((volume, index) => {
      const label = volume.title || `第 ${index + 1} 个卷预览`;
      if (!Number.isFinite(Number(volume.volumeNo)) || Number(volume.volumeNo) <= 0) issues.push({ severity: 'error', area: 'volumes', message: `${label} 的 volumeNo 必须是正数。` });
      if (!volume.title?.trim()) issues.push({ severity: 'warning', area: 'volumes', message: `${label} 缺少标题。` });
    });

    const chapterNos = (preview.chapters ?? []).map((chapter) => Number(chapter.chapterNo));
    const duplicatedChapterNos = this.findDuplicatedNumbers(chapterNos);
    if (duplicatedChapterNos.length) {
      issues.push({ severity: 'error', area: 'chapters', message: `存在重复章节编号：${duplicatedChapterNos.join(', ')}。`, suggestion: '章节编号重复会导致导入结果不明确，请先修正。' });
    }

    (preview.chapters ?? []).forEach((chapter, index) => {
      const label = `第 ${chapter.chapterNo || index + 1} 章`;
      if (!Number.isFinite(Number(chapter.chapterNo)) || Number(chapter.chapterNo) <= 0) issues.push({ severity: 'error', area: 'chapters', message: `${label} 的 chapterNo 必须是正数。` });
      if (chapter.volumeNo && !validVolumeNos.has(Number(chapter.volumeNo))) {
        issues.push({ severity: 'warning', area: 'chapters', message: `${label} 引用了不存在的卷号 ${chapter.volumeNo}。`, suggestion: '请补充对应卷预览，或移除章节 volumeNo。' });
      }
      if (!chapter.title?.trim()) issues.push({ severity: 'warning', area: 'chapters', message: `${label} 缺少标题。` });
      if (!chapter.objective?.trim()) issues.push({ severity: 'warning', area: 'chapters', message: `${label} 缺少目标。` });
      if (!chapter.outline?.trim()) issues.push({ severity: 'warning', area: 'chapters', message: `${label} 缺少章节梗概。` });
    });

    return this.buildOutput(issues, preview);
  }

  /** 输出统计保持固定结构，便于前端按区域展示导入预览质量。 */
  private buildOutput(issues: ImportedAssetsValidationIssue[], preview?: ImportPreviewOutput): ValidateImportedAssetsOutput {
    const characters = preview?.characters ?? [];
    const volumes = preview?.volumes ?? [];
    const chapters = preview?.chapters ?? [];
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      stats: {
        characterCount: characters.length,
        lorebookCount: preview?.lorebookEntries?.length ?? 0,
        volumeCount: volumes.length,
        chapterCount: chapters.length,
        duplicatedCharacterNames: this.findDuplicatedStrings(characters.map((character) => character.name)),
        duplicatedVolumeNos: this.findDuplicatedNumbers(volumes.map((volume) => Number(volume.volumeNo))),
        duplicatedChapterNos: this.findDuplicatedNumbers(chapters.map((chapter) => Number(chapter.chapterNo))),
      },
      sourceRisks: preview?.risks ?? [],
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

  private findDuplicatedStrings(values: Array<string | undefined>): string[] {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    values.forEach((value) => {
      const normalized = value?.trim();
      if (!normalized) return;
      if (seen.has(normalized)) duplicated.add(normalized);
      seen.add(normalized);
    });
    return [...duplicated].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
}