import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { assertNoUnexpectedImportTargets, assertRisksArray, buildImportPreviewRepairMessages, requiredImportText, shouldRepairImportPreviewOutput } from './import-preview-repair';
import { IMPORT_ASSET_TYPES, ImportAssetType, normalizeImportAssetTypes } from './import-preview.types';
import { normalizeWithLlmRepair } from './structured-output-repair';

export interface ImportBriefOutput {
  requestedAssetTypes: ImportAssetType[];
  coreSettings: string[];
  mainline: string;
  theme?: string;
  keyCharacters: string[];
  worldRules: string[];
  tone?: string;
  risks: string[];
}

interface BuildImportBriefInput {
  analysis: SourceTextAnalysisOutput;
  instruction?: string;
  requestedAssetTypes?: unknown;
  projectContext?: Record<string, unknown>;
}

/**
 * 分目标导入前的全局简报：只提炼共同事实和风险，供后续目标 Tool 参考。
 * 它不输出可写入资产，也不写库。
 */
@Injectable()
export class BuildImportBriefTool implements BaseTool<BuildImportBriefInput, ImportBriefOutput> {
  private readonly logger = new StructuredLogger(BuildImportBriefTool.name);
  name = 'build_import_brief';
  description = '在分目标导入预览前生成全局只读导入简报，提炼核心设定、主线、主题、关键人物、世界规则、语气和风险。';
  inputSchema = {
    type: 'object' as const,
    required: ['analysis'],
    additionalProperties: false,
    properties: {
      analysis: { type: 'object' as const },
      instruction: { type: 'string' as const },
      requestedAssetTypes: { type: 'array' as const, items: { type: 'string' as const, enum: IMPORT_ASSET_TYPES } },
      projectContext: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['requestedAssetTypes', 'coreSettings', 'mainline', 'keyCharacters', 'worldRules', 'risks'],
    additionalProperties: false,
    properties: {
      requestedAssetTypes: { type: 'array' as const, items: { type: 'string' as const, enum: IMPORT_ASSET_TYPES } },
      coreSettings: { type: 'array' as const, items: { type: 'string' as const } },
      mainline: { type: 'string' as const },
      theme: { type: 'string' as const },
      keyCharacters: { type: 'array' as const, items: { type: 'string' as const } },
      worldRules: { type: 'array' as const, items: { type: 'string' as const } },
      tone: { type: 'string' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Import brief builder',
    description: this.description,
    whenToUse: ['分目标导入预览中，在 generate_import_*_preview 专用 Tool 之前，为多个目标产物提供共同源文档理解。'],
    whenNotToUse: ['需要直接生成可写入资产时；本 Tool 只输出只读简报，不替代 build_import_preview 或专用目标预览 Tool。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      analysis: { source: 'previous_step', description: '来自 analyze_source_text 的完整输出。' },
      instruction: { source: 'user_message', description: '用户本次导入目标和范围说明。' },
      requestedAssetTypes: { source: 'context', description: '本次结构化目标产物范围；必须保持与用户选择一致。' },
      projectContext: { source: 'context', description: '可选项目上下文，用于识别已有设定或风险。' },
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
  executionTimeoutMs = DEFAULT_LLM_TIMEOUT_MS * 3 + 65_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: BuildImportBriefInput, context: ToolContext): Promise<ImportBriefOutput> {
    const analysis = this.normalizeAnalysis(args.analysis);
    const requestedAssetTypes = normalizeImportAssetTypes(args.requestedAssetTypes, args.instruction);
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成导入简报',
      progressCurrent: 0,
      progressTotal: 1,
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS * 2 + 5_000,
    });
    const response = await this.llm.chatJson<unknown>(
      [
        {
          role: 'system',
          content: [
            'You are a novel import briefing analyst. Return JSON only, no Markdown.',
            'Create a read-only global brief for later target-specific import preview tools.',
            'Do not generate import assets, database rows, chapters, characters arrays, lorebook entries, or writing rules.',
            'Focus on shared evidence: core settings, mainline, theme, key characters, world rules, tone, and risks.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User instruction: ${args.instruction ?? ''}`,
            `Requested asset types: ${requestedAssetTypes.join(', ')}`,
            `Keywords: ${analysis.keywords.join(', ')}`,
            `Paragraphs:\n${analysis.paragraphs.slice(0, 60).map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
            `Project context:\n${JSON.stringify(args.projectContext ?? {}, null, 2).slice(0, 8000)}`,
            `Source document:\n${analysis.sourceText.slice(0, 32000)}`,
          ].join('\n\n'),
        },
      ],
      { appStep: 'agent_import_brief', maxTokens: 3500, timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 1, temperature: 0.1 },
    );

    recordToolLlmUsage(context, 'agent_import_brief', response.result);
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验导入简报', progressCurrent: 1, progressTotal: 1 });
    return normalizeWithLlmRepair({
      toolName: this.name,
      loggerEventPrefix: 'import_brief',
      llm: this.llm,
      context,
      data: response.data,
      normalize: (data) => this.normalize(data, requestedAssetTypes),
      shouldRepair: ({ data, error }) => shouldRepairImportPreviewOutput({
        data,
        error,
        toolName: this.name,
        targetKeys: ['coreSettings', 'mainline', 'theme', 'keyCharacters', 'worldRules', 'tone', 'risks'],
        repairableAliases: ['settings', 'summary', 'characters', 'rules'],
        localFieldPattern: /mainline/,
      }),
      buildRepairMessages: ({ invalidOutput, validationError }) => buildImportPreviewRepairMessages({
        toolName: this.name,
        targetDescription: 'read-only import brief fields only; no import assets',
        validationError,
        invalidOutput,
        instruction: args.instruction,
        sourceText: analysis.sourceText,
        allowedTopLevelKeys: ['requestedAssetTypes', 'coreSettings', 'mainline', 'theme', 'keyCharacters', 'worldRules', 'tone', 'risks'],
        repairableAliases: ['settings', 'summary', 'characters', 'rules'],
        requestedAssetTypes,
      }),
      progress: {
        phaseMessage: '正在修复导入简报结构',
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
      },
      llmOptions: {
        appStep: 'agent_import_brief',
        maxTokens: 3500,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        temperature: 0.1,
      },
      maxRepairAttempts: 1,
      initialModel: response.result.model,
      logger: this.logger,
    });
  }

  private normalize(data: unknown, requestedAssetTypes: ImportAssetType[]): ImportBriefOutput {
    assertNoUnexpectedImportTargets(data, ['characters'], this.name);
    const record = this.asRecord(data);
    assertRisksArray(record.risks);
    return {
      requestedAssetTypes,
      coreSettings: this.stringArray(record.coreSettings ?? record.settings).slice(0, 16),
      mainline: requiredImportText(record.mainline, 'mainline', (value) => this.optionalScalarText(value)),
      theme: this.optionalScalarText(record.theme),
      keyCharacters: this.stringArray(record.keyCharacters ?? record.characters).slice(0, 20),
      worldRules: this.stringArray(record.worldRules ?? record.rules).slice(0, 20),
      tone: this.optionalScalarText(record.tone),
      risks: this.stringArray(record.risks),
    };
  }

  private normalizeAnalysis(value: SourceTextAnalysisOutput): SourceTextAnalysisOutput {
    const record = this.asRecord(value);
    const sourceText = this.scalarText(record.sourceText);
    const paragraphs = this.stringArray(record.paragraphs).slice(0, 100);
    const keywords = this.stringArray(record.keywords).slice(0, 40);
    return {
      sourceText,
      length: Number(record.length) || sourceText.length,
      paragraphs: paragraphs.length ? paragraphs : sourceText.split(/\n{1,}|。|；|;/).map((item) => item.trim()).filter(Boolean).slice(0, 100),
      keywords,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private stringArray(value: unknown): string[] {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return items.map((item) => this.optionalScalarText(item)).filter((item): item is string => Boolean(item));
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
      for (const key of ['primary', 'title', 'name', 'value', 'text', 'summary', 'description', 'content', 'message', 'rule', 'goal']) {
        const text = this.optionalScalarText(record[key]);
        if (text) return text;
      }
      return JSON.stringify(value);
    }
    return undefined;
  }
}
