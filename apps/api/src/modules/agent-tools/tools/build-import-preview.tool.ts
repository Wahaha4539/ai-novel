import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';

interface BuildImportPreviewInput {
  analysis?: SourceTextAnalysisOutput;
  instruction?: string;
}

export interface ImportPreviewOutput {
  projectProfile: { title?: string; genre?: string; theme?: string; tone?: string; logline?: string; synopsis?: string; outline?: string };
  characters: Array<{ name: string; roleType?: string; personalityCore?: string; motivation?: string; backstory?: string }>;
  lorebookEntries: Array<{ title: string; entryType: string; content: string; summary?: string; tags?: string[] }>;
  volumes: Array<{ volumeNo: number; title: string; synopsis?: string; objective?: string; chapterCount?: number }>;
  chapters: Array<{ chapterNo: number; volumeNo?: number; title: string; objective?: string; conflict?: string; hook?: string; outline?: string; expectedWordCount?: number }>;
  risks: string[];
}

/**
 * 导入预览构建工具：把原始文案整理成项目资料、角色、设定、卷和章节预览。
 * 输出只作为审批预览，不直接持久化。
 */
@Injectable()
export class BuildImportPreviewTool implements BaseTool<BuildImportPreviewInput, ImportPreviewOutput> {
  name = 'build_import_preview';
  description = '根据文案分析结果生成项目资料、角色、世界观和大纲导入预览。';
  inputSchema = { type: 'object' as const, properties: { analysis: { type: 'object' as const }, instruction: { type: 'string' as const } } };
  outputSchema = {
    type: 'object' as const,
    required: ['projectProfile', 'characters', 'lorebookEntries', 'volumes', 'chapters', 'risks'],
    properties: { projectProfile: { type: 'object' as const }, characters: { type: 'array' as const }, lorebookEntries: { type: 'array' as const }, volumes: { type: 'array' as const }, chapters: { type: 'array' as const }, risks: { type: 'array' as const, items: { type: 'string' as const } } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = 500_000;

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: BuildImportPreviewInput, _context: ToolContext): Promise<ImportPreviewOutput> {
    const analysis = args.analysis;
    const sourceText = analysis?.sourceText ?? args.instruction ?? '';
    const { data } = await this.llm.chatJson<ImportPreviewOutput>(
      [
        { role: 'system', content: '你是小说项目导入 Agent。只输出 JSON，字段包含 projectProfile、characters、lorebookEntries、volumes、chapters、risks。不要 Markdown。' },
        { role: 'user', content: `用户要求：${args.instruction ?? ''}\n关键词：${analysis?.keywords?.join(', ') ?? ''}\n原始文案：\n${sourceText.slice(0, 24000)}` },
      ],
      { appStep: 'planner', maxTokens: 8000, timeoutMs: 450_000, retries: 1 },
    );
    return this.normalize(data, sourceText);
  }

  private normalize(data: ImportPreviewOutput, sourceText: string): ImportPreviewOutput {
    return {
      projectProfile: this.normalizeProjectProfile(data.projectProfile, sourceText),
      characters: (data.characters ?? [])
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
        .filter((item) => item.name),
      lorebookEntries: (data.lorebookEntries ?? [])
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
        .filter((item) => item.title && item.content),
      volumes: (data.volumes ?? []).slice(0, 12).map((item, index) => {
        const record = item as Record<string, unknown>;
        return {
          volumeNo: Number(record.volumeNo) || index + 1,
          title: this.scalarText(record.title, `第 ${index + 1} 卷`),
          synopsis: this.optionalScalarText(record.synopsis),
          objective: this.optionalScalarText(record.objective),
          chapterCount: this.optionalNumber(record.chapterCount),
        };
      }),
      chapters: (data.chapters ?? []).slice(0, 200).map((item, index) => {
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
      }),
      risks: this.stringArray(data.risks),
    };
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
