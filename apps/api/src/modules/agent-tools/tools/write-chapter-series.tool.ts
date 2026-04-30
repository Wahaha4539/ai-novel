import { BadRequestException, Injectable } from '@nestjs/common';
import { GenerateChapterResult, GenerateChapterService } from '../../generation/generate-chapter.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { AutoRepairChapterTool } from './auto-repair-chapter.tool';
import { ExtractChapterFactsTool } from './extract-chapter-facts.tool';
import { FactValidationTool } from './fact-validation.tool';
import { PolishChapterTool } from './polish-chapter.tool';
import { RebuildMemoryTool } from './rebuild-memory.tool';
import { ReviewMemoryTool } from './review-memory.tool';

const MAX_BATCH_CHAPTERS = 5;

interface WriteChapterSeriesInput {
  startChapterNo?: number;
  endChapterNo?: number;
  chapterNos?: number[];
  instruction?: string;
  wordCount?: number;
  maxChapters?: number;
  continueOnError?: boolean;
  qualityPipeline?: 'draft_only' | 'full';
}

interface WriteChapterQualityPipelineOutput {
  generated: GenerateChapterResult;
  firstPolish?: unknown;
  firstValidation?: Record<string, unknown>;
  firstAutoRepair?: unknown;
  secondPolish?: unknown;
  secondValidation?: Record<string, unknown>;
  secondAutoRepair?: unknown;
  facts?: unknown;
  memory?: unknown;
  memoryReview?: unknown;
}

interface WriteChapterSeriesItem {
  chapterId: string;
  chapterNo: number;
  title: string | null;
  status: 'succeeded' | 'failed';
  draftId?: string;
  versionNo?: number;
  actualWordCount?: number;
  summary?: string;
  pipeline?: WriteChapterQualityPipelineOutput;
  error?: string;
}

export interface WriteChapterSeriesResult {
  total: number;
  succeeded: number;
  failed: number;
  stoppedEarly: boolean;
  chapters: WriteChapterSeriesItem[];
}

/**
 * 多章连续写作工具：按章节编号顺序复用单章生成服务，逐章写入草稿。
 * 输入为章节范围或编号列表；输出每章生成结果。副作用是为多个章节创建草稿并更新章节状态。
 */
@Injectable()
export class WriteChapterSeriesTool implements BaseTool<WriteChapterSeriesInput, WriteChapterSeriesResult> {
  name = 'write_chapter_series';
  description = '按章节顺序连续生成多章正文草稿，适合“接下来三章”“第 1-5 章”等批量写作请求。';
  inputSchema = {
    type: 'object' as const,
    required: ['instruction'],
    additionalProperties: false,
    properties: {
      startChapterNo: { type: 'number' as const, integer: true, minimum: 1 },
      endChapterNo: { type: 'number' as const, integer: true, minimum: 1 },
      chapterNos: { type: 'array' as const, minItems: 1, maxItems: MAX_BATCH_CHAPTERS, items: { type: 'number' as const, integer: true, minimum: 1 } },
      instruction: { type: 'string' as const, minLength: 1 },
      wordCount: { type: 'number' as const, minimum: 100, maximum: 50000 },
      maxChapters: { type: 'number' as const, integer: true, minimum: 1, maximum: MAX_BATCH_CHAPTERS },
      continueOnError: { type: 'boolean' as const },
      qualityPipeline: { type: 'string' as const, enum: ['draft_only', 'full'] },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['total', 'succeeded', 'failed', 'stoppedEarly', 'chapters'],
    properties: {
      total: { type: 'number' as const, minimum: 0 },
      succeeded: { type: 'number' as const, minimum: 0 },
      failed: { type: 'number' as const, minimum: 0 },
      stoppedEarly: { type: 'boolean' as const },
      chapters: { type: 'array' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['create_chapter_draft', 'update_chapter_status', 'replace_fact_rule_validation_issues', 'replace_auto_story_events', 'replace_auto_character_states', 'replace_auto_foreshadows', 'replace_auto_memory_chunks', 'update_memory_review_status'];
  /** 多章连续生成可能累计耗时较长，外层超时按最多 5 章放宽到 30 分钟。 */
  executionTimeoutMs = 1_800_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '连续生成多章正文',
    description: '按章节编号升序连续生成多个章节正文草稿，并默认为每章执行润色、事实校验、自动修复、事实抽取和记忆重建。',
    whenToUse: ['用户要求连续写多章', '用户要求生成接下来几章正文', '用户要求写第 1-3 章或指定多个章节正文'],
    whenNotToUse: ['只写单章正文时使用 write_chapter', '用户只是要设计大纲或拆分章节时使用 outline_design', '章节范围不明确且无法从用户目标解析编号'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      startChapterNo: { source: 'user_message', description: '范围写作的起始章节号，例如“第 3-5 章”中的 3。' },
      endChapterNo: { source: 'user_message', description: '范围写作的结束章节号，例如“第 3-5 章”中的 5。' },
      chapterNos: { source: 'user_message', description: '非连续章节列表，例如“第 1、3、5 章”。' },
      instruction: { source: 'user_message', description: '保留用户对多章整体的风格、节奏、禁改项、连续性和剧情约束。' },
      wordCount: { source: 'context', description: '用户未指定时可使用 context.project.defaultWordCount。' },
      qualityPipeline: { source: 'literal', description: '默认使用 full；只有用户明确要求“只要草稿/跳过后续流程”时才使用 draft_only。' },
    },
    examples: [{ user: '帮我连续写第 3 到第 5 章，每章 3000 字，压迫感强一点。', plan: [{ tool: 'write_chapter_series', args: { startChapterNo: 3, endChapterNo: 5, instruction: '压迫感强一点，保持三章之间剧情连续', wordCount: 3000, qualityPipeline: 'full' } }] }],
    failureHints: [{ code: 'VALIDATION_FAILED', meaning: '章节范围缺失、范围过大或章节不存在', suggestedRepair: '要求用户缩小到最多 5 章，并确认要生成的章节编号。' }],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['chapterId'], allowedSources: ['chapterNo_range_from_user_message', 'chapterNos_from_user_message'] },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly generateChapter: GenerateChapterService,
    private readonly polishChapterTool: PolishChapterTool,
    private readonly factValidationTool: FactValidationTool,
    private readonly autoRepairChapterTool: AutoRepairChapterTool,
    private readonly extractChapterFactsTool: ExtractChapterFactsTool,
    private readonly rebuildMemoryTool: RebuildMemoryTool,
    private readonly reviewMemoryTool: ReviewMemoryTool,
  ) {}

  async run(args: WriteChapterSeriesInput, context: ToolContext): Promise<WriteChapterSeriesResult> {
    const chapterNos = this.resolveChapterNos(args);
    const chapters = await this.loadChapters(context.projectId, chapterNos);
    const byNo = new Map(chapters.map((chapter) => [chapter.chapterNo, chapter]));
    const missingNos = chapterNos.filter((chapterNo) => !byNo.has(chapterNo));
    if (missingNos.length) throw new BadRequestException(`项目内不存在章节：${missingNos.map((no) => `第 ${no} 章`).join('、')}`);

    const results: WriteChapterSeriesItem[] = [];
    let stoppedEarly = false;
    for (const chapterNo of chapterNos) {
      const chapter = byNo.get(chapterNo)!;
      try {
        // 严格串行生成：前一章草稿落库后，后一章的 PromptBuilder 才能召回最新前文。
        const generated = await this.generateSingleChapter(context, chapter.id, args);
        const pipeline: WriteChapterQualityPipelineOutput = { generated };
        let currentDraftId = generated.draftId;
        if ((args.qualityPipeline ?? 'full') === 'full') {
          currentDraftId = await this.runFullQualityPipeline(context, chapter.id, currentDraftId, pipeline);
        }
        results.push(this.toSuccessItem(chapter, generated, currentDraftId, pipeline));
      } catch (error) {
        results.push({ chapterId: chapter.id, chapterNo: chapter.chapterNo, title: chapter.title, status: 'failed', error: error instanceof Error ? error.message : String(error) });
        if (!args.continueOnError) {
          stoppedEarly = true;
          break;
        }
      }
    }

    const succeeded = results.filter((item) => item.status === 'succeeded').length;
    const failed = results.filter((item) => item.status === 'failed').length;
    return { total: chapterNos.length, succeeded, failed, stoppedEarly, chapters: results };
  }

  /** 将用户给出的范围或编号列表归一化为去重升序章节号，并施加批量上限。 */
  private resolveChapterNos(args: WriteChapterSeriesInput): number[] {
    const requestedLimit = args.maxChapters ?? MAX_BATCH_CHAPTERS;
    const maxChapters = Math.min(MAX_BATCH_CHAPTERS, requestedLimit);
    const fromList = Array.isArray(args.chapterNos) && args.chapterNos.length ? args.chapterNos : undefined;
    const rawNos = fromList ?? this.range(args.startChapterNo, args.endChapterNo);
    if (!rawNos.length) throw new BadRequestException('write_chapter_series 需要 chapterNos 或 startChapterNo/endChapterNo');

    const chapterNos = [...new Set(rawNos)].sort((a, b) => a - b);
    if (chapterNos.some((chapterNo) => !Number.isInteger(chapterNo) || chapterNo < 1)) throw new BadRequestException('章节编号必须是正整数');
    if (chapterNos.length > maxChapters) throw new BadRequestException(`单次连续生成最多允许 ${maxChapters} 章，当前请求 ${chapterNos.length} 章`);
    return chapterNos;
  }

  private range(startChapterNo?: number, endChapterNo?: number): number[] {
    if (!Number.isInteger(startChapterNo) || !Number.isInteger(endChapterNo)) return [];
    if (startChapterNo! > endChapterNo!) throw new BadRequestException('startChapterNo 不能大于 endChapterNo');
    return Array.from({ length: endChapterNo! - startChapterNo! + 1 }, (_, index) => startChapterNo! + index);
  }

  private async loadChapters(projectId: string, chapterNos: number[]) {
    return this.prisma.chapter.findMany({
      where: { projectId, chapterNo: { in: chapterNos } },
      orderBy: { chapterNo: 'asc' },
      select: { id: true, chapterNo: true, title: true },
    });
  }

  private generateSingleChapter(context: ToolContext, chapterId: string, args: WriteChapterSeriesInput): Promise<GenerateChapterResult> {
    return this.generateChapter.run(context.projectId, chapterId, {
      instruction: args.instruction,
      wordCount: args.wordCount,
      includeLorebook: true,
      includeMemory: true,
      agentRunId: context.agentRunId,
      userId: context.userId,
    });
  }

  /** 对单章执行与 Planner 强制追加链路一致的后处理，确保批量写作不会跳过事实/记忆沉淀。 */
  private async runFullQualityPipeline(context: ToolContext, chapterId: string, initialDraftId: string, pipeline: WriteChapterQualityPipelineOutput) {
    let currentDraftId = initialDraftId;

    pipeline.firstPolish = await this.polishChapterTool.run({ chapterId, draftId: currentDraftId, instruction: '在不改变剧情事实的前提下润色章节正文，统一文风、清理生硬表达，并保留章节目标和关键事件。' }, context);
    currentDraftId = this.readDraftId(pipeline.firstPolish) ?? currentDraftId;

    pipeline.firstValidation = await this.factValidationTool.run({ chapterId }, context);
    pipeline.firstAutoRepair = await this.autoRepairChapterTool.run({ chapterId, draftId: currentDraftId, issues: this.readIssues(pipeline.firstValidation), instruction: '根据事实校验问题做最小必要修复，不新增重大剧情、角色或设定。', maxRounds: 1 }, context);
    currentDraftId = this.readDraftId(pipeline.firstAutoRepair) ?? currentDraftId;

    // 仅当初次校验确实写入问题时，才执行第二轮轻量润色/校验/修复，保持与单章计划的有界修复策略一致。
    if (this.numberValue(pipeline.firstValidation.createdCount) > 0) {
      pipeline.secondPolish = await this.polishChapterTool.run({ chapterId, draftId: currentDraftId, instruction: '仅在初次校验发现问题后，对修复后的章节做第二轮轻量润色，保持剧情事实不变。' }, context);
      currentDraftId = this.readDraftId(pipeline.secondPolish) ?? currentDraftId;
      pipeline.secondValidation = await this.factValidationTool.run({ chapterId }, context);
      pipeline.secondAutoRepair = await this.autoRepairChapterTool.run({ chapterId, draftId: currentDraftId, issues: this.readIssues(pipeline.secondValidation), instruction: '根据二次事实校验问题做最后一轮有界修复；若无可修复问题则跳过。', maxRounds: 1 }, context);
      currentDraftId = this.readDraftId(pipeline.secondAutoRepair) ?? currentDraftId;
    }

    pipeline.facts = await this.extractChapterFactsTool.run({ chapterId, draftId: currentDraftId }, context);
    pipeline.memory = await this.rebuildMemoryTool.run({ chapterId, draftId: currentDraftId }, context);
    pipeline.memoryReview = await this.reviewMemoryTool.run({ chapterId }, context);
    return currentDraftId;
  }

  private readIssues(validation: Record<string, unknown> | undefined) {
    return Array.isArray(validation?.issues) ? validation.issues : [];
  }

  private readDraftId(value: unknown) {
    return value && typeof value === 'object' && typeof (value as Record<string, unknown>).draftId === 'string' ? (value as Record<string, string>).draftId : undefined;
  }

  private numberValue(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private toSuccessItem(chapter: { id: string; chapterNo: number; title: string | null }, generated: GenerateChapterResult, currentDraftId: string, pipeline: WriteChapterQualityPipelineOutput): WriteChapterSeriesItem {
    return {
      chapterId: chapter.id,
      chapterNo: chapter.chapterNo,
      title: chapter.title,
      status: 'succeeded',
      draftId: currentDraftId,
      versionNo: generated.versionNo,
      actualWordCount: generated.actualWordCount,
      summary: generated.summary,
      pipeline,
    };
  }
}