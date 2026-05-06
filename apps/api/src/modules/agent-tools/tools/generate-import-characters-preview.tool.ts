import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';
import type { ImportBriefOutput } from './build-import-brief.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { ImportPreviewOutput } from './import-preview.types';

interface GenerateImportCharactersPreviewInput {
  analysis: SourceTextAnalysisOutput;
  importBrief?: ImportBriefOutput;
  instruction?: string;
  projectContext?: Record<string, unknown>;
}

export interface GenerateImportCharactersPreviewOutput {
  characters: ImportPreviewOutput['characters'];
  risks: string[];
}

/**
 * 导入角色专用预览工具：只抽取角色、人设、动机、背景与人物弧光线索。
 * 不输出世界设定、写作规则或大纲结构，避免目标产物互相污染。
 */
@Injectable()
export class GenerateImportCharactersPreviewTool implements BaseTool<GenerateImportCharactersPreviewInput, GenerateImportCharactersPreviewOutput> {
  name = 'generate_import_characters_preview';
  description = '根据文档分析生成导入用角色与人设预览，只输出 characters，不写库。';
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
    required: ['characters', 'risks'],
    additionalProperties: false,
    properties: {
      characters: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Import characters preview',
    description: this.description,
    whenToUse: ['用户选择导入角色、人设、人物关系或人物弧光，且已有 read_source_document/analyze_source_text 输出。'],
    whenNotToUse: ['需要生成世界设定、地点规则、剧情大纲或写作规则时；这些目标应使用各自专用导入预览 Tool。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      analysis: { source: 'previous_step', description: '来自 analyze_source_text 的完整输出，优先使用 sourceText、paragraphs、keywords。' },
      importBrief: { source: 'previous_step', description: '可选，来自 build_import_brief 的全局简报，用于保持主题、主线、关键人物和世界规则一致。' },
      instruction: { source: 'user_message', description: '用户对角色范围、主配角、关系重点、禁写内容的原始要求。' },
      projectContext: { source: 'context', description: '可选项目上下文，用于避免与已有角色重名或人设冲突。' },
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

  async run(args: GenerateImportCharactersPreviewInput, context: ToolContext): Promise<GenerateImportCharactersPreviewOutput> {
    const analysis = this.normalizeAnalysis(args.analysis);
    const response = await this.llm.chatJson<GenerateImportCharactersPreviewOutput>(
      [
        {
          role: 'system',
          content: [
            'You are a novel import character specialist. Return JSON only, no Markdown.',
            'Generate only the characters target: characters and risks.',
            'Each character must include name, roleType, personalityCore, motivation, backstory.',
            'Focus on character motivation, relationships, character arc, behavior constraints, and evidence from the source document.',
            'Do not output lorebookEntries, worldbuilding, writingRules, volumes, chapters, or project profile fields.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User instruction: ${args.instruction ?? ''}`,
            `Import brief:\n${JSON.stringify(args.importBrief ?? {}, null, 2).slice(0, 6000)}`,
            `Keywords: ${analysis.keywords.join(', ')}`,
            `Paragraphs:\n${analysis.paragraphs.slice(0, 50).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
            `Project context:\n${JSON.stringify(args.projectContext ?? {}, null, 2).slice(0, 8000)}`,
            `Source document:\n${analysis.sourceText.slice(0, 30000)}`,
          ].join('\n\n'),
        },
      ],
      { appStep: 'agent_import_characters_preview', maxTokens: 7000, timeoutMs: 220_000, retries: 1, temperature: 0.2 },
    );

    recordToolLlmUsage(context, 'agent_import_characters_preview', response.result);
    return this.normalize(response.data);
  }

  private normalize(data: unknown): GenerateImportCharactersPreviewOutput {
    const record = this.asRecord(data);
    return {
      characters: this.arrayValue(record.characters).slice(0, 40).map((item) => {
        const character = this.asRecord(item);
        return {
          name: this.scalarText(character.name),
          roleType: this.optionalScalarText(character.roleType),
          personalityCore: this.optionalScalarText(character.personalityCore),
          motivation: this.optionalScalarText(character.motivation),
          backstory: this.optionalScalarText(character.backstory),
        };
      }).filter((item) => item.name),
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
      for (const key of ['primary', 'title', 'name', 'value', 'summary', 'core', 'goal', 'reason', 'history', 'message']) {
        const text = this.optionalScalarText(record[key]);
        if (text) return text;
      }
      return JSON.stringify(value);
    }
    return undefined;
  }
}
