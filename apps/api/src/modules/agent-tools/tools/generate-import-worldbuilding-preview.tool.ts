import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';
import type { ImportBriefOutput } from './build-import-brief.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { ImportPreviewOutput } from './import-preview.types';

interface GenerateImportWorldbuildingPreviewInput {
  analysis: SourceTextAnalysisOutput;
  importBrief?: ImportBriefOutput;
  instruction?: string;
  projectContext?: Record<string, unknown>;
  maxEntries?: number;
}

const IMPORT_WORLDBUILDING_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const IMPORT_WORLDBUILDING_PREVIEW_LLM_RETRIES = 1;
const IMPORT_WORLDBUILDING_PREVIEW_PHASE_TIMEOUT_MS = IMPORT_WORLDBUILDING_PREVIEW_LLM_TIMEOUT_MS * (IMPORT_WORLDBUILDING_PREVIEW_LLM_RETRIES + 1) + 5_000;

export interface GenerateImportWorldbuildingPreviewOutput {
  lorebookEntries: ImportPreviewOutput['lorebookEntries'];
  risks: string[];
}

/**
 * 导入世界设定专用预览工具：只抽取地点、势力、规则、历史和能力体系设定。
 * 不输出角色、人设、写作规则或章节大纲，避免未选择目标混入设定库候选。
 */
@Injectable()
export class GenerateImportWorldbuildingPreviewTool implements BaseTool<GenerateImportWorldbuildingPreviewInput, GenerateImportWorldbuildingPreviewOutput> {
  name = 'generate_import_worldbuilding_preview';
  description = '根据文档分析生成导入用世界设定预览，只输出 lorebookEntries，不写库。';
  inputSchema = {
    type: 'object' as const,
    required: ['analysis'],
    additionalProperties: false,
    properties: {
      analysis: { type: 'object' as const },
      importBrief: { type: 'object' as const },
      instruction: { type: 'string' as const },
      projectContext: { type: 'object' as const },
      maxEntries: { type: 'number' as const, minimum: 1, maximum: 50 },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['lorebookEntries', 'risks'],
    additionalProperties: false,
    properties: {
      lorebookEntries: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Import worldbuilding preview',
    description: this.description,
    whenToUse: ['用户选择导入世界观、背景设定、地点、势力、规则、历史或能力体系，且已有 read_source_document/analyze_source_text 输出。'],
    whenNotToUse: ['需要生成角色人设、剧情大纲或写作规则时；这些目标应使用各自专用导入预览 Tool。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      analysis: { source: 'previous_step', description: '来自 analyze_source_text 的完整输出，优先使用 sourceText、paragraphs、keywords。' },
      importBrief: { source: 'previous_step', description: '可选，来自 build_import_brief 的全局简报，用于保持核心设定、主题、关键人物和世界规则一致。' },
      instruction: { source: 'user_message', description: '用户对世界设定范围、禁改设定、关注地点/势力/规则的原始要求。' },
      projectContext: { source: 'context', description: '可选项目上下文，尤其是现有 lorebook 和 locked facts，用于避免覆盖已确认设定。' },
      maxEntries: { source: 'user_message', description: '用户明确限制设定条目数时传入。' },
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
  executionTimeoutMs = IMPORT_WORLDBUILDING_PREVIEW_PHASE_TIMEOUT_MS + 60_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateImportWorldbuildingPreviewInput, context: ToolContext): Promise<GenerateImportWorldbuildingPreviewOutput> {
    const analysis = this.normalizeAnalysis(args.analysis);
    const maxEntries = this.normalizeMaxEntries(args.maxEntries);
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成导入世界观预览',
      progressCurrent: 0,
      progressTotal: maxEntries,
      timeoutMs: IMPORT_WORLDBUILDING_PREVIEW_PHASE_TIMEOUT_MS,
    });
    const response = await this.llm.chatJson<GenerateImportWorldbuildingPreviewOutput>(
      [
        {
          role: 'system',
          content: [
            'You are a novel import worldbuilding specialist. Return JSON only, no Markdown.',
            'Generate only the worldbuilding target: lorebookEntries and risks.',
            'Each lorebook entry must include title, entryType, content, summary, tags.',
            'Focus on locations, factions, rules, history, power systems, and compatibility with locked facts.',
            'Read projectContext for existing lorebook entries and locked facts; do not overwrite or contradict them.',
            'Do not output characters, writingRules, volumes, chapters, or project profile fields.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User instruction: ${args.instruction ?? ''}`,
            `Max entries: ${maxEntries}`,
            `Import brief:\n${JSON.stringify(args.importBrief ?? {}, null, 2).slice(0, 6000)}`,
            `Keywords: ${analysis.keywords.join(', ')}`,
            `Paragraphs:\n${analysis.paragraphs.slice(0, 50).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
            `Project context:\n${JSON.stringify(args.projectContext ?? {}, null, 2).slice(0, 10000)}`,
            `Source document:\n${analysis.sourceText.slice(0, 30000)}`,
          ].join('\n\n'),
        },
      ],
      { appStep: 'agent_import_worldbuilding_preview', maxTokens: Math.min(8000, maxEntries * 520 + 1600), timeoutMs: IMPORT_WORLDBUILDING_PREVIEW_LLM_TIMEOUT_MS, retries: IMPORT_WORLDBUILDING_PREVIEW_LLM_RETRIES, temperature: 0.2 },
    );

    recordToolLlmUsage(context, 'agent_import_worldbuilding_preview', response.result);
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验导入世界观预览', progressCurrent: maxEntries, progressTotal: maxEntries });
    return this.normalize(response.data, maxEntries);
  }

  private normalize(data: unknown, maxEntries: number): GenerateImportWorldbuildingPreviewOutput {
    const record = this.asRecord(data);
    return {
      lorebookEntries: this.arrayValue(record.lorebookEntries).slice(0, maxEntries).map((item, index) => {
        const entry = this.asRecord(item);
        const summary = this.optionalScalarText(entry.summary);
        return {
          title: this.scalarText(entry.title, `世界设定 ${index + 1}`),
          entryType: this.scalarText(entry.entryType, 'setting'),
          content: this.scalarText(entry.content, summary ?? '待补充设定内容'),
          summary,
          tags: this.stringArray(entry.tags),
        };
      }).filter((item) => item.title && item.content),
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

  private normalizeMaxEntries(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.min(50, Math.max(1, Math.round(value)));
    return 12;
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
      for (const key of ['primary', 'title', 'name', 'value', 'summary', 'content', 'detail', 'message']) {
        const text = this.optionalScalarText(record[key]);
        if (text) return text;
      }
      return JSON.stringify(value);
    }
    return undefined;
  }
}
