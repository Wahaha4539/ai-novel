import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeLorebookEntryType } from '../../lorebook/lorebook-entry-types';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import type { WorldbuildingPreviewOutput } from './generate-worldbuilding-preview.tool';
import type { ValidateWorldbuildingOutput } from './validate-worldbuilding.tool';

interface PersistWorldbuildingInput {
  preview?: WorldbuildingPreviewOutput;
  validation?: ValidateWorldbuildingOutput;
  selectedTitles?: string[];
}

interface PersistWorldbuildingOutput {
  createdCount: number;
  skippedDuplicateCount: number;
  skippedUnselectedCount: number;
  skippedTitles: string[];
  skippedUnselectedTitles: string[];
  createdEntries: Array<{ id: string; title: string; entryType: string }>;
  perEntryAudit: Array<{ title: string; entryType: string; selected: boolean; action: 'created' | 'skipped_duplicate' | 'skipped_unselected'; reason: string; sourceStep: string }>;
  approvalMessage: string;
}

/**
 * 世界观持久化工具：用户审批后把已校验的世界观预览追加到设定库。
 * 该工具只新增不存在的标题，不覆盖同名设定或 locked facts，作为写入前审批后的最后安全边界。
 */
@Injectable()
export class PersistWorldbuildingTool implements BaseTool<PersistWorldbuildingInput, PersistWorldbuildingOutput> {
  name = 'persist_worldbuilding';
  description = '审批后将已校验的世界观扩展预览追加写入设定库，只新增不覆盖。';
  inputSchema = {
    type: 'object' as const,
    required: ['preview', 'validation'],
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      validation: { type: 'object' as const },
      selectedTitles: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['createdCount', 'skippedDuplicateCount', 'skippedUnselectedCount', 'skippedTitles', 'skippedUnselectedTitles', 'createdEntries', 'perEntryAudit', 'approvalMessage'],
    properties: {
      createdCount: { type: 'number' as const, minimum: 0 },
      skippedDuplicateCount: { type: 'number' as const, minimum: 0 },
      skippedUnselectedCount: { type: 'number' as const, minimum: 0 },
      skippedTitles: { type: 'array' as const, items: { type: 'string' as const } },
      skippedUnselectedTitles: { type: 'array' as const, items: { type: 'string' as const } },
      createdEntries: { type: 'array' as const },
      perEntryAudit: { type: 'array' as const },
      approvalMessage: { type: 'string' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_lorebook_entries'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '写入世界观设定',
    description: '在用户审批后，将 validate_worldbuilding 通过的世界观扩展预览追加为设定库条目；只新增，不覆盖同名或 locked 设定。',
    whenToUse: ['validate_worldbuilding 已通过且用户确认写入世界观扩展', '需要把世界观预览正式追加到设定库'],
    whenNotToUse: ['没有 generate_worldbuilding_preview 输出时', '没有 validate_worldbuilding 输出或校验未通过时', '用户只想预览/检查世界观，不想写入时', '需要覆盖或删除 locked facts 时，本工具禁止执行'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: '来自 generate_worldbuilding_preview 的输出。' },
      validation: { source: 'previous_step', description: '来自 validate_worldbuilding 的输出，必须 valid=true。' },
      selectedTitles: { source: 'user_message', description: '用户审批时明确选择要写入的条目标题；未提供时按原兼容逻辑写入全部通过校验的新条目。' },
    },
    preconditions: ['用户已审批写入计划', 'validation.valid 必须为 true', 'preview.writePlan.requiresApprovalBeforePersist 必须为 true'],
    postconditions: ['只新增不存在的 lorebook entries', '同名设定自动跳过，不覆盖 existing 或 locked 记录', '如果用户只选择部分标题，仅写入被选择的条目，其余条目记录为 skippedUnselectedTitles'],
    failureHints: [{ code: 'VALIDATION_FAILED', meaning: '世界观预览尚未通过校验或存在冲突。', suggestedRepair: '先调用 validate_worldbuilding 并修正冲突，再重新请求用户审批。' }],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly prisma: PrismaService, private readonly cacheService: NovelCacheService) {}

  /** 审批后追加写入已校验设定；写入前再次读取同名条目，防止审批和执行之间数据变化导致覆盖。 */
  async run(args: PersistWorldbuildingInput, context: ToolContext): Promise<PersistWorldbuildingOutput> {
    this.assertSafeInput(args);
    const entries = args.preview?.entries ?? [];
    const selectedTitleSet = this.buildSelectedTitleSet(args.selectedTitles, entries);
    const entriesToPersist = selectedTitleSet ? entries.filter((entry) => selectedTitleSet.has(entry.title.trim())) : entries;
    const skippedUnselectedTitles = selectedTitleSet ? entries.filter((entry) => !selectedTitleSet.has(entry.title.trim())).map((entry) => entry.title) : [];

    const result = await this.prisma.$transaction(async (tx) => {
      const existingEntries = await tx.lorebookEntry.findMany({ where: { projectId: context.projectId }, select: { title: true } });
      const existingTitles = new Set(existingEntries.map((entry) => entry.title));
      const createdEntries: PersistWorldbuildingOutput['createdEntries'] = [];
      const skippedTitles: string[] = [];
      const auditByTitle = new Map<string, PersistWorldbuildingOutput['perEntryAudit'][number]>();

      for (const entry of entriesToPersist) {
        if (existingTitles.has(entry.title)) {
          skippedTitles.push(entry.title);
          auditByTitle.set(entry.title, { title: entry.title, entryType: normalizeLorebookEntryType(entry.entryType), selected: true, action: 'skipped_duplicate', reason: '已有同名设定，按只新增不覆盖策略跳过。', sourceStep: 'persist_worldbuilding' });
          continue;
        }

        const created = await tx.lorebookEntry.create({
          data: {
            projectId: context.projectId,
            title: entry.title,
            entryType: normalizeLorebookEntryType(entry.entryType),
            content: entry.content,
            summary: entry.summary,
            tags: entry.tags as Prisma.InputJsonValue,
            priority: entry.priority,
            sourceType: 'agent_worldbuilding',
          },
          select: { id: true, title: true, entryType: true },
        });
        // 更新本事务内去重集合，避免同批预览重复标题被连续创建。
        existingTitles.add(entry.title);
        createdEntries.push(created);
        auditByTitle.set(entry.title, { title: entry.title, entryType: normalizeLorebookEntryType(entry.entryType), selected: true, action: 'created', reason: '用户选择且校验通过，已追加为新的世界观设定。', sourceStep: 'persist_worldbuilding' });
      }

      skippedUnselectedTitles.forEach((title) => {
        const entry = entries.find((item) => item.title === title);
        auditByTitle.set(title, { title, entryType: normalizeLorebookEntryType(entry?.entryType ?? 'setting'), selected: false, action: 'skipped_unselected', reason: '用户未选择该条目，本次审批写入跳过。', sourceStep: 'persist_worldbuilding' });
      });

      return {
        createdCount: createdEntries.length,
        skippedDuplicateCount: skippedTitles.length,
        skippedUnselectedCount: skippedUnselectedTitles.length,
        skippedTitles,
        skippedUnselectedTitles,
        createdEntries,
        perEntryAudit: entries.map((entry) => auditByTitle.get(entry.title)).filter((item): item is PersistWorldbuildingOutput['perEntryAudit'][number] => Boolean(item)),
        approvalMessage: selectedTitleSet
          ? '世界观设定已按用户选择追加写入；未选择条目和同名设定已跳过，未覆盖 locked facts 或已有设定。'
          : '世界观设定已按审批结果追加写入；同名设定已跳过，未覆盖 locked facts 或已有设定。',
      };
    });

    if (result.createdCount > 0) {
      // 世界观设定会直接参与 Lorebook 召回；新增后清空项目级召回缓存，避免继续使用旧设定快照。
      await this.cacheService.deleteProjectRecallResults(context.projectId);
    }

    return result;
  }

  /** 写入前做确定性防线：必须经过校验、必须是预览写入流，且不能含空标题/空内容。 */
  private assertSafeInput(args: PersistWorldbuildingInput) {
    if (!args.preview?.entries?.length) throw new BadRequestException('persist_worldbuilding 需要世界观预览条目');
    if (!args.validation) throw new BadRequestException('persist_worldbuilding 需要 validate_worldbuilding 校验结果');
    if (!args.validation.valid) throw new BadRequestException('世界观预览校验未通过，已阻止写入');
    if (args.preview.writePlan?.requiresApprovalBeforePersist !== true) throw new BadRequestException('世界观预览未声明写入前审批，已阻止写入');

    const invalidEntry = args.preview.entries.find((entry) => !entry.title?.trim() || !entry.content?.trim());
    if (invalidEntry) throw new BadRequestException(`世界观条目缺少标题或内容，已阻止写入：${invalidEntry.title || '未命名条目'}`);
  }

  /** 校验用户选择必须来自预览标题，避免审批时传入未知标题导致误写或静默漏写。 */
  private buildSelectedTitleSet(selectedTitles: string[] | undefined, entries: WorldbuildingPreviewOutput['entries']): Set<string> | undefined {
    const selected = this.stringArray(selectedTitles);
    if (!selected.length) return undefined;

    const availableTitles = new Set(entries.map((entry) => entry.title.trim()).filter(Boolean));
    const unknownTitles = selected.filter((title) => !availableTitles.has(title));
    if (unknownTitles.length) throw new BadRequestException(`选择写入的世界观条目不存在于预览中：${unknownTitles.join('、')}`);
    return new Set(selected);
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))] : [];
  }
}
