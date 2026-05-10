import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import {
  asRecord,
  asRecordArray,
  assertChapterRangeCoverage,
  chapterCountForRange,
  ChapterOutlineBatch,
  ChapterOutlineBatchPreviewOutput,
  ChapterOutlineBatchPlan,
  ChapterRange,
  positiveInt,
  stringArray,
  text,
} from './chapter-outline-batch-contracts';
import { ChapterContinuityState, ChapterCraftBrief, ChapterSceneBeat, ChapterStoryUnit, OutlinePreviewOutput } from './generate-outline-preview.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { assertChapterCharacterExecution, type CharacterReferenceCatalog } from './outline-character-contracts';
import { assertVolumeStoryUnitPlan, type VolumeStoryUnitPlan } from './story-unit-contracts';
import { normalizeWithLlmRepair } from './structured-output-repair';

interface SegmentChapterOutlineBatchesInput {
  context?: Record<string, unknown>;
  volumeOutline?: Record<string, unknown>;
  storyUnitPlan?: Record<string, unknown>;
  volumeNo?: number;
  chapterCount?: number;
  preferredBatchSize?: number;
  maxBatchSize?: number;
}

const DEFAULT_PREFERRED_BATCH_SIZE = 4;
const DEFAULT_MAX_BATCH_SIZE = 5;
const MIN_BATCH_SIZE = 3;
const CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

@Injectable()
export class SegmentChapterOutlineBatchesTool implements BaseTool<SegmentChapterOutlineBatchesInput, ChapterOutlineBatchPlan> {
  name = 'segment_chapter_outline_batches';
  description = 'Segment a volume chapter-outline task into validated story-unit-aware batches. This tool only splits ranges and never generates story content.';
  inputSchema = {
    type: 'object' as const,
    required: ['context', 'volumeNo', 'chapterCount'],
    properties: {
      context: { type: 'object' as const },
      volumeOutline: { type: 'object' as const },
      storyUnitPlan: { type: 'object' as const },
      volumeNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
      preferredBatchSize: { type: 'number' as const },
      maxBatchSize: { type: 'number' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volumeNo', 'chapterCount', 'batches', 'risks'],
    properties: {
      volumeNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
      batches: { type: 'array' as const, items: { type: 'object' as const } },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Segment chapter outline batches',
    description: 'Splits a whole-volume chapter-outline target into visible continuous batches from storyUnitPlan.chapterAllocation; validates full coverage and never fills missing story content.',
    whenToUse: [
      'A long whole-volume chapter outline task has a known chapterCount and an upstream storyUnitPlan.chapterAllocation.',
      'Before generate_chapter_outline_batch_preview so users can see every target chapter range.',
    ],
    whenNotToUse: [
      'No storyUnitPlan.chapterAllocation is available; ask for or generate a valid storyUnitPlan first.',
      'The user only asks for a single chapter outline.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: 'inspect_project_context.output with persisted Volume.narrativePlan when reusing an existing plan.' },
      volumeOutline: { source: 'previous_step', description: 'Optional generate_volume_outline_preview.output.volume when the run is rebuilding the volume outline.' },
      storyUnitPlan: { source: 'previous_step', description: 'Optional generate_story_units_preview.output.storyUnitPlan; takes precedence over persisted narrativePlan.storyUnitPlan.' },
      volumeNo: { source: 'user_message', description: 'Target volume number.' },
      chapterCount: { source: 'user_message', description: 'Target full-volume chapter count.' },
    },
    examples: [
      {
        user: 'Generate volume 1 chapter outlines for 60 chapters.',
        plan: [
          { tool: 'inspect_project_context', args: { focus: ['outline', 'volumes', 'chapters', 'characters'] } },
          { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60 } },
          { tool: 'generate_chapter_outline_batch_preview', args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', chapterRange: { start: 1, end: 4 }, volumeNo: 1, chapterCount: 60 } },
        ],
      },
    ],
    failureHints: [
      { code: 'MISSING_STORY_UNIT_ALLOCATION', meaning: 'No complete storyUnitPlan.chapterAllocation was available.', suggestedRepair: 'Generate or repair storyUnitPlan first; do not create blind chapter batches.' },
      { code: 'BATCH_COVERAGE_INVALID', meaning: 'Batch ranges were missing, overlapping, non-continuous, or out of range.', suggestedRepair: 'Repair upstream storyUnitPlan.chapterAllocation.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  async run(args: SegmentChapterOutlineBatchesInput, context: ToolContext): Promise<ChapterOutlineBatchPlan> {
    const volumeNo = positiveInt(args.volumeNo) ?? positiveInt(asRecord(args.volumeOutline).volumeNo) ?? this.inferSingleVolumeNo(args.context);
    if (!volumeNo) throw new Error('segment_chapter_outline_batches requires a valid volumeNo.');

    const volume = this.findTargetVolume(args.context, args.volumeOutline, volumeNo);
    const requestedChapterCount = positiveInt(args.chapterCount);
    const volumeChapterCount = positiveInt(volume.chapterCount);
    if (requestedChapterCount && volumeChapterCount && requestedChapterCount !== volumeChapterCount) {
      throw new Error(`segment_chapter_outline_batches chapterCount mismatch: requested ${requestedChapterCount}, volume has ${volumeChapterCount}.`);
    }
    const chapterCount = requestedChapterCount ?? volumeChapterCount;
    if (!chapterCount) throw new Error('segment_chapter_outline_batches requires a valid chapterCount.');

    await context.updateProgress?.({
      phase: 'validating',
      phaseMessage: `Segmenting chapter outline batches for volume ${volumeNo}`,
      progressCurrent: 0,
      progressTotal: chapterCount,
    });

    const storyUnitPlan = this.resolveStoryUnitPlan(args.storyUnitPlan, volume, volumeNo, chapterCount);
    const preferredBatchSize = this.clampBatchSize(args.preferredBatchSize, DEFAULT_PREFERRED_BATCH_SIZE);
    const maxBatchSize = Math.max(preferredBatchSize, this.clampBatchSize(args.maxBatchSize, DEFAULT_MAX_BATCH_SIZE));
    const batches = this.buildBatches(storyUnitPlan, preferredBatchSize, maxBatchSize);

    assertChapterRangeCoverage({
      chapterCount,
      ranges: batches.map((batch) => ({ chapterRange: batch.chapterRange, label: `batch ${batch.batchNo}` })),
      label: 'segment_chapter_outline_batches output',
    });

    await context.updateProgress?.({
      phase: 'validating',
      phaseMessage: `Segmented ${chapterCount} chapters into ${batches.length} batches`,
      progressCurrent: chapterCount,
      progressTotal: chapterCount,
    });

    return {
      volumeNo,
      chapterCount,
      batches,
      risks: [`Segmented ${chapterCount} chapters into ${batches.length} story-unit-aware batches; no chapter content was generated.`],
    };
  }

  private resolveStoryUnitPlan(storyUnitPlanInput: unknown, volume: Record<string, unknown>, volumeNo: number, chapterCount: number): VolumeStoryUnitPlan {
    const providedStoryUnitPlan = asRecord(storyUnitPlanInput);
    const narrativePlan = asRecord(volume.narrativePlan);
    const persistedStoryUnitPlan = asRecord(narrativePlan.storyUnitPlan);
    const planRecord = Object.keys(providedStoryUnitPlan).length ? providedStoryUnitPlan : persistedStoryUnitPlan;
    if (!Object.keys(planRecord).length) {
      throw new Error(`segment_chapter_outline_batches volume ${volumeNo} has no storyUnitPlan.chapterAllocation; refusing to create blind chapter batches.`);
    }
    return assertVolumeStoryUnitPlan(planRecord, {
      volumeNo,
      chapterCount,
      label: 'segment_chapter_outline_batches.storyUnitPlan',
    });
  }

  private buildBatches(storyUnitPlan: VolumeStoryUnitPlan, preferredBatchSize: number, maxBatchSize: number): ChapterOutlineBatch[] {
    const allocations = [...(storyUnitPlan.chapterAllocation ?? [])].sort((left, right) => left.chapterRange.start - right.chapterRange.start);
    const batches: ChapterOutlineBatch[] = [];
    for (const allocation of allocations) {
      const unit = storyUnitPlan.units.find((item) => item.unitId === allocation.unitId);
      const title = unit?.title ? ` (${unit.title})` : '';
      for (const range of this.splitRange(allocation.chapterRange, preferredBatchSize, maxBatchSize)) {
        batches.push({
          batchNo: batches.length + 1,
          chapterRange: range,
          storyUnitIds: [allocation.unitId],
          reason: range.start === allocation.chapterRange.start && range.end === allocation.chapterRange.end
            ? `storyUnit ${allocation.unitId}${title} chapter allocation`
            : `storyUnit ${allocation.unitId}${title} split because allocation exceeds max batch size ${maxBatchSize}`,
        });
      }
    }
    return batches;
  }

  private splitRange(range: ChapterRange, preferredBatchSize: number, maxBatchSize: number): ChapterRange[] {
    const total = range.end - range.start + 1;
    if (total <= 0) throw new Error('segment_chapter_outline_batches received an invalid storyUnit chapterRange.');
    if (total <= maxBatchSize) return [{ start: range.start, end: range.end }];

    let batchCount = Math.ceil(total / preferredBatchSize);
    while (Math.ceil(total / batchCount) > maxBatchSize) batchCount += 1;
    while (batchCount > 1 && Math.floor(total / batchCount) < MIN_BATCH_SIZE && Math.ceil(total / (batchCount - 1)) <= maxBatchSize) {
      batchCount -= 1;
    }

    const baseSize = Math.floor(total / batchCount);
    let extra = total % batchCount;
    const ranges: ChapterRange[] = [];
    let start = range.start;
    for (let index = 0; index < batchCount; index += 1) {
      const size = baseSize + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      const end = start + size - 1;
      ranges.push({ start, end });
      start = end + 1;
    }
    return ranges;
  }

  private findTargetVolume(contextValue: unknown, volumeOutlineValue: unknown, volumeNo: number): Record<string, unknown> {
    const volumeOutline = asRecord(volumeOutlineValue);
    if (Object.keys(volumeOutline).length) return volumeOutline;
    const context = asRecord(contextValue);
    const volumes = asRecordArray(context.volumes);
    return volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
  }

  private inferSingleVolumeNo(contextValue: unknown): number | undefined {
    const volumes = asRecordArray(asRecord(contextValue).volumes);
    return volumes.length === 1 ? positiveInt(volumes[0].volumeNo) : undefined;
  }

  private clampBatchSize(value: unknown, fallback: number): number {
    const numeric = positiveInt(value);
    if (!numeric) return fallback;
    return Math.max(1, Math.min(8, numeric));
  }
}

interface GenerateChapterOutlineBatchPreviewInput {
  context?: Record<string, unknown>;
  volumeOutline?: Record<string, unknown>;
  storyUnitPlan?: Record<string, unknown>;
  batchPlan?: ChapterOutlineBatchPlan;
  volumeNo?: number;
  chapterCount?: number;
  chapterRange?: ChapterRange;
  instruction?: string;
  storyUnitSlice?: Record<string, unknown>;
  previousBatchTail?: {
    chapterNo: number;
    title: string;
    hook: string;
    craftBrief?: {
      exitState?: string;
      handoffToNextChapter?: string;
      openLoops?: string[];
      continuityState?: Record<string, unknown>;
    };
  };
  characterSourceWhitelist?: {
    existing?: string[];
    volume_candidate?: string[];
  };
}

@Injectable()
export class GenerateChapterOutlineBatchPreviewTool implements BaseTool<GenerateChapterOutlineBatchPreviewInput, ChapterOutlineBatchPreviewOutput> {
  private readonly logger = new StructuredLogger(GenerateChapterOutlineBatchPreviewTool.name);
  name = 'generate_chapter_outline_batch_preview';
  description = 'Generate a preview for one continuous 3-5 chapter outline batch with complete Chapter.craftBrief data. Fails instead of filling missing content.';
  inputSchema = {
    type: 'object' as const,
    required: ['context', 'volumeNo', 'chapterCount', 'chapterRange'],
    properties: {
      context: { type: 'object' as const },
      volumeOutline: { type: 'object' as const },
      storyUnitPlan: { type: 'object' as const },
      batchPlan: { type: 'object' as const },
      volumeNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
      chapterRange: { type: 'object' as const },
      instruction: { type: 'string' as const },
      storyUnitSlice: { type: 'object' as const },
      previousBatchTail: { type: 'object' as const },
      characterSourceWhitelist: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['batch', 'chapters', 'risks'],
    properties: {
      batch: { type: 'object' as const },
      chapters: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
      repairDiagnostics: { type: 'array' as const, items: { type: 'object' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS + CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS + 30_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Generate chapter outline batch preview',
    description: 'Calls the LLM once for a continuous 3-5 chapter batch; validates chapter count, chapter numbers, volumeNo, required outline fields, full craftBrief, storyUnit links, and character source whitelist.',
    whenToUse: [
      'After segment_chapter_outline_batches for each visible batch range in a long whole-volume chapter outline plan.',
      'When the target range is continuous and usually 3-5 chapters.',
    ],
    whenNotToUse: [
      'Do not use for a single explicitly requested chapter; use generate_chapter_outline_preview.',
      'Do not use if storyUnitPlan.chapterAllocation is unavailable.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: 'inspect_project_context.output.' },
      batchPlan: { source: 'previous_step', description: 'segment_chapter_outline_batches.output.' },
      chapterRange: { source: 'previous_step', description: 'One batch.chapterRange from segment_chapter_outline_batches.output.batches.' },
      previousBatchTail: { source: 'previous_step', description: 'Previous batch last chapter, used to bridge continuity.' },
      characterSourceWhitelist: { source: 'previous_step', description: 'Optional explicit source whitelist; merged with inspect context and volume characterPlan.' },
    },
    examples: [
      {
        user: 'Generate the first volume chapter outline.',
        plan: [
          { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60 } },
          { tool: 'generate_chapter_outline_batch_preview', args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', volumeNo: 1, chapterCount: 60, chapterRange: { start: 1, end: 4 }, instruction: '{{context.userMessage}}' } },
        ],
      },
    ],
    failureHints: [
      { code: 'BATCH_CHAPTER_COUNT_MISMATCH', meaning: 'LLM returned too few, too many, repeated, or non-continuous chapters.', suggestedRepair: 'Retry the same batch; do not fill missing chapters in backend.' },
      { code: 'BATCH_CRAFT_BRIEF_INCOMPLETE', meaning: 'A chapter was missing craftBrief or required craftBrief fields after repair.', suggestedRepair: 'Retry with smaller range or stronger context.' },
      { code: 'BATCH_CHARACTER_SOURCE_INVALID', meaning: 'characterExecution.cast used a source outside existing, volume_candidate, or minor_temporary whitelist.', suggestedRepair: 'Repair through LLM or fix upstream characterPlan.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateChapterOutlineBatchPreviewInput, context: ToolContext): Promise<ChapterOutlineBatchPreviewOutput> {
    const volumeNo = positiveInt(args.volumeNo) ?? positiveInt(args.batchPlan?.volumeNo);
    const chapterCount = positiveInt(args.chapterCount) ?? positiveInt(args.batchPlan?.chapterCount);
    const chapterRange = this.normalizeInputRange(args.chapterRange);
    if (!volumeNo) throw new Error('generate_chapter_outline_batch_preview requires a valid volumeNo.');
    if (!chapterCount) throw new Error('generate_chapter_outline_batch_preview requires a valid chapterCount.');
    if (!chapterRange) throw new Error('generate_chapter_outline_batch_preview requires a valid chapterRange.');
    if (chapterRange.end > chapterCount) throw new Error('generate_chapter_outline_batch_preview chapterRange exceeds chapterCount.');
    const targetChapterCount = chapterCountForRange(chapterRange);
    if (targetChapterCount > DEFAULT_MAX_BATCH_SIZE && !args.storyUnitSlice) {
      throw new Error(`generate_chapter_outline_batch_preview range ${chapterRange.start}-${chapterRange.end} is too large without an explicit storyUnitSlice.`);
    }

    const characterCatalog = this.extractCharacterCatalog(args.context, args.characterSourceWhitelist);
    const allowedStoryUnitIds = this.resolveAllowedStoryUnitIds(args, volumeNo, chapterCount, chapterRange);
    const volume = this.findTargetVolume(args.context, args.volumeOutline, volumeNo);

    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: `Generating chapter outline batch ${chapterRange.start}-${chapterRange.end}`,
      progressCurrent: chapterRange.start - 1,
      progressTotal: chapterCount,
      timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS,
    });

    const messages = [
      { role: 'system' as const, content: this.buildSystemPrompt() },
      { role: 'user' as const, content: this.buildUserPrompt(args, volume, volumeNo, chapterCount, chapterRange, characterCatalog, allowedStoryUnitIds) },
    ];
    const logContext = {
      agentRunId: context.agentRunId,
      projectId: context.projectId,
      volumeNo,
      chapterCount,
      chapterStart: chapterRange.start,
      chapterEnd: chapterRange.end,
      targetChapterCount,
      timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    };
    const startedAt = Date.now();
    this.logger.log('chapter_outline_batch_preview.llm_request.started', logContext);
    try {
      const response = await this.llm.chatJson<unknown>(
        messages,
        { appStep: 'planner', timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS, retries: 0, jsonMode: true, temperature: 0.2 },
      );
      recordToolLlmUsage(context, 'planner', response.result);
      const normalized = await normalizeWithLlmRepair({
        toolName: this.name,
        loggerEventPrefix: 'chapter_outline_batch_preview',
        llm: this.llm,
        context,
        data: response.data,
        normalize: (data) => this.normalize(data, {
          args,
          volume,
          volumeNo,
          chapterCount,
          chapterRange,
          characterCatalog,
          allowedStoryUnitIds,
        }),
        shouldRepair: ({ error, data }) => this.shouldRepairBatchOutput(data, error, chapterRange),
        buildRepairMessages: ({ invalidOutput, validationError }) => this.buildRepairMessages(invalidOutput, validationError, args, volume, volumeNo, chapterCount, chapterRange, characterCatalog, allowedStoryUnitIds),
        progress: {
          phaseMessage: `Repairing chapter outline batch ${chapterRange.start}-${chapterRange.end}`,
          timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS,
        },
        llmOptions: {
          appStep: 'planner',
          timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS,
          temperature: 0.1,
        },
        maxRepairAttempts: 1,
        initialModel: response.result.model,
        logger: this.logger,
      });
      this.logger.log('chapter_outline_batch_preview.llm_request.completed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        model: response.result.model,
        tokenUsage: response.result.usage,
      });
      await context.updateProgress?.({
        phase: 'validating',
        phaseMessage: `Validated chapter outline batch ${chapterRange.start}-${chapterRange.end}`,
        progressCurrent: chapterRange.end,
        progressTotal: chapterCount,
      });
      return normalized;
    } catch (error) {
      this.logger.error('chapter_outline_batch_preview.llm_request.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private normalize(data: unknown, options: {
    args: GenerateChapterOutlineBatchPreviewInput;
    volume: Record<string, unknown>;
    volumeNo: number;
    chapterCount: number;
    chapterRange: ChapterRange;
    characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] };
    allowedStoryUnitIds: string[];
  }): ChapterOutlineBatchPreviewOutput {
    const output = asRecord(data);
    const rawChapters = asRecordArray(output.chapters);
    const expectedCount = chapterCountForRange(options.chapterRange);
    if (rawChapters.length !== expectedCount) {
      throw new Error(`generate_chapter_outline_batch_preview returned ${rawChapters.length}/${expectedCount} chapters for range ${options.chapterRange.start}-${options.chapterRange.end}.`);
    }

    const chapters = rawChapters.map((chapter, index) => this.normalizeChapter(chapter, {
      ...options,
      expectedChapterNo: options.chapterRange.start + index,
      label: `chapter ${options.chapterRange.start + index}`,
    }));
    assertChapterRangeCoverage({
      chapterCount: options.chapterCount,
      ranges: [{ chapterRange: options.chapterRange, label: 'batch chapters' }],
      label: 'generate_chapter_outline_batch_preview target range',
    });

    const returnedNos = chapters.map((chapter) => Number(chapter.chapterNo));
    const duplicateNos = returnedNos.filter((chapterNo, index) => returnedNos.indexOf(chapterNo) !== index);
    if (duplicateNos.length) throw new Error(`generate_chapter_outline_batch_preview returned duplicate chapters: ${duplicateNos.join(', ')}.`);

    const batchRecord = asRecord(output.batch);
    const outputRange = this.normalizeInputRange(batchRecord.chapterRange) ?? options.chapterRange;
    if (outputRange.start !== options.chapterRange.start || outputRange.end !== options.chapterRange.end) {
      throw new Error('generate_chapter_outline_batch_preview batch.chapterRange does not match the target range.');
    }
    const storyUnitIds = stringArray(batchRecord.storyUnitIds);
    const effectiveStoryUnitIds = storyUnitIds.length ? storyUnitIds : options.allowedStoryUnitIds;
    if (!effectiveStoryUnitIds.length) {
      throw new Error('generate_chapter_outline_batch_preview cannot verify storyUnitIds for the target batch.');
    }

    return {
      batch: {
        volumeNo: options.volumeNo,
        chapterRange: options.chapterRange,
        storyUnitIds: effectiveStoryUnitIds,
        continuityBridgeIn: this.requiredText(batchRecord.continuityBridgeIn, 'batch.continuityBridgeIn'),
        continuityBridgeOut: this.requiredText(batchRecord.continuityBridgeOut, 'batch.continuityBridgeOut'),
      },
      chapters,
      risks: stringArray(output.risks),
    };
  }

  private normalizeChapter(chapterRecord: Record<string, unknown>, options: {
    volumeNo: number;
    expectedChapterNo: number;
    chapterRange: ChapterRange;
    characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] };
    allowedStoryUnitIds: string[];
    label: string;
  }): OutlinePreviewOutput['chapters'][number] {
    const chapterNo = positiveInt(chapterRecord.chapterNo);
    if (chapterNo !== options.expectedChapterNo) {
      throw new Error(`generate_chapter_outline_batch_preview ${options.label} chapterNo must be ${options.expectedChapterNo}.`);
    }
    if (positiveInt(chapterRecord.volumeNo) !== options.volumeNo) {
      throw new Error(`generate_chapter_outline_batch_preview ${options.label} volumeNo must be ${options.volumeNo}.`);
    }
    const expectedWordCount = positiveInt(chapterRecord.expectedWordCount);
    if (!expectedWordCount) throw new Error(`generate_chapter_outline_batch_preview ${options.label} expectedWordCount is required.`);
    const craftBrief = this.normalizeCraftBrief(chapterRecord.craftBrief, options.label, options.characterCatalog);
    if (!craftBrief.storyUnit?.unitId || !options.allowedStoryUnitIds.includes(craftBrief.storyUnit.unitId)) {
      throw new Error(`generate_chapter_outline_batch_preview ${options.label} craftBrief.storyUnit.unitId does not match target storyUnitIds.`);
    }
    const storyRange = craftBrief.storyUnit.chapterRange;
    if (!storyRange || storyRange.start > chapterNo || storyRange.end < chapterNo) {
      throw new Error(`generate_chapter_outline_batch_preview ${options.label} craftBrief.storyUnit.chapterRange does not cover chapter ${chapterNo}.`);
    }
    if (chapterNo === options.chapterRange.end) {
      this.requiredText(craftBrief.handoffToNextChapter, `${options.label}.craftBrief.handoffToNextChapter`);
      this.requiredText(craftBrief.continuityState?.nextImmediatePressure, `${options.label}.craftBrief.continuityState.nextImmediatePressure`);
    }
    return {
      chapterNo,
      volumeNo: options.volumeNo,
      title: this.requiredText(chapterRecord.title, `${options.label}.title`),
      objective: this.requiredText(chapterRecord.objective, `${options.label}.objective`),
      conflict: this.requiredText(chapterRecord.conflict, `${options.label}.conflict`),
      hook: this.requiredText(chapterRecord.hook, `${options.label}.hook`),
      outline: this.requiredText(chapterRecord.outline, `${options.label}.outline`),
      expectedWordCount,
      craftBrief,
    };
  }

  private normalizeCraftBrief(value: unknown, label: string, characterOptions: CharacterReferenceCatalog & { volumeCandidateNames: string[] }): ChapterCraftBrief {
    const record = asRecord(value);
    if (!Object.keys(record).length) throw new Error(`generate_chapter_outline_batch_preview ${label} missing craftBrief.`);
    const subplotTasks = this.requiredStringArray(record.subplotTasks, `${label}.craftBrief.subplotTasks`);
    const actionBeats = this.requiredStringArray(record.actionBeats, `${label}.craftBrief.actionBeats`);
    if (actionBeats.length < 3) throw new Error(`generate_chapter_outline_batch_preview ${label} craftBrief.actionBeats must contain at least 3 items.`);
    const sceneBeats = this.normalizeSceneBeats(record.sceneBeats, label);
    const concreteClues = asRecordArray(record.concreteClues).map((item, index) => ({
      name: this.requiredText(item.name, `${label}.craftBrief.concreteClues[${index}].name`),
      sensoryDetail: this.requiredText(item.sensoryDetail, `${label}.craftBrief.concreteClues[${index}].sensoryDetail`),
      laterUse: this.requiredText(item.laterUse, `${label}.craftBrief.concreteClues[${index}].laterUse`),
    }));
    if (!concreteClues.length) throw new Error(`generate_chapter_outline_batch_preview ${label} craftBrief.concreteClues is required.`);
    const characterExecution = assertChapterCharacterExecution(record.characterExecution, {
      ...characterOptions,
      actionBeatCount: actionBeats.length,
      sceneBeats,
      label: `${label}.craftBrief.characterExecution`,
    });
    return {
      visibleGoal: this.requiredText(record.visibleGoal, `${label}.craftBrief.visibleGoal`),
      hiddenEmotion: this.requiredText(record.hiddenEmotion, `${label}.craftBrief.hiddenEmotion`),
      coreConflict: this.requiredText(record.coreConflict, `${label}.craftBrief.coreConflict`),
      mainlineTask: this.requiredText(record.mainlineTask, `${label}.craftBrief.mainlineTask`),
      subplotTasks,
      storyUnit: this.normalizeStoryUnit(record.storyUnit, label),
      actionBeats,
      sceneBeats,
      concreteClues,
      dialogueSubtext: this.requiredText(record.dialogueSubtext, `${label}.craftBrief.dialogueSubtext`),
      characterShift: this.requiredText(record.characterShift, `${label}.craftBrief.characterShift`),
      irreversibleConsequence: this.requiredText(record.irreversibleConsequence, `${label}.craftBrief.irreversibleConsequence`),
      progressTypes: this.requiredStringArray(record.progressTypes, `${label}.craftBrief.progressTypes`),
      entryState: this.requiredText(record.entryState, `${label}.craftBrief.entryState`),
      exitState: this.requiredText(record.exitState, `${label}.craftBrief.exitState`),
      openLoops: this.requiredStringArray(record.openLoops, `${label}.craftBrief.openLoops`),
      closedLoops: this.requiredStringArray(record.closedLoops, `${label}.craftBrief.closedLoops`),
      handoffToNextChapter: this.requiredText(record.handoffToNextChapter, `${label}.craftBrief.handoffToNextChapter`),
      continuityState: this.normalizeContinuityState(record.continuityState, label),
      characterExecution,
    };
  }

  private normalizeStoryUnit(value: unknown, label: string): ChapterStoryUnit {
    const record = asRecord(value);
    if (!Object.keys(record).length) throw new Error(`generate_chapter_outline_batch_preview ${label} missing craftBrief.storyUnit.`);
    const range = asRecord(record.chapterRange);
    const chapterRange = {
      start: this.requiredPositiveInt(range.start, `${label}.craftBrief.storyUnit.chapterRange.start`),
      end: this.requiredPositiveInt(range.end, `${label}.craftBrief.storyUnit.chapterRange.end`),
    };
    if (chapterRange.end < chapterRange.start) throw new Error(`generate_chapter_outline_batch_preview ${label} craftBrief.storyUnit.chapterRange is invalid.`);
    const serviceFunctions = this.requiredStringArray(record.serviceFunctions, `${label}.craftBrief.storyUnit.serviceFunctions`);
    if (serviceFunctions.length < 3) throw new Error(`generate_chapter_outline_batch_preview ${label} craftBrief.storyUnit.serviceFunctions must contain at least 3 items.`);
    return {
      unitId: this.requiredText(record.unitId, `${label}.craftBrief.storyUnit.unitId`),
      title: this.requiredText(record.title, `${label}.craftBrief.storyUnit.title`),
      chapterRange,
      chapterRole: this.requiredText(record.chapterRole, `${label}.craftBrief.storyUnit.chapterRole`),
      localGoal: this.requiredText(record.localGoal, `${label}.craftBrief.storyUnit.localGoal`),
      localConflict: this.requiredText(record.localConflict, `${label}.craftBrief.storyUnit.localConflict`),
      serviceFunctions,
      mainlineSegmentIds: stringArray(record.mainlineSegmentIds),
      mainlineSegments: asRecordArray(record.mainlineSegments),
      serviceToMainline: text(record.serviceToMainline),
      mainlineContribution: this.requiredText(record.mainlineContribution, `${label}.craftBrief.storyUnit.mainlineContribution`),
      characterContribution: this.requiredText(record.characterContribution, `${label}.craftBrief.storyUnit.characterContribution`),
      relationshipContribution: this.requiredText(record.relationshipContribution, `${label}.craftBrief.storyUnit.relationshipContribution`),
      worldOrThemeContribution: this.requiredText(record.worldOrThemeContribution, `${label}.craftBrief.storyUnit.worldOrThemeContribution`),
      unitPayoff: this.requiredText(record.unitPayoff, `${label}.craftBrief.storyUnit.unitPayoff`),
      stateChangeAfterUnit: this.requiredText(record.stateChangeAfterUnit, `${label}.craftBrief.storyUnit.stateChangeAfterUnit`),
    };
  }

  private normalizeSceneBeats(value: unknown, label: string): ChapterSceneBeat[] {
    const beats = asRecordArray(value).map((item, index) => ({
      sceneArcId: this.requiredText(item.sceneArcId, `${label}.craftBrief.sceneBeats[${index}].sceneArcId`),
      scenePart: this.requiredText(item.scenePart, `${label}.craftBrief.sceneBeats[${index}].scenePart`),
      continuesFromChapterNo: this.optionalChapterNo(item.continuesFromChapterNo),
      continuesToChapterNo: this.optionalChapterNo(item.continuesToChapterNo),
      location: this.requiredText(item.location, `${label}.craftBrief.sceneBeats[${index}].location`),
      participants: this.requiredStringArray(item.participants, `${label}.craftBrief.sceneBeats[${index}].participants`),
      localGoal: this.requiredText(item.localGoal, `${label}.craftBrief.sceneBeats[${index}].localGoal`),
      visibleAction: this.requiredText(item.visibleAction, `${label}.craftBrief.sceneBeats[${index}].visibleAction`),
      obstacle: this.requiredText(item.obstacle, `${label}.craftBrief.sceneBeats[${index}].obstacle`),
      turningPoint: this.requiredText(item.turningPoint, `${label}.craftBrief.sceneBeats[${index}].turningPoint`),
      partResult: this.requiredText(item.partResult, `${label}.craftBrief.sceneBeats[${index}].partResult`),
      sensoryAnchor: this.requiredText(item.sensoryAnchor, `${label}.craftBrief.sceneBeats[${index}].sensoryAnchor`),
    }));
    if (beats.length < 3) throw new Error(`generate_chapter_outline_batch_preview ${label} craftBrief.sceneBeats must contain at least 3 items.`);
    return beats;
  }

  private normalizeContinuityState(value: unknown, label: string): ChapterContinuityState {
    const record = asRecord(value);
    if (!Object.keys(record).length) throw new Error(`generate_chapter_outline_batch_preview ${label} missing craftBrief.continuityState.`);
    const continuityState = {
      characterPositions: stringArray(record.characterPositions),
      activeThreats: stringArray(record.activeThreats),
      ownedClues: stringArray(record.ownedClues),
      relationshipChanges: stringArray(record.relationshipChanges),
      nextImmediatePressure: this.requiredText(record.nextImmediatePressure, `${label}.craftBrief.continuityState.nextImmediatePressure`),
    };
    if (![continuityState.characterPositions, continuityState.activeThreats, continuityState.ownedClues, continuityState.relationshipChanges].some((items) => items.length > 0)) {
      throw new Error(`generate_chapter_outline_batch_preview ${label} craftBrief.continuityState has no continuity state.`);
    }
    return continuityState;
  }

  private shouldRepairBatchOutput(data: unknown, error: unknown, chapterRange: ChapterRange): boolean {
    const output = asRecord(data);
    const rawChapters = asRecordArray(output.chapters);
    if (rawChapters.length !== chapterCountForRange(chapterRange)) return false;
    if (rawChapters.some((chapter) => !Object.keys(asRecord(chapter.craftBrief)).length)) return false;
    const message = this.errorMessage(error);
    if (/storyUnit\.unitId does not match|cannot verify storyUnitIds|chapterNo must be|volumeNo must be/.test(message)) return false;
    return /craftBrief|characterExecution|title|objective|conflict|hook|outline|expectedWordCount|cast|relationshipBeats|sceneBeats|participants|source|volume_candidate|minor_temporary|existing/.test(message);
  }

  private buildRepairMessages(
    invalidOutput: unknown,
    validationError: string,
    args: GenerateChapterOutlineBatchPreviewInput,
    volume: Record<string, unknown>,
    volumeNo: number,
    chapterCount: number,
    chapterRange: ChapterRange,
    characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] },
    allowedStoryUnitIds: string[],
  ) {
    return [
      {
        role: 'system' as const,
        content: [
          'You repair a novel chapter-outline batch JSON object.',
          'Repair only local structural errors in existing returned chapters. Do not invent missing chapters or add placeholder craftBrief content.',
          'If a whole chapter or whole craftBrief is missing, keep failure instead of fabricating content.',
          'Return strict JSON only with batch, chapters, and risks.',
          'characterExecution.cast source must be exactly one of: existing, volume_candidate, minor_temporary.',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          target: { volumeNo, chapterCount, chapterRange, allowedStoryUnitIds },
          validationError,
          characterSourceWhitelist: {
            existing: characterCatalog.existingCharacterNames ?? [],
            volume_candidate: characterCatalog.volumeCandidateNames ?? [],
            minor_temporary: 'Declare in characterExecution.newMinorCharacters with firstAndOnlyUse=true and approvalPolicy=preview_only.',
          },
          volume,
          storyUnitSlice: args.storyUnitSlice ?? null,
          previousBatchTail: args.previousBatchTail ?? null,
          invalidOutput,
        }, null, 2),
      },
    ];
  }

  private buildSystemPrompt(): string {
    return [
      'You are a senior Chinese web-novel chapter outline planner.',
      'Generate one continuous batch of chapter outlines. Every chapter must include a complete Chapter.craftBrief and characterExecution.',
      'Do not output deterministic placeholders, skeletal templates, or backend-fillable gaps.',
      'The backend will reject missing chapters, repeated chapters, non-continuous chapter numbers, missing craftBrief, incomplete characterExecution, or invalid character sources.',
      'Return strict JSON only. No Markdown.',
    ].join('\n');
  }

  private buildUserPrompt(
    args: GenerateChapterOutlineBatchPreviewInput,
    volume: Record<string, unknown>,
    volumeNo: number,
    chapterCount: number,
    chapterRange: ChapterRange,
    characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] },
    allowedStoryUnitIds: string[],
  ): string {
    const context = asRecord(args.context);
    return [
      `User instruction: ${args.instruction ?? ''}`,
      `Target volumeNo: ${volumeNo}`,
      `Target chapterCount: ${chapterCount}`,
      `Target batch chapterRange: ${chapterRange.start}-${chapterRange.end}`,
      `Allowed storyUnitIds for this batch: ${allowedStoryUnitIds.join(', ')}`,
      '',
      'characterExecution.cast source whitelist (must follow exactly):',
      JSON.stringify({
        existing: characterCatalog.existingCharacterNames ?? [],
        volume_candidate: characterCatalog.volumeCandidateNames ?? [],
        minor_temporary: 'Only one-off local function characters; declare in newMinorCharacters with firstAndOnlyUse=true and approvalPolicy=preview_only.',
      }, null, 2),
      '',
      'Target volume / narrative plan:',
      this.safeJson(volume, 8000),
      '',
      'Story unit slice for this batch:',
      this.safeJson(args.storyUnitSlice ?? this.storyUnitSliceFromPlan(args.storyUnitPlan, allowedStoryUnitIds), 5000),
      '',
      'Previous batch tail:',
      this.safeJson(args.previousBatchTail ?? null, 2500),
      '',
      'Existing character summaries:',
      this.safeJson(Array.isArray(context.characters) ? context.characters.slice(0, 40) : [], 5000),
      '',
      'Relationship summaries:',
      this.safeJson(Array.isArray(context.relationships) ? context.relationships.slice(0, 60) : [], 4000),
      '',
      'Existing chapter summaries:',
      this.safeJson(Array.isArray(context.existingChapters) ? context.existingChapters.slice(0, 160) : [], 6000),
      '',
      'Required JSON shape:',
      '{"batch":{"volumeNo":1,"chapterRange":{"start":1,"end":4},"storyUnitIds":["v1_unit_01"],"continuityBridgeIn":"how this batch enters from prior pressure","continuityBridgeOut":"how the final chapter hands off"},"chapters":[{"chapterNo":1,"volumeNo":1,"title":"...","objective":"...","conflict":"...","hook":"...","outline":"...","expectedWordCount":2500,"craftBrief":{"visibleGoal":"...","hiddenEmotion":"...","coreConflict":"...","mainlineTask":"...","subplotTasks":["..."],"storyUnit":{"unitId":"v1_unit_01","title":"...","chapterRange":{"start":1,"end":4},"chapterRole":"...","localGoal":"...","localConflict":"...","serviceFunctions":["mainline","relationship_shift","foreshadow"],"mainlineContribution":"...","characterContribution":"...","relationshipContribution":"...","worldOrThemeContribution":"...","unitPayoff":"...","stateChangeAfterUnit":"..."},"actionBeats":["...","...","..."],"sceneBeats":[{"sceneArcId":"scene_1","scenePart":"1/3","continuesFromChapterNo":null,"continuesToChapterNo":null,"location":"...","participants":["..."],"localGoal":"...","visibleAction":"...","obstacle":"...","turningPoint":"...","partResult":"...","sensoryAnchor":"..."}],"characterExecution":{"povCharacter":"...","cast":[{"characterName":"...","source":"existing","functionInChapter":"...","visibleGoal":"...","pressure":"...","actionBeatRefs":[1],"sceneBeatRefs":["scene_1"],"entryState":"...","exitState":"..."}],"relationshipBeats":[],"newMinorCharacters":[]},"concreteClues":[{"name":"...","sensoryDetail":"...","laterUse":"..."}],"dialogueSubtext":"...","characterShift":"...","irreversibleConsequence":"...","progressTypes":["info"],"entryState":"...","exitState":"...","openLoops":["..."],"closedLoops":["..."],"handoffToNextChapter":"...","continuityState":{"characterPositions":["..."],"activeThreats":["..."],"ownedClues":["..."],"relationshipChanges":["..."],"nextImmediatePressure":"..."}}}],"risks":[]}',
    ].join('\n');
  }

  private resolveAllowedStoryUnitIds(args: GenerateChapterOutlineBatchPreviewInput, volumeNo: number, chapterCount: number, chapterRange: ChapterRange): string[] {
    const explicit = stringArray(asRecord(args.storyUnitSlice).storyUnitIds);
    const direct = text(asRecord(args.storyUnitSlice).unitId);
    const fromSlice = [...explicit, ...(direct ? [direct] : [])];
    if (fromSlice.length) return [...new Set(fromSlice)];

    const matchingBatch = args.batchPlan?.batches?.find((batch) => batch.chapterRange.start === chapterRange.start && batch.chapterRange.end === chapterRange.end);
    if (matchingBatch?.storyUnitIds.length) return matchingBatch.storyUnitIds;

    const planRecord = Object.keys(asRecord(args.storyUnitPlan)).length
      ? asRecord(args.storyUnitPlan)
      : asRecord(this.findTargetVolume(args.context, args.volumeOutline, volumeNo).narrativePlan).storyUnitPlan;
    const storyUnitPlan = assertVolumeStoryUnitPlan(planRecord, {
      volumeNo,
      chapterCount,
      label: 'generate_chapter_outline_batch_preview.storyUnitPlan',
    });
    const ids = new Set<string>();
    for (let chapterNo = chapterRange.start; chapterNo <= chapterRange.end; chapterNo += 1) {
      const allocation = storyUnitPlan.chapterAllocation?.find((item) => item.chapterRange.start <= chapterNo && chapterNo <= item.chapterRange.end);
      if (allocation) ids.add(allocation.unitId);
    }
    return [...ids];
  }

  private storyUnitSliceFromPlan(storyUnitPlanValue: unknown, allowedStoryUnitIds: string[]): unknown {
    const storyUnitPlan = asRecord(storyUnitPlanValue);
    const units = asRecordArray(storyUnitPlan.units).filter((unit) => allowedStoryUnitIds.includes(text(unit.unitId)));
    const chapterAllocation = asRecordArray(storyUnitPlan.chapterAllocation).filter((allocation) => allowedStoryUnitIds.includes(text(allocation.unitId)));
    return Object.keys(storyUnitPlan).length ? { units, chapterAllocation } : {};
  }

  private extractCharacterCatalog(contextValue: unknown, whitelist?: GenerateChapterOutlineBatchPreviewInput['characterSourceWhitelist']): CharacterReferenceCatalog & { volumeCandidateNames: string[] } {
    const context = asRecord(contextValue);
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const existingCharacterNames = new Set<string>(whitelist?.existing ?? []);
    const existingCharacterAliases: Record<string, string[]> = {};
    for (const item of characters) {
      const record = asRecord(item);
      const name = text(record.name);
      if (!name) continue;
      existingCharacterNames.add(name);
      const aliases = stringArray(record.aliases).length ? stringArray(record.aliases) : stringArray(record.alias);
      if (aliases.length) existingCharacterAliases[name] = aliases;
    }

    const volumeCandidateNames = new Set<string>(whitelist?.volume_candidate ?? []);
    for (const volume of asRecordArray(context.volumes)) {
      const narrativePlan = asRecord(volume.narrativePlan);
      const characterPlan = asRecord(narrativePlan.characterPlan);
      for (const candidate of asRecordArray(characterPlan.newCharacterCandidates)) {
        const name = text(candidate.name);
        if (name) volumeCandidateNames.add(name);
      }
    }
    return {
      existingCharacterNames: [...existingCharacterNames],
      existingCharacterAliases,
      volumeCandidateNames: [...volumeCandidateNames],
    };
  }

  private findTargetVolume(contextValue: unknown, volumeOutlineValue: unknown, volumeNo: number): Record<string, unknown> {
    const volumeOutline = asRecord(volumeOutlineValue);
    if (Object.keys(volumeOutline).length) return volumeOutline;
    const volumes = asRecordArray(asRecord(contextValue).volumes);
    return volumes.find((item) => Number(item.volumeNo) === volumeNo) ?? {};
  }

  private normalizeInputRange(value: unknown): ChapterRange | undefined {
    const range = asRecord(value);
    const start = positiveInt(range.start);
    const end = positiveInt(range.end);
    return start && end && end >= start ? { start, end } : undefined;
  }

  private requiredText(value: unknown, label: string): string {
    const item = text(value);
    if (!item) throw new Error(`generate_chapter_outline_batch_preview missing ${label}.`);
    return item;
  }

  private requiredStringArray(value: unknown, label: string): string[] {
    const items = stringArray(value);
    if (!items.length) throw new Error(`generate_chapter_outline_batch_preview missing ${label}.`);
    return items;
  }

  private requiredPositiveInt(value: unknown, label: string): number {
    const numeric = positiveInt(value);
    if (!numeric) throw new Error(`generate_chapter_outline_batch_preview missing ${label}.`);
    return numeric;
  }

  private optionalChapterNo(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 1 ? numeric : null;
  }

  private safeJson(value: unknown, limit: number): string {
    const json = JSON.stringify(value ?? {}, null, 2);
    return json.length > limit ? `${json.slice(0, limit)}...` : json;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
