import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';
import { filterImportPreviewByAssetTypes, ImportAssetType, IMPORT_ASSET_TYPES, ImportPreviewOutput, normalizeImportAssetTypes } from './import-preview.types';

interface BuildImportPreviewInput {
  analysis?: SourceTextAnalysisOutput;
  instruction?: string;
  requestedAssetTypes?: unknown;
}

@Injectable()
export class BuildImportPreviewTool implements BaseTool<BuildImportPreviewInput, ImportPreviewOutput> {
  name = 'build_import_preview';
  description = '根据文档分析结果和用户指定范围生成导入预览；导入只是输入来源，不代表固定生成全套资产。';
  inputSchema = {
    type: 'object' as const,
    properties: {
      analysis: { type: 'object' as const },
      instruction: { type: 'string' as const },
      requestedAssetTypes: {
        type: 'array' as const,
        items: { type: 'string' as const, enum: IMPORT_ASSET_TYPES },
      },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['projectProfile', 'characters', 'lorebookEntries', 'writingRules', 'volumes', 'chapters', 'risks'],
    properties: {
      requestedAssetTypes: { type: 'array' as const, items: { type: 'string' as const, enum: IMPORT_ASSET_TYPES } },
      projectProfile: { type: 'object' as const },
      characters: { type: 'array' as const },
      lorebookEntries: { type: 'array' as const },
      writingRules: { type: 'array' as const },
      volumes: { type: 'array' as const },
      chapters: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Import preview builder',
    description: this.description,
    whenToUse: ['用户提供文档或长文本，并要求从中生成大纲、角色、世界设定、写作规则或项目资料预览。'],
    whenNotToUse: ['用户只要求普通问答或章节正文写作，没有要求从文档拆解可写入资产。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      analysis: { source: 'previous_step', description: '优先使用 analyze_source_text 或 read_source_document 后续分析结果。' },
      instruction: { source: 'user_message', description: '保留用户原话，用于判断本次要生成哪些资产。' },
      requestedAssetTypes: { source: 'user_message', description: '必须只包含用户明确要求的资产：projectProfile、outline、characters、worldbuilding、writingRules。只要大纲时仅传 outline。' },
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
  executionTimeoutMs = 500_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: BuildImportPreviewInput, _context: ToolContext): Promise<ImportPreviewOutput> {
    const requestedAssetTypes = normalizeImportAssetTypes(args.requestedAssetTypes, args.instruction);
    const analysis = args.analysis;
    const sourceText = analysis?.sourceText ?? args.instruction ?? '';
    const { data } = await this.llm.chatJson<ImportPreviewOutput>(
      [
        {
          role: 'system',
          content: [
            'You are an AI novel project import agent. Return JSON only, no Markdown.',
            'The document is only an input source. Generate only the asset types requested by requestedAssetTypes.',
            'If an asset type is not requested, leave its array empty and do not place that content in another field.',
            'writingRules are for writing constraints, forbidden wording, POV/style constraints, and structural rules. Do not put them in lorebookEntries.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User instruction: ${args.instruction ?? ''}`,
            `Requested asset types: ${requestedAssetTypes.join(', ')}`,
            `Keywords: ${analysis?.keywords?.join(', ') ?? ''}`,
            `Source document:\n${sourceText.slice(0, 24000)}`,
          ].join('\n'),
        },
      ],
      { appStep: 'planner', maxTokens: 8000, timeoutMs: 450_000, retries: 1 },
    );
    return this.normalize(data, sourceText, requestedAssetTypes);
  }

  private normalize(data: ImportPreviewOutput, sourceText: string, requestedAssetTypes: ImportAssetType[]): ImportPreviewOutput {
    const characters = (data.characters ?? [])
      .slice(0, 30)
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          name: this.scalarText(record.name),
          roleType: this.optionalScalarText(record.roleType),
          personalityCore: this.optionalScalarText(record.personalityCore),
          motivation: this.optionalScalarText(record.motivation),
          backstory: this.optionalScalarText(record.backstory),
        };
      })
      .filter((item) => item.name);
    const lorebookEntries = (data.lorebookEntries ?? [])
      .slice(0, 50)
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          title: this.scalarText(record.title),
          entryType: this.optionalScalarText(record.entryType) ?? 'setting',
          content: this.scalarText(record.content),
          summary: this.optionalScalarText(record.summary),
          tags: this.stringArray(record.tags),
        };
      })
      .filter((item) => item.title && item.content);
    const writingRules = (data.writingRules ?? [])
      .slice(0, 40)
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          title: this.scalarText(record.title),
          ruleType: this.optionalScalarText(record.ruleType) ?? 'style',
          content: this.scalarText(record.content),
          severity: this.normalizeSeverity(record.severity),
          appliesFromChapterNo: this.optionalNumber(record.appliesFromChapterNo),
          appliesToChapterNo: this.optionalNumber(record.appliesToChapterNo),
          entityType: this.optionalScalarText(record.entityType),
          entityRef: this.optionalScalarText(record.entityRef),
          status: this.optionalScalarText(record.status) ?? 'active',
        };
      })
      .filter((item) => item.title && item.content);
    const volumes = (data.volumes ?? []).slice(0, 12).map((item, index) => {
      const record = item as Record<string, unknown>;
      return {
        volumeNo: Number(record.volumeNo) || index + 1,
        title: this.scalarText(record.title, `第 ${index + 1} 卷`),
        synopsis: this.optionalScalarText(record.synopsis),
        objective: this.optionalScalarText(record.objective),
        chapterCount: this.optionalNumber(record.chapterCount),
      };
    });
    const chapters = (data.chapters ?? []).slice(0, 200).map((item, index) => {
      const record = item as Record<string, unknown>;
      return {
        chapterNo: Number(record.chapterNo) || index + 1,
        volumeNo: this.optionalNumber(record.volumeNo),
        title: this.scalarText(record.title, `第 ${index + 1} 章`),
        objective: this.optionalScalarText(record.objective),
        conflict: this.optionalScalarText(record.conflict),
        hook: this.optionalScalarText(record.hook),
        outline: this.optionalScalarText(record.outline),
        expectedWordCount: this.optionalNumber(record.expectedWordCount) ?? 2500,
      };
    });
    const projectProfile = this.normalizeProjectProfile(data.projectProfile, sourceText);
    if (!projectProfile.outline) projectProfile.outline = this.composeProjectOutline(volumes, chapters) || undefined;

    return filterImportPreviewByAssetTypes({
      requestedAssetTypes,
      projectProfile,
      characters,
      lorebookEntries,
      writingRules,
      volumes,
      chapters,
      risks: this.stringArray(data.risks),
    });
  }

  private normalizeProjectProfile(profile: ImportPreviewOutput['projectProfile'] | undefined, sourceText: string): ImportPreviewOutput['projectProfile'] {
    const record = (profile ?? {}) as Record<string, unknown>;
    const synopsis = this.scalarText(record.synopsis, sourceText.slice(0, 800));
    return {
      title: this.optionalScalarText(record.title),
      genre: this.optionalScalarText(record.genre),
      theme: this.optionalScalarText(record.theme),
      tone: this.optionalScalarText(record.tone),
      logline: this.optionalScalarText(record.logline),
      synopsis: synopsis || undefined,
      outline: this.optionalScalarText(record.outline),
    };
  }

  private optionalNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private optionalScalarText(value: unknown): string | undefined {
    return this.scalarText(value) || undefined;
  }

  private normalizeSeverity(value: unknown): 'info' | 'warning' | 'error' | undefined {
    const text = this.optionalScalarText(value)?.toLowerCase();
    if (text === 'info' || text === 'warning' || text === 'error') return text;
    if (text === 'warn') return 'warning';
    return undefined;
  }

  private composeProjectOutline(volumes: ImportPreviewOutput['volumes'], chapters: ImportPreviewOutput['chapters']) {
    const volumeLines = volumes.map((volume) => [`## 第 ${volume.volumeNo} 卷：${volume.title}`, volume.synopsis, volume.objective ? `目标：${volume.objective}` : ''].filter(Boolean).join('\n'));
    const chapterLines = chapters.slice(0, 80).map((chapter) => [`- 第 ${chapter.chapterNo} 章：${chapter.title}`, chapter.objective ? `目标：${chapter.objective}` : '', chapter.outline ? `梗概：${chapter.outline}` : ''].filter(Boolean).join('；'));
    return [...volumeLines, ...chapterLines].filter(Boolean).join('\n\n');
  }

  private scalarText(value: unknown, fallback = ''): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const joined = value.map((item) => this.scalarText(item)).filter(Boolean).join('、');
      return joined || fallback;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['primary', 'title', 'name', 'value', 'text', 'summary', 'description', 'content']) {
        const extracted = this.scalarText(record[key]);
        if (extracted) return extracted;
      }
      return JSON.stringify(value);
    }
    return fallback;
  }

  private stringArray(value: unknown): string[] {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return items
      .map((item) => this.text(item, ''))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private text(value: unknown, fallback: string): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return fallback;
  }
}
