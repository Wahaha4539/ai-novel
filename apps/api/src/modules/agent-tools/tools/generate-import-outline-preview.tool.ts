import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';
import type { ImportBriefOutput } from './build-import-brief.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { ImportPreviewOutput } from './import-preview.types';

interface GenerateImportOutlinePreviewInput {
  analysis: SourceTextAnalysisOutput;
  importBrief?: ImportBriefOutput;
  instruction?: string;
  projectContext?: Record<string, unknown>;
  chapterCount?: number;
}

const IMPORT_OUTLINE_PREVIEW_LLM_TIMEOUT_MS = 220_000;
const IMPORT_OUTLINE_PREVIEW_LLM_RETRIES = 1;
const IMPORT_OUTLINE_PREVIEW_PHASE_TIMEOUT_MS = IMPORT_OUTLINE_PREVIEW_LLM_TIMEOUT_MS * (IMPORT_OUTLINE_PREVIEW_LLM_RETRIES + 1) + 5_000;

export interface GenerateImportOutlinePreviewOutput {
  projectProfile: Pick<ImportPreviewOutput['projectProfile'], 'outline'>;
  volumes: ImportPreviewOutput['volumes'];
  chapters: ImportPreviewOutput['chapters'];
  risks: string[];
}

/**
 * 导入大纲专用预览工具：只根据源文档分析生成主线、卷结构和章节规划。
 * 不输出角色、世界设定或写作规则，避免把未选择目标混进大纲字段。
 */
@Injectable()
export class GenerateImportOutlinePreviewTool implements BaseTool<GenerateImportOutlinePreviewInput, GenerateImportOutlinePreviewOutput> {
  name = 'generate_import_outline_preview';
  description = '根据文档分析和项目上下文生成导入用剧情大纲预览，只输出主线、卷和章节，不写库。';
  inputSchema = {
    type: 'object' as const,
    required: ['analysis'],
    additionalProperties: false,
    properties: {
      analysis: { type: 'object' as const },
      importBrief: { type: 'object' as const },
      instruction: { type: 'string' as const },
      projectContext: { type: 'object' as const },
      chapterCount: { type: 'number' as const, minimum: 1, maximum: 80 },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['projectProfile', 'volumes', 'chapters', 'risks'],
    additionalProperties: false,
    properties: {
      projectProfile: { type: 'object' as const, properties: { outline: { type: 'string' as const } } },
      volumes: { type: 'array' as const },
      chapters: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Import outline preview',
    description: this.description,
    whenToUse: ['用户选择导入剧情大纲/卷章结构/章节规划，且已有 read_source_document/analyze_source_text 输出。'],
    whenNotToUse: ['需要生成角色、人设、世界设定或写作规则时；这些目标应使用各自专用导入预览 Tool。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      analysis: { source: 'previous_step', description: '来自 analyze_source_text 的完整输出，优先使用 sourceText、paragraphs、keywords。' },
      importBrief: { source: 'previous_step', description: '可选，来自 build_import_brief 的全局简报，用于保持主线、主题、关键人物和世界规则一致。' },
      instruction: { source: 'user_message', description: '用户对大纲拆分、章节数量、重点主线的原始要求。' },
      projectContext: { source: 'context', description: '可选项目上下文，用于避免与现有项目标题、题材、已规划章节冲突。' },
      chapterCount: { source: 'user_message', description: '用户明确指定章节数时传入；未指定时由工具按文档复杂度保守生成。' },
    },
    allowedModes: ['plan', 'act'],
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: [],
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = IMPORT_OUTLINE_PREVIEW_PHASE_TIMEOUT_MS + 60_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateImportOutlinePreviewInput, context: ToolContext): Promise<GenerateImportOutlinePreviewOutput> {
    const analysis = this.normalizeAnalysis(args.analysis);
    const chapterCount = this.normalizeChapterCount(args.chapterCount, analysis);
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成导入大纲预览',
      progressCurrent: 0,
      progressTotal: chapterCount,
      timeoutMs: IMPORT_OUTLINE_PREVIEW_PHASE_TIMEOUT_MS,
    });
    const response = await this.llm.chatJson<GenerateImportOutlinePreviewOutput>(
      [
        {
          role: 'system',
          content: [
            'You are a novel import outline specialist. Return JSON only, no Markdown.',
            'Generate only the outline target: projectProfile.outline, volumes, chapters, risks.',
            'Do not output characters, lorebookEntries, writingRules, project title, synopsis, or other unselected assets.',
            'Focus on mainline progression, volume/chapter structure, escalating conflict, chapter hooks, and import risks.',
            'Each chapter must include chapterNo, optional volumeNo, title, objective, conflict, hook, outline, expectedWordCount.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User instruction: ${args.instruction ?? ''}`,
            `Target chapter count: ${chapterCount}`,
            `Import brief:\n${JSON.stringify(args.importBrief ?? {}, null, 2).slice(0, 6000)}`,
            `Keywords: ${analysis.keywords.join(', ')}`,
            `Paragraphs:\n${analysis.paragraphs.slice(0, 40).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
            `Project context:\n${JSON.stringify(args.projectContext ?? {}, null, 2).slice(0, 8000)}`,
            `Source document:\n${analysis.sourceText.slice(0, 28000)}`,
          ].join('\n\n'),
        },
      ],
      { appStep: 'agent_import_outline_preview', maxTokens: Math.min(9000, chapterCount * 360 + 1800), timeoutMs: IMPORT_OUTLINE_PREVIEW_LLM_TIMEOUT_MS, retries: IMPORT_OUTLINE_PREVIEW_LLM_RETRIES, temperature: 0.2 },
    );

    recordToolLlmUsage(context, 'agent_import_outline_preview', response.result);
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验导入大纲预览', progressCurrent: chapterCount, progressTotal: chapterCount });
    return this.normalize(response.data, chapterCount, analysis.sourceText);
  }

  private normalize(data: unknown, chapterCount: number, sourceText: string): GenerateImportOutlinePreviewOutput {
    const record = this.asRecord(data);
    const projectProfile = this.asRecord(record.projectProfile);
    const outline = this.optionalScalarText(projectProfile.outline) ?? this.optionalScalarText(record.outline) ?? this.fallbackOutline(sourceText);
    const volumes = this.normalizeVolumes(record.volumes ?? record.volume, chapterCount);
    const chapters = this.normalizeChapters(record.chapters, chapterCount, volumes[0]?.volumeNo);
    return {
      projectProfile: { outline },
      volumes: this.ensureVolumeChapterCounts(volumes, chapters),
      chapters,
      risks: this.stringArray(record.risks),
    };
  }

  private normalizeAnalysis(value: SourceTextAnalysisOutput): SourceTextAnalysisOutput {
    const record = this.asRecord(value);
    const sourceText = this.scalarText(record.sourceText);
    const paragraphs = this.stringArray(record.paragraphs).slice(0, 80);
    const keywords = this.stringArray(record.keywords).slice(0, 30);
    return {
      sourceText,
      length: Number(record.length) || sourceText.length,
      paragraphs: paragraphs.length ? paragraphs : sourceText.split(/\n{1,}|。|；|;/).map((item) => item.trim()).filter(Boolean).slice(0, 80),
      keywords,
    };
  }

  private normalizeChapterCount(value: unknown, analysis: SourceTextAnalysisOutput): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.min(80, Math.max(1, Math.round(value)));
    const estimated = Math.ceil(Math.max(analysis.paragraphs.length, analysis.length / 1800));
    return Math.min(30, Math.max(6, estimated));
  }

  private normalizeVolumes(value: unknown, chapterCount: number): ImportPreviewOutput['volumes'] {
    const rawItems = Array.isArray(value) ? value : Object.keys(this.asRecord(value)).length ? [value] : [];
    const volumes = rawItems.slice(0, 12).map((item, index) => {
      const record = this.asRecord(item);
      return {
        volumeNo: this.positiveInteger(record.volumeNo, index + 1),
        title: this.scalarText(record.title, `第 ${index + 1} 卷`),
        synopsis: this.optionalScalarText(record.synopsis),
        objective: this.optionalScalarText(record.objective),
        chapterCount: this.optionalPositiveInteger(record.chapterCount),
      };
    });
    return volumes.length ? volumes : [{ volumeNo: 1, title: '第 1 卷', synopsis: undefined, objective: undefined, chapterCount }];
  }

  private normalizeChapters(value: unknown, chapterCount: number, fallbackVolumeNo?: number): ImportPreviewOutput['chapters'] {
    return this.arrayValue(value).slice(0, chapterCount).map((item, index) => {
      const record = this.asRecord(item);
      return {
        chapterNo: this.positiveInteger(record.chapterNo, index + 1),
        volumeNo: this.optionalPositiveInteger(record.volumeNo) ?? fallbackVolumeNo,
        title: this.scalarText(record.title, `第 ${index + 1} 章`),
        objective: this.optionalScalarText(record.objective),
        conflict: this.optionalScalarText(record.conflict),
        hook: this.optionalScalarText(record.hook),
        outline: this.optionalScalarText(record.outline) ?? this.optionalScalarText(record.objective),
        expectedWordCount: this.optionalPositiveInteger(record.expectedWordCount),
      };
    });
  }

  private ensureVolumeChapterCounts(volumes: ImportPreviewOutput['volumes'], chapters: ImportPreviewOutput['chapters']): ImportPreviewOutput['volumes'] {
    const counts = new Map<number, number>();
    chapters.forEach((chapter) => {
      const volumeNo = chapter.volumeNo ?? volumes[0]?.volumeNo ?? 1;
      counts.set(volumeNo, (counts.get(volumeNo) ?? 0) + 1);
    });
    return volumes.map((volume) => ({ ...volume, chapterCount: volume.chapterCount ?? counts.get(volume.volumeNo) ?? 0 }));
  }

  private fallbackOutline(sourceText: string): string {
    return sourceText.slice(0, 500).trim() || '根据导入文档整理主线推进、卷章结构与章节钩子。';
  }

  private arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => this.optionalScalarText(item)).filter((item): item is string => Boolean(item))
      : [];
  }

  private scalarText(value: unknown, fallback = ''): string {
    return this.optionalScalarText(value) ?? fallback;
  }

  private optionalScalarText(value: unknown): string | undefined {
    if (typeof value === 'string') return value.trim() || undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map((item) => this.optionalScalarText(item)).filter(Boolean).join('、') || undefined;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['primary', 'title', 'name', 'value', 'summary', 'goal', 'objective', 'pressure', 'mainline', 'message']) {
        const text = this.optionalScalarText(record[key]);
        if (text) return text;
      }
      return JSON.stringify(value);
    }
    return undefined;
  }

  private positiveInteger(value: unknown, fallback: number): number {
    return this.optionalPositiveInteger(value) ?? fallback;
  }

  private optionalPositiveInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const normalized = Math.round(value);
    return normalized > 0 ? normalized : undefined;
  }
}
