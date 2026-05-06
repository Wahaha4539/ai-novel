import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';
import type { ImportBriefOutput } from './build-import-brief.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { ImportPreviewOutput } from './import-preview.types';

interface GenerateImportWritingRulesPreviewInput {
  analysis: SourceTextAnalysisOutput;
  importBrief?: ImportBriefOutput;
  instruction?: string;
  projectContext?: Record<string, unknown>;
  maxRules?: number;
}

const IMPORT_WRITING_RULES_PREVIEW_LLM_TIMEOUT_MS = 220_000;
const IMPORT_WRITING_RULES_PREVIEW_LLM_RETRIES = 1;
const IMPORT_WRITING_RULES_PREVIEW_PHASE_TIMEOUT_MS = IMPORT_WRITING_RULES_PREVIEW_LLM_TIMEOUT_MS * (IMPORT_WRITING_RULES_PREVIEW_LLM_RETRIES + 1) + 5_000;

export interface GenerateImportWritingRulesPreviewOutput {
  writingRules: ImportPreviewOutput['writingRules'];
  risks: string[];
}

/**
 * 导入写作规则专用预览工具：只抽取文风、视角、人称、禁写、节奏和结构规范。
 * 不输出世界观 lorebook 条目，避免把创作约束误写成设定。
 */
@Injectable()
export class GenerateImportWritingRulesPreviewTool implements BaseTool<GenerateImportWritingRulesPreviewInput, GenerateImportWritingRulesPreviewOutput> {
  name = 'generate_import_writing_rules_preview';
  description = '根据文档分析生成导入用写作规则预览，只输出 writingRules，不写库。';
  inputSchema = {
    type: 'object' as const,
    required: ['analysis'],
    additionalProperties: false,
    properties: {
      analysis: { type: 'object' as const },
      importBrief: { type: 'object' as const },
      instruction: { type: 'string' as const },
      projectContext: { type: 'object' as const },
      maxRules: { type: 'number' as const, minimum: 1, maximum: 50 },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['writingRules', 'risks'],
    additionalProperties: false,
    properties: {
      writingRules: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Import writing rules preview',
    description: this.description,
    whenToUse: ['用户选择导入写作规则、创作规范、视角、人称、文风、禁写、节奏或结构约束，且已有 read_source_document/analyze_source_text 输出。'],
    whenNotToUse: ['需要生成世界观规则、地点、势力、剧情大纲或角色人设时；这些目标应使用各自专用导入预览 Tool。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      analysis: { source: 'previous_step', description: '来自 analyze_source_text 的完整输出，优先使用 sourceText、paragraphs、keywords。' },
      importBrief: { source: 'previous_step', description: '可选，来自 build_import_brief 的全局简报，用于保持主题、语气、世界规则和风险一致。' },
      instruction: { source: 'user_message', description: '用户对写作规则范围、禁写内容、风格和适用章节的原始要求。' },
      projectContext: { source: 'context', description: '可选项目上下文，用于避免和已有写作规则冲突。' },
      maxRules: { source: 'user_message', description: '用户明确限制规则条数时传入。' },
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
  executionTimeoutMs = IMPORT_WRITING_RULES_PREVIEW_PHASE_TIMEOUT_MS + 60_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateImportWritingRulesPreviewInput, context: ToolContext): Promise<GenerateImportWritingRulesPreviewOutput> {
    const analysis = this.normalizeAnalysis(args.analysis);
    const maxRules = this.normalizeMaxRules(args.maxRules);
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成导入写作规则预览',
      progressCurrent: 0,
      progressTotal: maxRules,
      timeoutMs: IMPORT_WRITING_RULES_PREVIEW_PHASE_TIMEOUT_MS,
    });
    const response = await this.llm.chatJson<GenerateImportWritingRulesPreviewOutput>(
      [
        {
          role: 'system',
          content: [
            'You are a novel import writing-rules specialist. Return JSON only, no Markdown.',
            'Generate only the writingRules target: writingRules and risks.',
            'Each writing rule must include title, ruleType, content, severity, optional appliesFromChapterNo/appliesToChapterNo/entityType/entityRef/status.',
            'Focus on prose style, POV, tense/person, forbidden wording, pacing, structure, and consistency constraints.',
            'Do not put worldbuilding facts, locations, factions, power systems, or lore rules into lorebookEntries.',
            'Do not output lorebookEntries, characters, volumes, chapters, or project profile fields.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User instruction: ${args.instruction ?? ''}`,
            `Max rules: ${maxRules}`,
            `Import brief:\n${JSON.stringify(args.importBrief ?? {}, null, 2).slice(0, 6000)}`,
            `Keywords: ${analysis.keywords.join(', ')}`,
            `Paragraphs:\n${analysis.paragraphs.slice(0, 50).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
            `Project context:\n${JSON.stringify(args.projectContext ?? {}, null, 2).slice(0, 10000)}`,
            `Source document:\n${analysis.sourceText.slice(0, 30000)}`,
          ].join('\n\n'),
        },
      ],
      { appStep: 'agent_import_writing_rules_preview', maxTokens: Math.min(8000, maxRules * 440 + 1600), timeoutMs: IMPORT_WRITING_RULES_PREVIEW_LLM_TIMEOUT_MS, retries: IMPORT_WRITING_RULES_PREVIEW_LLM_RETRIES, temperature: 0.2 },
    );

    recordToolLlmUsage(context, 'agent_import_writing_rules_preview', response.result);
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验导入写作规则预览', progressCurrent: maxRules, progressTotal: maxRules });
    return this.normalize(response.data, maxRules);
  }

  private normalize(data: unknown, maxRules: number): GenerateImportWritingRulesPreviewOutput {
    const record = this.asRecord(data);
    return {
      writingRules: this.arrayValue(record.writingRules).slice(0, maxRules).map((item, index) => {
        const rule = this.asRecord(item);
        return {
          title: this.scalarText(rule.title, `写作规则 ${index + 1}`),
          ruleType: this.scalarText(rule.ruleType, 'style'),
          content: this.scalarText(rule.content, '待补充写作约束'),
          severity: this.normalizeSeverity(rule.severity),
          appliesFromChapterNo: this.optionalPositiveInteger(rule.appliesFromChapterNo),
          appliesToChapterNo: this.optionalPositiveInteger(rule.appliesToChapterNo),
          entityType: this.optionalScalarText(rule.entityType),
          entityRef: this.optionalScalarText(rule.entityRef),
          status: this.optionalScalarText(rule.status) ?? 'active',
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

  private normalizeMaxRules(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.min(50, Math.max(1, Math.round(value)));
    return 12;
  }

  private normalizeSeverity(value: unknown): 'info' | 'warning' | 'error' {
    const text = this.optionalScalarText(value)?.toLowerCase();
    if (text === 'error' || text === 'fatal' || text === 'blocker') return 'error';
    if (text === 'warning' || text === 'warn') return 'warning';
    return 'info';
  }

  private optionalPositiveInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const normalized = Math.round(value);
    return normalized > 0 ? normalized : undefined;
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
      for (const key of ['primary', 'title', 'name', 'value', 'summary', 'content', 'rule', 'message']) {
        const text = this.optionalScalarText(record[key]);
        if (text) return text;
      }
      return JSON.stringify(value);
    }
    return undefined;
  }
}
