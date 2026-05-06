import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { IMPORT_ASSET_TYPES, ImportAssetType, ImportPreviewOutput } from './import-preview.types';

interface MergeImportPreviewsInput {
  requestedAssetTypes?: unknown;
  projectProfilePreview?: unknown;
  outlinePreview?: unknown;
  charactersPreview?: unknown;
  worldbuildingPreview?: unknown;
  writingRulesPreview?: unknown;
}

@Injectable()
export class MergeImportPreviewsTool implements BaseTool<MergeImportPreviewsInput, ImportPreviewOutput> {
  name = 'merge_import_previews';
  description = '把按目标产物生成的导入预览合并成统一 ImportPreviewOutput；只合并用户选择的目标产物，不生成内容、不写库。';
  inputSchema = {
    type: 'object' as const,
    properties: {
      requestedAssetTypes: { type: 'array' as const, items: { type: 'string' as const, enum: IMPORT_ASSET_TYPES } },
      projectProfilePreview: { type: 'object' as const },
      outlinePreview: { type: 'object' as const },
      charactersPreview: { type: 'object' as const },
      worldbuildingPreview: { type: 'object' as const },
      writingRulesPreview: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['requestedAssetTypes', 'projectProfile', 'characters', 'lorebookEntries', 'writingRules', 'volumes', 'chapters', 'risks'],
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
    displayName: 'Import preview merger',
    description: this.description,
    whenToUse: ['多个按目标产物生成的导入预览需要汇总为 validate_imported_assets 可接收的统一预览。'],
    whenNotToUse: ['需要从源文档生成内容时；本工具只做合并和去重，不调用 LLM，不写库。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    allowedModes: ['plan', 'act'],
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: [],
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  async run(args: MergeImportPreviewsInput, _context: ToolContext): Promise<ImportPreviewOutput> {
    const requestedAssetTypes = this.normalizeRequestedAssetTypes(args.requestedAssetTypes);
    const requested = new Set(requestedAssetTypes);
    const risks: string[] = [];
    const projectProfile: ImportPreviewOutput['projectProfile'] = {};

    if (!requestedAssetTypes.length) return this.emptyOutput([]);

    if (requested.has('projectProfile')) {
      const profile = this.normalizeProjectProfile(this.asRecord(args.projectProfilePreview).projectProfile ?? args.projectProfilePreview);
      projectProfile.title = profile.title;
      projectProfile.genre = profile.genre;
      projectProfile.theme = profile.theme;
      projectProfile.tone = profile.tone;
      projectProfile.logline = profile.logline;
      projectProfile.synopsis = profile.synopsis;
      this.collectRisks(risks, 'projectProfile', args.projectProfilePreview);
    }

    let volumes: ImportPreviewOutput['volumes'] = [];
    let chapters: ImportPreviewOutput['chapters'] = [];
    if (requested.has('outline')) {
      const outlineRecord = this.asRecord(args.outlinePreview);
      projectProfile.outline = this.optionalScalarText(this.asRecord(outlineRecord.projectProfile).outline);
      volumes = this.normalizeVolumes(outlineRecord.volumes);
      chapters = this.normalizeChapters(outlineRecord.chapters);
      this.collectRisks(risks, 'outline', args.outlinePreview);
    }

    const characters = requested.has('characters') ? this.dedupeByName(this.normalizeCharacters(this.asRecord(args.charactersPreview).characters), '角色', risks) : [];
    if (requested.has('characters')) this.collectRisks(risks, 'characters', args.charactersPreview);

    const lorebookEntries = requested.has('worldbuilding') ? this.dedupeByName(this.normalizeLorebookEntries(this.asRecord(args.worldbuildingPreview).lorebookEntries), '世界设定', risks) : [];
    if (requested.has('worldbuilding')) this.collectRisks(risks, 'worldbuilding', args.worldbuildingPreview);

    const writingRules = requested.has('writingRules') ? this.dedupeByName(this.normalizeWritingRules(this.asRecord(args.writingRulesPreview).writingRules), '写作规则', risks) : [];
    if (requested.has('writingRules')) this.collectRisks(risks, 'writingRules', args.writingRulesPreview);

    return {
      requestedAssetTypes,
      projectProfile,
      characters,
      lorebookEntries,
      writingRules,
      volumes,
      chapters,
      risks,
    };
  }

  private emptyOutput(requestedAssetTypes: ImportAssetType[]): ImportPreviewOutput {
    return { requestedAssetTypes, projectProfile: {}, characters: [], lorebookEntries: [], writingRules: [], volumes: [], chapters: [], risks: [] };
  }

  private normalizeRequestedAssetTypes(value: unknown): ImportAssetType[] {
    if (!Array.isArray(value)) return [];
    const normalized = value.filter((item): item is ImportAssetType => typeof item === 'string' && IMPORT_ASSET_TYPES.includes(item as ImportAssetType));
    return [...new Set(normalized)];
  }

  private normalizeProjectProfile(value: unknown): ImportPreviewOutput['projectProfile'] {
    const record = this.asRecord(value);
    return {
      title: this.optionalScalarText(record.title),
      genre: this.optionalScalarText(record.genre),
      theme: this.optionalScalarText(record.theme),
      tone: this.optionalScalarText(record.tone),
      logline: this.optionalScalarText(record.logline),
      synopsis: this.optionalScalarText(record.synopsis),
    };
  }

  private normalizeCharacters(value: unknown): ImportPreviewOutput['characters'] {
    return this.arrayValue(value)
      .map((item) => {
        const record = this.asRecord(item);
        return {
          name: this.scalarText(record.name),
          roleType: this.optionalScalarText(record.roleType),
          personalityCore: this.optionalScalarText(record.personalityCore),
          motivation: this.optionalScalarText(record.motivation),
          backstory: this.optionalScalarText(record.backstory),
        };
      })
      .filter((item) => item.name);
  }

  private normalizeLorebookEntries(value: unknown): ImportPreviewOutput['lorebookEntries'] {
    return this.arrayValue(value)
      .map((item) => {
        const record = this.asRecord(item);
        return {
          title: this.scalarText(record.title),
          entryType: this.optionalScalarText(record.entryType) ?? 'setting',
          content: this.scalarText(record.content),
          summary: this.optionalScalarText(record.summary),
          tags: this.stringArray(record.tags),
        };
      })
      .filter((item) => item.title && item.content);
  }

  private normalizeWritingRules(value: unknown): ImportPreviewOutput['writingRules'] {
    return this.arrayValue(value)
      .map((item) => {
        const record = this.asRecord(item);
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
  }

  private normalizeVolumes(value: unknown): ImportPreviewOutput['volumes'] {
    return this.arrayValue(value).map((item, index) => {
      const record = this.asRecord(item);
      return {
        volumeNo: Number(record.volumeNo) || index + 1,
        title: this.scalarText(record.title, `第 ${index + 1} 卷`),
        synopsis: this.optionalScalarText(record.synopsis),
        objective: this.optionalScalarText(record.objective),
        chapterCount: this.optionalNumber(record.chapterCount),
      };
    });
  }

  private normalizeChapters(value: unknown): ImportPreviewOutput['chapters'] {
    return this.arrayValue(value).map((item, index) => {
      const record = this.asRecord(item);
      return {
        chapterNo: Number(record.chapterNo) || index + 1,
        volumeNo: this.optionalNumber(record.volumeNo),
        title: this.scalarText(record.title, `第 ${index + 1} 章`),
        objective: this.optionalScalarText(record.objective),
        conflict: this.optionalScalarText(record.conflict),
        hook: this.optionalScalarText(record.hook),
        outline: this.optionalScalarText(record.outline),
        expectedWordCount: this.optionalNumber(record.expectedWordCount),
      };
    });
  }

  private dedupeByName<T extends { name?: string; title?: string }>(items: T[], label: string, risks: string[]): T[] {
    const seen = new Set<string>();
    const output: T[] = [];
    items.forEach((item) => {
      const key = (item.name ?? item.title ?? '').trim();
      if (!key) return;
      if (seen.has(key)) {
        risks.push(`${label}存在同名预览，已在合并阶段去重：${key}`);
        return;
      }
      seen.add(key);
      output.push(item);
    });
    return output;
  }

  private collectRisks(target: string[], source: string, preview: unknown) {
    this.stringArray(this.asRecord(preview).risks).forEach((risk) => target.push(`[${source}] ${risk}`));
  }

  private arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    return items.map((item) => this.scalarText(item)).map((item) => item.trim()).filter(Boolean);
  }
}
