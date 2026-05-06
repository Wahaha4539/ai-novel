import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';
import type { ImportBriefOutput } from './build-import-brief.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { ImportPreviewOutput } from './import-preview.types';

interface GenerateImportProjectProfilePreviewInput {
  analysis: SourceTextAnalysisOutput;
  importBrief?: ImportBriefOutput;
  instruction?: string;
  projectContext?: Record<string, unknown>;
}

export interface GenerateImportProjectProfilePreviewOutput {
  projectProfile: Omit<ImportPreviewOutput['projectProfile'], 'outline'>;
  risks: string[];
}

/**
 * 导入项目资料专用预览工具：只提取作品定位、卖点、简介和基调。
 * 不生成 projectProfile.outline，避免未选择大纲时顺手写入剧情大纲。
 */
@Injectable()
export class GenerateImportProjectProfilePreviewTool implements BaseTool<GenerateImportProjectProfilePreviewInput, GenerateImportProjectProfilePreviewOutput> {
  name = 'generate_import_project_profile_preview';
  description = '根据文档分析生成导入用项目资料预览，只输出 title/genre/theme/tone/logline/synopsis，不写库。';
  inputSchema = {
    type: 'object' as const,
    required: ['analysis'],
    additionalProperties: false,
    properties: {
      analysis: { type: 'object' as const },
      importBrief: { type: 'object' as const },
      instruction: { type: 'string' as const },
      projectContext: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['projectProfile', 'risks'],
    additionalProperties: false,
    properties: {
      projectProfile: { type: 'object' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Import project profile preview',
    description: this.description,
    whenToUse: ['用户选择导入项目资料、作品资料、书名、题材、主题、基调、卖点或简介，且已有 read_source_document/analyze_source_text 输出。'],
    whenNotToUse: ['需要生成剧情大纲、章节规划、角色、世界设定或写作规则时；这些目标应使用各自专用导入预览 Tool。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      analysis: { source: 'previous_step', description: '来自 analyze_source_text 的完整输出，优先使用 sourceText、paragraphs、keywords。' },
      importBrief: { source: 'previous_step', description: '可选，来自 build_import_brief 的全局简报，用于保持主题、主线、语气和风险一致。' },
      instruction: { source: 'user_message', description: '用户对项目定位、题材、简介、卖点和基调的原始要求。' },
      projectContext: { source: 'context', description: '可选项目上下文，用于避免覆盖已有项目标题或定位。' },
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
  executionTimeoutMs = 240_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateImportProjectProfilePreviewInput, context: ToolContext): Promise<GenerateImportProjectProfilePreviewOutput> {
    const analysis = this.normalizeAnalysis(args.analysis);
    const response = await this.llm.chatJson<GenerateImportProjectProfilePreviewOutput>(
      [
        {
          role: 'system',
          content: [
            'You are a novel import project-profile specialist. Return JSON only, no Markdown.',
            'Generate only the projectProfile target and risks.',
            'projectProfile may include title, genre, theme, tone, logline, synopsis.',
            'Do not output projectProfile.outline unless the outline target is selected; for this tool it is never selected.',
            'Focus on work positioning, market hook, premise, synopsis, genre, theme, and tone.',
            'Do not output characters, lorebookEntries, writingRules, volumes, or chapters.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User instruction: ${args.instruction ?? ''}`,
            `Import brief:\n${JSON.stringify(args.importBrief ?? {}, null, 2).slice(0, 6000)}`,
            `Keywords: ${analysis.keywords.join(', ')}`,
            `Paragraphs:\n${analysis.paragraphs.slice(0, 50).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
            `Project context:\n${JSON.stringify(args.projectContext ?? {}, null, 2).slice(0, 10000)}`,
            `Source document:\n${analysis.sourceText.slice(0, 30000)}`,
          ].join('\n\n'),
        },
      ],
      { appStep: 'agent_import_project_profile_preview', maxTokens: 4000, timeoutMs: 180_000, retries: 1, temperature: 0.2 },
    );

    recordToolLlmUsage(context, 'agent_import_project_profile_preview', response.result);
    return this.normalize(response.data, analysis.sourceText);
  }

  private normalize(data: unknown, sourceText: string): GenerateImportProjectProfilePreviewOutput {
    const record = this.asRecord(data);
    const profile = this.asRecord(record.projectProfile);
    return {
      projectProfile: {
        title: this.optionalScalarText(profile.title),
        genre: this.optionalScalarText(profile.genre),
        theme: this.optionalScalarText(profile.theme),
        tone: this.optionalScalarText(profile.tone),
        logline: this.optionalScalarText(profile.logline),
        synopsis: this.optionalScalarText(profile.synopsis) ?? this.fallbackSynopsis(sourceText),
      },
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

  private fallbackSynopsis(sourceText: string): string | undefined {
    const synopsis = sourceText.slice(0, 800).trim();
    return synopsis || undefined;
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
      for (const key of ['primary', 'title', 'name', 'value', 'summary', 'content', 'premise', 'message']) {
        const text = this.optionalScalarText(record[key]);
        if (text) return text;
      }
      return JSON.stringify(value);
    }
    return undefined;
  }
}
