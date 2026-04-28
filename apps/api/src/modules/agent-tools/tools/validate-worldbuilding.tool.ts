import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import type { WorldbuildingPreviewOutput } from './generate-worldbuilding-preview.tool';

interface ValidateWorldbuildingInput {
  preview?: WorldbuildingPreviewOutput;
  taskContext?: Record<string, unknown>;
}

type WorldbuildingIssueSeverity = 'warning' | 'error';

interface WorldbuildingValidationIssue {
  severity: WorldbuildingIssueSeverity;
  message: string;
  entryTitle?: string;
  suggestion?: string;
}

export interface ValidateWorldbuildingOutput {
  valid: boolean;
  issueCount: number;
  issues: WorldbuildingValidationIssue[];
  conflictSummary: {
    lockedFactConflictCount: number;
    duplicateTitleCount: number;
    writeRequiresApproval: boolean;
  };
  relatedLockedFacts?: Array<{ title: string; excerpt: string }>;
  writePreview?: {
    summary: { createCount: number; skipDuplicateCount: number };
    entries: Array<{ title: string; entryType: string; action: 'create' | 'skip_duplicate'; existingStatus?: string | null }>;
    approvalMessage: string;
  };
}

/**
 * 世界观预览校验工具：在持久化前检查缺字段、重复设定名和 locked facts 冲突风险。
 * 工具只读数据库并返回 diff/审批提示，真正写入必须由后续持久化工具在审批后执行。
 */
@Injectable()
export class ValidateWorldbuildingTool implements BaseTool<ValidateWorldbuildingInput, ValidateWorldbuildingOutput> {
  name = 'validate_worldbuilding';
  description = '校验世界观扩展预览是否缺字段、重复或疑似影响 locked facts，并生成写入前 diff。';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      taskContext: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['valid', 'issueCount', 'issues', 'conflictSummary'],
    properties: {
      valid: { type: 'boolean' as const },
      issueCount: { type: 'number' as const },
      issues: { type: 'array' as const },
      conflictSummary: { type: 'object' as const },
      relatedLockedFacts: { type: 'array' as const },
      writePreview: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '校验世界观扩展',
    description: '检查世界观扩展预览是否与 locked facts、已有设定标题或剧情约束冲突，并生成写入前 diff。',
    whenToUse: ['generate_worldbuilding_preview 之后', '用户要求“不要影响已有剧情/设定”时', '写入世界观前需要展示冲突与 diff'],
    whenNotToUse: ['没有世界观预览时', '用户只是写章节正文或检查角色人设', '不能替代 persist_worldbuilding 的审批后写入'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: '来自 generate_worldbuilding_preview 的输出。' },
      taskContext: { source: 'previous_step', description: '来自 collect_task_context 的 locked facts、世界事实和约束。' },
    },
    failureHints: [{ code: 'VALIDATION_FAILED', meaning: '预览存在缺字段、重复标题或 locked facts 冲突风险。', suggestedRepair: '修正预览条目后重新校验，或让用户选择放弃冲突条目。' }],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly prisma: PrismaService) {}

  /** 只读校验世界观候选，并派生审批前可展示的创建/跳过 diff。 */
  async run(args: ValidateWorldbuildingInput, context: ToolContext): Promise<ValidateWorldbuildingOutput> {
    const preview = args.preview;
    if (!preview) {
      const issues = [{ severity: 'error' as const, message: '缺少世界观扩展预览，无法校验。', suggestion: '请先运行 generate_worldbuilding_preview。' }];
      return this.buildOutput(issues, 0, 0);
    }

    const entries = Array.isArray(preview.entries) ? preview.entries : [];
    const issues: WorldbuildingValidationIssue[] = [];
    if (!entries.length) issues.push({ severity: 'error', message: '世界观预览没有任何设定条目。', suggestion: '至少生成 1 条设定后再校验。' });

    const duplicatePreviewTitles = this.findDuplicateStrings(entries.map((entry) => entry.title));
    duplicatePreviewTitles.forEach((title) => issues.push({ severity: 'error', entryTitle: title, message: `预览中存在重复设定标题：${title}。`, suggestion: '合并重复设定或重命名后再写入。' }));

    entries.forEach((entry, index) => {
      const label = entry.title || `第 ${index + 1} 条设定`;
      if (!this.text(entry.title)) issues.push({ severity: 'error', entryTitle: label, message: `${label} 缺少标题。` });
      if (!this.text(entry.content)) issues.push({ severity: 'warning', entryTitle: label, message: `${label} 缺少完整内容。`, suggestion: '补充具体规则、限制和剧情使用边界。' });
      if (!this.text(entry.impactAnalysis)) issues.push({ severity: 'warning', entryTitle: label, message: `${label} 缺少对既有剧情影响的说明。`, suggestion: '补充为何不会影响已有剧情或 locked facts。' });
    });

    const lockedFacts = this.extractLockedFacts(args.taskContext);
    const lockedFactConflictCount = this.countLockedFactConflicts(entries, lockedFacts, issues);
    const writePreview = await this.buildWritePreview(entries, context);
    return this.buildOutput(issues, lockedFactConflictCount, writePreview.summary.skipDuplicateCount, writePreview, lockedFacts);
  }

  /** 从 collect_task_context 输出中提取 locked facts；缺上下文时保持空数组，避免误报阻断。 */
  private extractLockedFacts(taskContext?: Record<string, unknown>): Array<{ title: string; content: string }> {
    const worldFacts = Array.isArray(taskContext?.worldFacts) ? taskContext.worldFacts : [];
    return worldFacts
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
      .filter((item) => item.locked === true)
      .map((item) => ({ title: this.text(item.title), content: this.text(item.content) || this.text(item.summary) }));
  }

  /** 采用保守启发式识别“覆盖/推翻/改写 locked fact”等高风险表达，避免误把增量设定自动放行。 */
  private countLockedFactConflicts(entries: WorldbuildingPreviewOutput['entries'], lockedFacts: Array<{ title: string; content: string }>, issues: WorldbuildingValidationIssue[]): number {
    let count = 0;
    for (const entry of entries) {
      const combined = `${entry.title}\n${entry.summary}\n${entry.content}\n${entry.impactAnalysis}\n${entry.lockedFactHandling}`;
      const mentionsLockedFact = lockedFacts.some((fact) => fact.title && combined.includes(fact.title));
      const hasOverrideIntent = /覆盖|推翻|改写|替换|废除|不再成立/.test(combined);
      if (mentionsLockedFact && hasOverrideIntent) {
        count += 1;
        issues.push({ severity: 'error', entryTitle: entry.title, message: `“${entry.title}”疑似试图覆盖 locked fact。`, suggestion: '改为增量解释、旁支设定或人工确认解锁后再修改。' });
      }
    }
    return count;
  }

  /** 读取已有设定标题并生成写入前 diff；只创建新标题，重复标题默认跳过。 */
  private async buildWritePreview(entries: WorldbuildingPreviewOutput['entries'], context: ToolContext): Promise<NonNullable<ValidateWorldbuildingOutput['writePreview']>> {
    const existingEntries = await this.prisma.lorebookEntry.findMany({ where: { projectId: context.projectId }, select: { title: true, status: true } });
    const existingByTitle = new Map(existingEntries.map((entry) => [entry.title, entry.status]));
    const previewEntries = entries.map((entry) => {
      const existingStatus = existingByTitle.get(entry.title);
      return { title: entry.title, entryType: entry.entryType, action: existingStatus ? ('skip_duplicate' as const) : ('create' as const), existingStatus: existingStatus ?? null };
    });
    return {
      summary: { createCount: previewEntries.filter((entry) => entry.action === 'create').length, skipDuplicateCount: previewEntries.filter((entry) => entry.action === 'skip_duplicate').length },
      entries: previewEntries,
      approvalMessage: '校验通过后仍需用户审批；后续写入应只新增设定，不覆盖 locked facts 或已有同名设定。',
    };
  }

  private buildOutput(issues: WorldbuildingValidationIssue[], lockedFactConflictCount: number, duplicateTitleCount: number, writePreview?: ValidateWorldbuildingOutput['writePreview'], lockedFacts: Array<{ title: string; content: string }> = []): ValidateWorldbuildingOutput {
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      conflictSummary: { lockedFactConflictCount, duplicateTitleCount, writeRequiresApproval: true },
      relatedLockedFacts: lockedFacts.map((fact) => ({ title: fact.title, excerpt: this.compactText(fact.content, 180) })).slice(0, 8),
      ...(writePreview ? { writePreview } : {}),
    };
  }

  private compactText(value: string, maxLength: number): string {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }

  private findDuplicateStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    values.map((value) => this.text(value)).filter(Boolean).forEach((value) => {
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    });
    return [...duplicated];
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
}