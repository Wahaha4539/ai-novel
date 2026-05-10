import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { filterImportPreviewByAssetTypes, ImportPreviewOutput } from './import-preview.types';

interface CrossTargetConsistencyCheckInput {
  preview?: ImportPreviewOutput;
  instruction?: string;
}

type CrossTargetConsistencyDimension =
  | 'character_outline'
  | 'worldbuilding_writing_rules'
  | 'worldbuilding_outline'
  | 'context';

type CrossTargetConsistencySeverity = 'warning' | 'error';

export interface CrossTargetConsistencyIssue {
  severity: CrossTargetConsistencySeverity;
  dimension: CrossTargetConsistencyDimension;
  message: string;
  evidence?: string;
  suggestion?: string;
}

export interface CrossTargetConsistencyCheckOutput {
  valid: boolean;
  issueCount: number;
  issues: CrossTargetConsistencyIssue[];
  summary: {
    status: 'consistent' | 'needs_review' | 'likely_conflict';
    checkedTargets: string[];
  };
}

/**
 * 分目标导入跨目标一致性检查：只读检查目标之间是否互相污染或冲突。
 * 重点覆盖角色动机与大纲行为、世界设定与写作规则混放。
 */
@Injectable()
export class CrossTargetConsistencyCheckTool implements BaseTool<CrossTargetConsistencyCheckInput, CrossTargetConsistencyCheckOutput> {
  name = 'cross_target_consistency_check';
  description = '只读检查分目标导入预览中大纲、角色、世界设定和写作规则之间的冲突或混放。';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      instruction: { type: 'string' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['valid', 'issueCount', 'issues', 'summary'],
    additionalProperties: false,
    properties: {
      valid: { type: 'boolean' as const },
      issueCount: { type: 'number' as const },
      issues: { type: 'array' as const },
      summary: { type: 'object' as const },
    },
  };
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Cross-target consistency check',
    description: this.description,
    whenToUse: ['分目标导入预览已由 merge_import_previews 或 build_import_preview 生成后，写入前校验之前。'],
    whenNotToUse: ['尚未生成统一导入预览时；本 Tool 不生成预览、不写库，也不替代 validate_imported_assets。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: '来自 merge_import_previews 或 build_import_preview 的统一导入预览。' },
      instruction: { source: 'user_message', description: '用户本次导入目标和特别关注的冲突类型。' },
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

  async run(args: CrossTargetConsistencyCheckInput, _context: ToolContext): Promise<CrossTargetConsistencyCheckOutput> {
    const preview = args.preview ? filterImportPreviewByAssetTypes(args.preview) : undefined;
    if (!preview) {
      return this.buildOutput([{ severity: 'error', dimension: 'context', message: '缺少统一导入预览，无法执行跨目标一致性检查。', suggestion: '请先重新生成导入预览。' }], undefined);
    }

    const issues = [
      ...this.checkCharacterOutlineConflicts(preview),
      ...this.checkWorldbuildingWritingRuleMix(preview),
      ...this.checkWorldbuildingOutlineConflicts(preview),
    ];
    return this.buildOutput(issues, preview);
  }

  private checkCharacterOutlineConflicts(preview: ImportPreviewOutput): CrossTargetConsistencyIssue[] {
    const chapterEvidence = (preview.chapters ?? [])
      .map((chapter) => [chapter.title, chapter.objective, chapter.conflict, chapter.hook, chapter.outline].filter(Boolean).join('；'))
      .filter(Boolean);
    if (!chapterEvidence.length || !(preview.characters ?? []).length) return [];

    const issues: CrossTargetConsistencyIssue[] = [];
    for (const character of preview.characters ?? []) {
      const name = this.text(character.name);
      if (!name) continue;
      const motivation = [character.motivation, character.personalityCore, character.backstory].map((item) => this.text(item)).join('；');
      const matchedRule = CHARACTER_OUTLINE_CONFLICT_RULES.find((rule) => rule.motivation.test(motivation));
      if (!matchedRule) continue;
      const conflictingChapter = chapterEvidence.find((chapter) => chapter.includes(name) && matchedRule.outline.test(chapter));
      if (!conflictingChapter) continue;
      issues.push({
        severity: 'warning',
        dimension: 'character_outline',
        message: `角色 ${name} 的动机/人设与大纲行为疑似冲突：${matchedRule.label}。`,
        evidence: `角色：${motivation.slice(0, 160)}；大纲：${conflictingChapter.slice(0, 200)}`,
        suggestion: '这是关键词诊断提示，不作为写入阻断；如确需判定冲突，请交给 LLM 复核角色动机、大纲行为和转折铺垫。',
      });
    }
    return issues;
  }

  private checkWorldbuildingWritingRuleMix(preview: ImportPreviewOutput): CrossTargetConsistencyIssue[] {
    const issues: CrossTargetConsistencyIssue[] = [];
    for (const rule of preview.writingRules ?? []) {
      const text = [rule.title, rule.ruleType, rule.content].map((item) => this.text(item)).join('；');
      if (WORLD_FACT_PATTERN.test(text) && !WRITING_RULE_PATTERN.test(text)) {
        issues.push({
          severity: 'warning',
          dimension: 'worldbuilding_writing_rules',
          message: `写作规则「${this.text(rule.title, '未命名规则')}」像世界设定，可能应放入世界设定目标。`,
          evidence: text.slice(0, 200),
          suggestion: '若这是客观设定，请放入 worldbuilding；若是写法约束，请改写为文风/视角/禁写规则。',
        });
      }
    }
    for (const entry of preview.lorebookEntries ?? []) {
      const text = [entry.title, entry.entryType, entry.content, entry.summary].map((item) => this.text(item)).join('；');
      if (WRITING_RULE_PATTERN.test(text)) {
        issues.push({
          severity: 'warning',
          dimension: 'worldbuilding_writing_rules',
          message: `世界设定「${this.text(entry.title, '未命名设定')}」像写作规则，可能应放入写作规则目标。`,
          evidence: text.slice(0, 200),
          suggestion: '若这是写法限制或风格规范，请放入 writingRules；设定库只保留世界内事实。',
        });
      }
    }
    return issues;
  }

  private checkWorldbuildingOutlineConflicts(preview: ImportPreviewOutput): CrossTargetConsistencyIssue[] {
    const loreTexts = (preview.lorebookEntries ?? []).map((entry) => [entry.title, entry.content, entry.summary].map((item) => this.text(item)).join('；'));
    const chapterTexts = (preview.chapters ?? []).map((chapter) => [chapter.title, chapter.objective, chapter.conflict, chapter.outline].map((item) => this.text(item)).join('；'));
    const issues: CrossTargetConsistencyIssue[] = [];
    for (const rule of WORLD_OUTLINE_CONFLICT_RULES) {
      const lore = loreTexts.find((item) => rule.world.test(item));
      const chapter = chapterTexts.find((item) => rule.outline.test(item));
      if (lore && chapter) {
        issues.push({
          severity: 'warning',
          dimension: 'worldbuilding_outline',
          message: `世界设定与大纲行为疑似冲突：${rule.label}。`,
          evidence: `设定：${lore.slice(0, 160)}；大纲：${chapter.slice(0, 160)}`,
          suggestion: '请确认这是例外规则、伏笔，还是需要修正设定/大纲。',
        });
      }
    }
    return issues;
  }

  private buildOutput(issues: CrossTargetConsistencyIssue[], preview: ImportPreviewOutput | undefined): CrossTargetConsistencyCheckOutput {
    const checkedTargets = preview ? [
      preview.projectProfile?.outline || preview.volumes.length || preview.chapters.length ? 'outline' : '',
      preview.characters.length ? 'characters' : '',
      preview.lorebookEntries.length ? 'worldbuilding' : '',
      preview.writingRules.length ? 'writingRules' : '',
    ].filter(Boolean) : [];
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      summary: {
        status: issues.some((issue) => issue.severity === 'error') ? 'likely_conflict' : issues.length ? 'needs_review' : 'consistent',
        checkedTargets,
      },
    };
  }

  private text(value: unknown, fallback = ''): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map((item) => this.text(item)).filter(Boolean).join('、') || fallback;
    if (value && typeof value === 'object') return JSON.stringify(value);
    return fallback;
  }
}

const CHARACTER_OUTLINE_CONFLICT_RULES: Array<{ label: string; motivation: RegExp; outline: RegExp }> = [
  { label: '拒绝杀戮却在大纲中主动杀伤', motivation: /(拒绝|不愿|避免|不想|禁止|害怕).{0,12}(杀人|杀戮|伤害|杀死|动手)/i, outline: /(主动|决定|选择|亲手|直接).{0,16}(杀死|杀人|杀戮|伤害|处决|动手)/i },
  { label: '拒绝背叛却在大纲中主动背叛', motivation: /(忠诚|拒绝|不愿|避免|不想).{0,12}(背叛|出卖)/i, outline: /(主动|决定|选择|故意).{0,16}(背叛|出卖)/i },
  { label: '逃避离开却在大纲中主动离队', motivation: /(害怕|拒绝|不愿|避免|不想).{0,12}(离开|分离|独行)/i, outline: /(主动|决定|选择).{0,16}(离开|独行|脱队)/i },
];

const WORLD_FACT_PATTERN = /(世界设定|地点|势力|组织|宗门|能力体系|魔法|灵力|规则是|客观规律|历史|血脉|记忆会|城市会|居民会)/i;
const WRITING_RULE_PATTERN = /(写作规则|文风|视角|人称|禁写|不要写|避免使用|句式|用词|节奏|叙述|口吻|prose|style|pov)/i;
const WORLD_OUTLINE_CONFLICT_RULES: Array<{ label: string; world: RegExp; outline: RegExp }> = [
  { label: '设定声明能力不存在，但大纲直接使用该能力', world: /(不存在|无法使用|禁止|失效).{0,12}(魔法|灵力|异能|记忆篡改)/i, outline: /(使用|发动|施展|依靠).{0,12}(魔法|灵力|异能|记忆篡改)/i },
  { label: '设定声明地点不可进入，但大纲安排直接进入', world: /(不可进入|无法进入|封闭|禁止进入).{0,12}(城|馆|塔|门|禁区|地下)/i, outline: /(进入|潜入|闯入).{0,12}(城|馆|塔|门|禁区|地下)/i },
];
