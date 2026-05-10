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
  buildChapterOutlineBatchesFromStoryUnitPlan,
  chapterCountForRange,
  ChapterOutlineBatchQualityReview,
  ChapterOutlineBatchPreviewOutput,
  ChapterOutlineBatchPlan,
  ChapterRange,
  DEFAULT_CHAPTER_OUTLINE_MAX_BATCH_SIZE,
  DEFAULT_CHAPTER_OUTLINE_PREFERRED_BATCH_SIZE,
  normalizeChapterOutlineBatchSize,
  positiveInt,
  stringArray,
  text,
} from './chapter-outline-batch-contracts';
import { assertCompleteChapterCraftBrief } from './chapter-craft-brief-contracts';
import {
  buildChapterOutlineQualityRubric,
  CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS,
  formatChapterOutlineQualityIssues,
  reviewChapterOutlineQuality,
} from './chapter-outline-quality-review';
import { ChapterContinuityState, ChapterCraftBrief, ChapterSceneBeat, ChapterStoryUnit, OutlinePreviewOutput } from './generate-outline-preview.tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import { assertChapterCharacterExecution, assertVolumeCharacterPlan, type CharacterReferenceCatalog } from './outline-character-contracts';
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

const CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const CHAPTER_OUTLINE_BATCH_QUALITY_REVIEW_TIMEOUT_MS = CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS;
const CHAPTER_OUTLINE_BATCH_QUALITY_REGENERATION_ATTEMPTS = 1;

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
    const preferredBatchSize = normalizeChapterOutlineBatchSize(args.preferredBatchSize, DEFAULT_CHAPTER_OUTLINE_PREFERRED_BATCH_SIZE);
    const maxBatchSize = Math.max(preferredBatchSize, normalizeChapterOutlineBatchSize(args.maxBatchSize, DEFAULT_CHAPTER_OUTLINE_MAX_BATCH_SIZE));
    const batches = buildChapterOutlineBatchesFromStoryUnitPlan(storyUnitPlan, {
      preferredBatchSize,
      maxBatchSize,
      label: 'segment_chapter_outline_batches',
    });

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
      qualityReview: { type: 'object' as const },
      repairDiagnostics: { type: 'array' as const, items: { type: 'object' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  executionTimeoutMs = ((CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS + CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS) * (CHAPTER_OUTLINE_BATCH_QUALITY_REGENERATION_ATTEMPTS + 1))
    + (CHAPTER_OUTLINE_BATCH_QUALITY_REVIEW_TIMEOUT_MS * (CHAPTER_OUTLINE_BATCH_QUALITY_REGENERATION_ATTEMPTS + 1))
    + 60_000;
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
    if (targetChapterCount > DEFAULT_CHAPTER_OUTLINE_MAX_BATCH_SIZE && !args.storyUnitSlice) {
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
    const jsonSchema = this.buildResponseJsonSchema(allowedStoryUnitIds);
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
      let normalized = await this.generateAndNormalizeBatch(messages, {
        args,
        volume,
        volumeNo,
        chapterCount,
        chapterRange,
        characterCatalog,
        allowedStoryUnitIds,
        context,
        jsonSchema,
        phaseMessage: `Repairing chapter outline batch ${chapterRange.start}-${chapterRange.end}`,
      });
      let qualityReview = await this.reviewBatchQuality(normalized, {
        args,
        volume,
        volumeNo,
        chapterCount,
        chapterRange,
        characterCatalog,
        allowedStoryUnitIds,
        context,
      });
      let regeneratedForQuality = false;

      if (!qualityReview.valid) {
        regeneratedForQuality = true;
        await context.updateProgress?.({
          phase: 'calling_llm',
          phaseMessage: `Regenerating chapter outline batch ${chapterRange.start}-${chapterRange.end} from LLM quality issues`,
          progressCurrent: chapterRange.start - 1,
          progressTotal: chapterCount,
          timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS,
        });
        normalized = await this.generateAndNormalizeBatch(this.buildQualityRegenerationMessages({
          args,
          volume,
          volumeNo,
          chapterCount,
          chapterRange,
          characterCatalog,
          allowedStoryUnitIds,
          rejectedOutput: normalized,
          qualityReview,
        }), {
          args,
          volume,
          volumeNo,
          chapterCount,
          chapterRange,
          characterCatalog,
          allowedStoryUnitIds,
          context,
          jsonSchema,
          phaseMessage: `Repairing regenerated chapter outline batch ${chapterRange.start}-${chapterRange.end}`,
        });
        qualityReview = await this.reviewBatchQuality(normalized, {
          args,
          volume,
          volumeNo,
          chapterCount,
          chapterRange,
          characterCatalog,
          allowedStoryUnitIds,
          context,
        });
        if (!qualityReview.valid) {
          throw new Error(`generate_chapter_outline_batch_preview LLM quality validation failed after retry: ${formatChapterOutlineQualityIssues(qualityReview)}`);
        }
      }

      this.logger.log('chapter_outline_batch_preview.llm_request.completed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        regeneratedForQuality,
        qualityIssueCount: qualityReview.issues.length,
      });
      await context.updateProgress?.({
        phase: 'validating',
        phaseMessage: `Validated chapter outline batch ${chapterRange.start}-${chapterRange.end}`,
        progressCurrent: chapterRange.end,
        progressTotal: chapterCount,
      });
      return {
        ...normalized,
        qualityReview,
        risks: [
          ...normalized.risks,
          ...(regeneratedForQuality ? [`LLM quality review requested one regeneration for batch ${chapterRange.start}-${chapterRange.end}; accepted after retry.`] : []),
          ...qualityReview.issues
            .filter((issue) => issue.severity === 'warning')
            .map((issue) => `LLM quality warning${issue.chapterNo ? ` chapter ${issue.chapterNo}` : ''}${issue.path ? ` ${issue.path}` : ''}: ${issue.message}`),
        ],
      };
    } catch (error) {
      this.logger.error('chapter_outline_batch_preview.llm_request.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private async generateAndNormalizeBatch(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: {
      args: GenerateChapterOutlineBatchPreviewInput;
      volume: Record<string, unknown>;
      volumeNo: number;
      chapterCount: number;
      chapterRange: ChapterRange;
      characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] };
      allowedStoryUnitIds: string[];
      context: ToolContext;
      jsonSchema: { name: string; description: string; schema: Record<string, unknown>; strict: boolean };
      phaseMessage: string;
    },
  ): Promise<ChapterOutlineBatchPreviewOutput> {
    const response = await this.llm.chatJson<unknown>(
      messages,
      { appStep: 'planner', timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_LLM_TIMEOUT_MS, retries: 0, jsonMode: true, jsonSchema: options.jsonSchema, temperature: 0.2 },
    );
    recordToolLlmUsage(options.context, 'planner', response.result);
    return normalizeWithLlmRepair({
      toolName: this.name,
      loggerEventPrefix: 'chapter_outline_batch_preview',
      llm: this.llm,
      context: options.context,
      data: response.data,
      normalize: (data) => this.normalize(data, {
        args: options.args,
        volume: options.volume,
        volumeNo: options.volumeNo,
        chapterCount: options.chapterCount,
        chapterRange: options.chapterRange,
        characterCatalog: options.characterCatalog,
        allowedStoryUnitIds: options.allowedStoryUnitIds,
      }),
      shouldRepair: ({ error, data }) => this.shouldRepairBatchOutput(data, error, options.chapterRange),
      buildRepairMessages: ({ invalidOutput, validationError }) => this.buildRepairMessages(invalidOutput, validationError, options.args, options.volume, options.volumeNo, options.chapterCount, options.chapterRange, options.characterCatalog, options.allowedStoryUnitIds),
      progress: {
        phaseMessage: options.phaseMessage,
        timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS,
      },
      llmOptions: {
        appStep: 'planner',
        timeoutMs: CHAPTER_OUTLINE_BATCH_PREVIEW_REPAIR_TIMEOUT_MS,
        temperature: 0.1,
        jsonSchema: options.jsonSchema,
      },
      maxRepairAttempts: 1,
      initialModel: response.result.model,
      logger: this.logger,
    });
  }

  private async reviewBatchQuality(output: ChapterOutlineBatchPreviewOutput, options: {
    args: GenerateChapterOutlineBatchPreviewInput;
    volume: Record<string, unknown>;
    volumeNo: number;
    chapterCount: number;
    chapterRange: ChapterRange;
    characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] };
    allowedStoryUnitIds: string[];
    context: ToolContext;
  }): Promise<ChapterOutlineBatchQualityReview> {
    return reviewChapterOutlineQuality(this.llm, options.context, {
      task: 'Review this generated chapter-outline batch before it can enter approval/write flow.',
      target: {
        volumeNo: options.volumeNo,
        chapterCount: options.chapterCount,
        chapterRange: options.chapterRange,
        allowedStoryUnitIds: options.allowedStoryUnitIds,
      },
      output,
      volumeSummary: this.volumeRepairSummary(options.volume),
      storyUnitSlice: options.args.storyUnitSlice ?? this.storyUnitSliceFromPlan(this.storyUnitPlanForPrompt(options.args, options.volume), options.allowedStoryUnitIds),
      characterSourceWhitelist: {
        existing: options.characterCatalog.existingCharacterNames ?? [],
        volume_candidate: options.characterCatalog.volumeCandidateNames ?? [],
        minor_temporary: 'Only one-off local function characters declared in newMinorCharacters.',
      },
      chapterRange: options.chapterRange,
      progressMessage: `LLM reviewing chapter outline batch ${options.chapterRange.start}-${options.chapterRange.end}`,
      progressCurrent: options.chapterRange.end,
      progressTotal: options.chapterCount,
      usageStep: 'outline_batch_quality_review',
      schemaName: 'chapter_outline_batch_quality_review',
      schemaDescription: 'LLM semantic quality review for a generated chapter outline batch.',
    });
  }

  private buildQualityReviewMessages(output: ChapterOutlineBatchPreviewOutput, options: {
    args: GenerateChapterOutlineBatchPreviewInput;
    volume: Record<string, unknown>;
    volumeNo: number;
    chapterCount: number;
    chapterRange: ChapterRange;
    characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] };
    allowedStoryUnitIds: string[];
  }) {
    return [
      {
        role: 'system' as const,
        content: [
          'You are an expert Chinese web-novel outline quality reviewer.',
          'Judge semantic usability for drafting prose. Do not use keyword matching or regex-like heuristics; read the whole field in context.',
          'Return strict JSON only. No Markdown, comments, or prose.',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: this.safeJson({
          task: 'Review this generated chapter-outline batch before it can enter approval/write flow.',
          target: { volumeNo: options.volumeNo, chapterCount: options.chapterCount, chapterRange: options.chapterRange, allowedStoryUnitIds: options.allowedStoryUnitIds },
          rubric: this.batchQualityRubric(),
          decisionRules: [
            'Return valid=false if any chapter has an error-level issue.',
            'Return error only when the issue would make the chapter hard to draft into concrete prose without inventing major missing action, obstacle, result, or continuity.',
            'Return warning for polish, minor repetition, weak style, or fixable wording that does not block drafting.',
            'Do not reject solely because a sentence contains abstract words; reject only if the whole field lacks concrete actor/action/object/obstacle/result in context.',
            'Do not rewrite content. Report specific failed points with chapterNo, path, message, suggestion, and short evidence.',
          ],
          volumeSummary: this.volumeRepairSummary(options.volume),
          storyUnitSlice: options.args.storyUnitSlice ?? this.storyUnitSliceFromPlan(this.storyUnitPlanForPrompt(options.args, options.volume), options.allowedStoryUnitIds),
          characterSourceWhitelist: {
            existing: options.characterCatalog.existingCharacterNames ?? [],
            volume_candidate: options.characterCatalog.volumeCandidateNames ?? [],
            minor_temporary: 'Only one-off local function characters declared in newMinorCharacters.',
          },
          batchOutput: output,
          outputContract: {
            valid: 'boolean',
            summary: 'short string',
            issues: [
              {
                severity: 'error|warning',
                chapterNo: 'number optional',
                path: 'field path such as chapters[1].craftBrief.actionBeats[2]',
                message: 'what failed',
                suggestion: 'how the next generation should fix it',
                evidence: 'short quote or paraphrase from the failed field',
              },
            ],
          },
        }, 70000),
      },
    ];
  }

  private buildQualityRegenerationMessages(input: {
    args: GenerateChapterOutlineBatchPreviewInput;
    volume: Record<string, unknown>;
    volumeNo: number;
    chapterCount: number;
    chapterRange: ChapterRange;
    characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] };
    allowedStoryUnitIds: string[];
    rejectedOutput: ChapterOutlineBatchPreviewOutput;
    qualityReview: ChapterOutlineBatchQualityReview;
  }) {
    return [
      {
        role: 'system' as const,
        content: [
          'You regenerate a Chinese web-novel chapter-outline batch after LLM semantic quality review.',
          'Regenerate the whole target batch, not a prose explanation.',
          'Preserve the target chapter numbers, volumeNo, storyUnitIds, and required JSON shape.',
          'Fix every error-level quality issue. Do not create deterministic placeholders or skeletal template text.',
          'Return compact strict JSON only with batch, chapters, and risks. No Markdown, comments, or prose.',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: this.safeJson({
          userInstruction: input.args.instruction ?? '',
          target: { volumeNo: input.volumeNo, chapterCount: input.chapterCount, chapterRange: input.chapterRange, allowedStoryUnitIds: input.allowedStoryUnitIds },
          qualityRubric: buildChapterOutlineQualityRubric(),
          qualityIssuesToFix: input.qualityReview.issues.filter((issue) => issue.severity === 'error'),
          rejectedOutput: input.rejectedOutput,
          volume: input.volume,
          storyUnitSlice: input.args.storyUnitSlice ?? this.storyUnitSliceFromPlan(this.storyUnitPlanForPrompt(input.args, input.volume), input.allowedStoryUnitIds),
          previousBatchTail: input.args.previousBatchTail ?? null,
          characterSourceWhitelist: {
            existing: input.characterCatalog.existingCharacterNames ?? [],
            volume_candidate: input.characterCatalog.volumeCandidateNames ?? [],
            minor_temporary: 'Only one-off local function characters; declare in newMinorCharacters with firstAndOnlyUse=true and approvalPolicy=preview_only.',
          },
          hardRules: [
            `Return exactly chapters ${input.chapterRange.start}-${input.chapterRange.end}, continuous and in order.`,
            'Every chapter must include title, objective, conflict, hook, outline, expectedWordCount, and complete craftBrief.',
            'Every craftBrief.actionBeats item must be a concrete executable beat with actor, visible action, object/target, obstacle or result.',
            'Every sceneBeats.visibleAction must describe a visible action that can be drafted directly into prose.',
            'Maintain continuityBridgeIn/Out, entryState, exitState, handoffToNextChapter, and continuityState so the next batch can continue.',
          ],
          requiredJsonShape: JSON.parse(this.buildRequiredJsonShapeExample(input.volumeNo, input.chapterRange, input.allowedStoryUnitIds)),
        }, 70000),
      },
    ];
  }

  private batchQualityRubric(): string[] {
    return [
      'Chapter outline: must contain a scene chain with who acts, where, visible action, resistance, turn/result, and chapter-end handoff. It may be concise, but cannot be only an intention or theme.',
      'Action beats: each beat should be executable as a drafting instruction. It needs a concrete actor plus visible action and object/target; at least one beat must show resistance and at least one must show resulting state change.',
      'Scene beats: each scene must be draftable without inventing its location, participants, visible action, obstacle, turning point, result, or sensory anchor.',
      'Conflict/obstacle: must identify who or what blocks the action and how the pressure appears on page.',
      'Continuity: entryState, exitState, handoffToNextChapter, openLoops, closedLoops, and continuityState must let adjacent chapters connect without guessing.',
      'Character execution: cast functions, actionBeatRefs, sceneBeatRefs, entryState, and exitState must match the chapter action. Temporary characters must remain one-off unless explicitly marked needs_approval upstream.',
      'Reject as error only for semantic gaps that would force the next writer/LLM to invent major missing plot action or continuity. Use warnings for weaker but still draftable writing.',
    ];
  }

  private buildQualityReviewJsonSchema(): { name: string; description: string; schema: Record<string, unknown>; strict: boolean } {
    return {
      name: 'chapter_outline_batch_quality_review',
      description: 'LLM semantic quality review for a generated chapter outline batch.',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['valid', 'summary', 'issues'],
        properties: {
          valid: { type: 'boolean' },
          summary: { type: 'string' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['severity', 'chapterNo', 'path', 'message', 'suggestion', 'evidence'],
              properties: {
                severity: { type: 'string', enum: ['warning', 'error'] },
                chapterNo: { type: ['integer', 'null'] },
                path: { type: ['string', 'null'] },
                message: { type: 'string' },
                suggestion: { type: ['string', 'null'] },
                evidence: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    };
  }

  private normalizeQualityReview(value: unknown, chapterRange: ChapterRange): ChapterOutlineBatchQualityReview {
    const record = asRecord(value);
    const issues = asRecordArray(record.issues).map((issue) => {
      const chapterNo = positiveInt(issue.chapterNo);
      return {
        severity: issue.severity === 'error' ? 'error' as const : 'warning' as const,
        ...(chapterNo && chapterNo >= chapterRange.start && chapterNo <= chapterRange.end ? { chapterNo } : {}),
        ...(text(issue.path) ? { path: text(issue.path) } : {}),
        message: this.requiredText(issue.message, 'qualityReview.issues[].message'),
        ...(text(issue.suggestion) ? { suggestion: text(issue.suggestion) } : {}),
        ...(text(issue.evidence) ? { evidence: text(issue.evidence) } : {}),
      };
    });
    const valid = typeof record.valid === 'boolean'
      ? record.valid
      : !issues.some((issue) => issue.severity === 'error');
    return {
      valid: valid && !issues.some((issue) => issue.severity === 'error'),
      summary: text(record.summary),
      issues,
    };
  }

  private formatQualityIssues(review: ChapterOutlineBatchQualityReview): string {
    return review.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `chapter ${issue.chapterNo ?? '?'}${issue.path ? ` ${issue.path}` : ''}: ${issue.message}`)
      .join('; ') || review.summary || 'unknown quality issue';
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
    if (options.chapterRange.start < 1 || options.chapterRange.end > options.chapterCount) {
      throw new Error(`generate_chapter_outline_batch_preview target range ${options.chapterRange.start}-${options.chapterRange.end} exceeds chapterCount ${options.chapterCount}.`);
    }

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
    if (/firstAndOnlyUse|approvalPolicy 声明为 needs_approval|未进入卷级角色候选/.test(message)) return false;
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
          'Return compact strict JSON only with batch, chapters, and risks. No Markdown, comments, or prose.',
          'Every existing chapter craftBrief.actionBeats and craftBrief.sceneBeats must each contain at least 3 concrete items.',
          'Every sceneBeats object must include sceneArcId, scenePart, location, participants, localGoal, visibleAction, obstacle, turningPoint, partResult, and sensoryAnchor.',
          'characterExecution.cast source must be exactly one of: existing, volume_candidate, minor_temporary.',
          'characterExecution.relationshipBeats may be [] or complete objects with participants, publicStateBefore, trigger, shift, and publicStateAfter.',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: this.safeJson({
          target: { volumeNo, chapterCount, chapterRange, allowedStoryUnitIds },
          validationError,
          repairRules: [
            `Keep exactly chapters ${chapterRange.start}-${chapterRange.end}; do not add, remove, renumber, or reorder chapters.`,
            'Repair only incomplete local fields in chapters that are already present.',
            'Each chapter needs title, objective, conflict, hook, outline, expectedWordCount, complete craftBrief, and characterExecution.',
            'craftBrief.actionBeats and craftBrief.sceneBeats each need at least 3 concrete items; concreteClues needs at least 1 item.',
            'Each sceneBeats object must include sceneArcId, scenePart, location, participants, localGoal, visibleAction, obstacle, turningPoint, partResult, and sensoryAnchor.',
            'relationshipBeats may be empty; if a relationship beat object exists, complete it with participants, publicStateBefore, trigger, shift, and publicStateAfter. Do not leave partial relationship beat objects.',
            'Return minified JSON so the parser receives one valid JSON object.',
          ],
          characterSourceWhitelist: {
            existing: characterCatalog.existingCharacterNames ?? [],
            volume_candidate: characterCatalog.volumeCandidateNames ?? [],
            minor_temporary: 'Declare in characterExecution.newMinorCharacters with firstAndOnlyUse=true and approvalPolicy=preview_only.',
          },
          volume: this.volumeRepairSummary(volume),
          storyUnitSlice: args.storyUnitSlice ?? this.storyUnitSliceFromPlan(this.storyUnitPlanForPrompt(args, volume), allowedStoryUnitIds),
          previousBatchTail: args.previousBatchTail ?? null,
          invalidOutput,
        }, 60000),
      },
    ];
  }

  private buildSystemPrompt(): string {
    return [
      'You are a senior Chinese web-novel chapter outline planner.',
      'Generate one continuous batch of chapter outlines. Every chapter must include a complete Chapter.craftBrief and characterExecution.',
      'Do not output deterministic placeholders, skeletal templates, or backend-fillable gaps.',
      'The backend will reject missing chapters, repeated chapters, non-continuous chapter numbers, missing craftBrief, incomplete characterExecution, or invalid character sources.',
      'Return compact strict JSON only. No Markdown, comments, or prose.',
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
    const storyUnitPlan = this.storyUnitPlanForPrompt(args, volume);
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
      this.safeJson(args.storyUnitSlice ?? this.storyUnitSliceFromPlan(storyUnitPlan, allowedStoryUnitIds), 5000),
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
      'Hard output requirements:',
      `- Return exactly ${chapterCountForRange(chapterRange)} chapters: chapterNo ${chapterRange.start} through ${chapterRange.end}, continuous and in order.`,
      '- Every chapter must include title, objective, conflict, hook, outline, expectedWordCount, and a complete craftBrief.',
      '- Every craftBrief.actionBeats array must contain at least 3 concrete action nodes.',
      '- Every craftBrief.sceneBeats array must contain at least 3 concrete scene segments; each segment must include sceneArcId, scenePart, location, participants, localGoal, visibleAction, obstacle, turningPoint, partResult, and sensoryAnchor.',
      '- Every craftBrief.characterExecution.cast member must use source exactly existing, volume_candidate, or minor_temporary.',
      '- craftBrief.characterExecution.relationshipBeats may be []; if present, every object must include participants, publicStateBefore, trigger, shift, and publicStateAfter.',
      '- Keep JSON compact and valid; do not include Markdown fences or explanatory text.',
      '',
      'Required JSON shape:',
      this.buildRequiredJsonShapeExample(volumeNo, chapterRange, allowedStoryUnitIds),
    ].join('\n');
  }

  private buildResponseJsonSchema(allowedStoryUnitIds: string[]): { name: string; description: string; schema: Record<string, unknown>; strict: boolean } {
    const storyUnitIdSchema = allowedStoryUnitIds.length
      ? { type: 'string', enum: allowedStoryUnitIds }
      : { type: 'string' };
    const stringArraySchema = { type: 'array', items: { type: 'string' } };
    const integerArraySchema = { type: 'array', items: { type: 'integer' } };
    const chapterNoOrNullSchema = { type: ['integer', 'null'] };

    return {
      name: 'chapter_outline_batch_preview',
      description: 'Validated batch preview for continuous Chinese web-novel chapter outlines with complete craftBrief data.',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['batch', 'chapters', 'risks'],
        properties: {
          batch: { $ref: '#/$defs/batch' },
          chapters: { type: 'array', items: { $ref: '#/$defs/chapter' } },
          risks: stringArraySchema,
        },
        $defs: {
          chapterRange: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'end'],
            properties: {
              start: { type: 'integer' },
              end: { type: 'integer' },
            },
          },
          batch: {
            type: 'object',
            additionalProperties: false,
            required: ['volumeNo', 'chapterRange', 'storyUnitIds', 'continuityBridgeIn', 'continuityBridgeOut'],
            properties: {
              volumeNo: { type: 'integer' },
              chapterRange: { $ref: '#/$defs/chapterRange' },
              storyUnitIds: { type: 'array', items: storyUnitIdSchema },
              continuityBridgeIn: { type: 'string' },
              continuityBridgeOut: { type: 'string' },
            },
          },
          chapter: {
            type: 'object',
            additionalProperties: false,
            required: ['chapterNo', 'volumeNo', 'title', 'objective', 'conflict', 'hook', 'outline', 'expectedWordCount', 'craftBrief'],
            properties: {
              chapterNo: { type: 'integer' },
              volumeNo: { type: 'integer' },
              title: { type: 'string' },
              objective: { type: 'string' },
              conflict: { type: 'string' },
              hook: { type: 'string' },
              outline: { type: 'string' },
              expectedWordCount: { type: 'integer' },
              craftBrief: { $ref: '#/$defs/craftBrief' },
            },
          },
          craftBrief: {
            type: 'object',
            additionalProperties: false,
            required: [
              'visibleGoal',
              'hiddenEmotion',
              'coreConflict',
              'mainlineTask',
              'subplotTasks',
              'storyUnit',
              'actionBeats',
              'sceneBeats',
              'characterExecution',
              'concreteClues',
              'dialogueSubtext',
              'characterShift',
              'irreversibleConsequence',
              'progressTypes',
              'entryState',
              'exitState',
              'openLoops',
              'closedLoops',
              'handoffToNextChapter',
              'continuityState',
            ],
            properties: {
              visibleGoal: { type: 'string' },
              hiddenEmotion: { type: 'string' },
              coreConflict: { type: 'string' },
              mainlineTask: { type: 'string' },
              subplotTasks: stringArraySchema,
              storyUnit: { $ref: '#/$defs/storyUnit' },
              actionBeats: stringArraySchema,
              sceneBeats: { type: 'array', items: { $ref: '#/$defs/sceneBeat' } },
              characterExecution: { $ref: '#/$defs/characterExecution' },
              concreteClues: { type: 'array', items: { $ref: '#/$defs/concreteClue' } },
              dialogueSubtext: { type: 'string' },
              characterShift: { type: 'string' },
              irreversibleConsequence: { type: 'string' },
              progressTypes: stringArraySchema,
              entryState: { type: 'string' },
              exitState: { type: 'string' },
              openLoops: stringArraySchema,
              closedLoops: stringArraySchema,
              handoffToNextChapter: { type: 'string' },
              continuityState: { $ref: '#/$defs/continuityState' },
            },
          },
          storyUnit: {
            type: 'object',
            additionalProperties: false,
            required: [
              'unitId',
              'title',
              'chapterRange',
              'chapterRole',
              'localGoal',
              'localConflict',
              'serviceFunctions',
              'mainlineContribution',
              'characterContribution',
              'relationshipContribution',
              'worldOrThemeContribution',
              'unitPayoff',
              'stateChangeAfterUnit',
            ],
            properties: {
              unitId: storyUnitIdSchema,
              title: { type: 'string' },
              chapterRange: { $ref: '#/$defs/chapterRange' },
              chapterRole: { type: 'string' },
              localGoal: { type: 'string' },
              localConflict: { type: 'string' },
              serviceFunctions: stringArraySchema,
              mainlineContribution: { type: 'string' },
              characterContribution: { type: 'string' },
              relationshipContribution: { type: 'string' },
              worldOrThemeContribution: { type: 'string' },
              unitPayoff: { type: 'string' },
              stateChangeAfterUnit: { type: 'string' },
            },
          },
          sceneBeat: {
            type: 'object',
            additionalProperties: false,
            required: [
              'sceneArcId',
              'scenePart',
              'continuesFromChapterNo',
              'continuesToChapterNo',
              'location',
              'participants',
              'localGoal',
              'visibleAction',
              'obstacle',
              'turningPoint',
              'partResult',
              'sensoryAnchor',
            ],
            properties: {
              sceneArcId: { type: 'string' },
              scenePart: { type: 'string' },
              continuesFromChapterNo: chapterNoOrNullSchema,
              continuesToChapterNo: chapterNoOrNullSchema,
              location: { type: 'string' },
              participants: stringArraySchema,
              localGoal: { type: 'string' },
              visibleAction: { type: 'string' },
              obstacle: { type: 'string' },
              turningPoint: { type: 'string' },
              partResult: { type: 'string' },
              sensoryAnchor: { type: 'string' },
            },
          },
          characterExecution: {
            type: 'object',
            additionalProperties: false,
            required: ['povCharacter', 'cast', 'relationshipBeats', 'newMinorCharacters'],
            properties: {
              povCharacter: { type: 'string' },
              cast: { type: 'array', items: { $ref: '#/$defs/castMember' } },
              relationshipBeats: { type: 'array', items: { $ref: '#/$defs/relationshipBeat' } },
              newMinorCharacters: { type: 'array', items: { $ref: '#/$defs/newMinorCharacter' } },
            },
          },
          castMember: {
            type: 'object',
            additionalProperties: false,
            required: ['characterName', 'source', 'functionInChapter', 'visibleGoal', 'pressure', 'actionBeatRefs', 'sceneBeatRefs', 'entryState', 'exitState'],
            properties: {
              characterName: { type: 'string' },
              source: { type: 'string', enum: ['existing', 'volume_candidate', 'minor_temporary'] },
              functionInChapter: { type: 'string' },
              visibleGoal: { type: 'string' },
              pressure: { type: 'string' },
              actionBeatRefs: integerArraySchema,
              sceneBeatRefs: stringArraySchema,
              entryState: { type: 'string' },
              exitState: { type: 'string' },
            },
          },
          relationshipBeat: {
            type: 'object',
            additionalProperties: false,
            required: ['participants', 'publicStateBefore', 'trigger', 'shift', 'publicStateAfter'],
            properties: {
              participants: stringArraySchema,
              publicStateBefore: { type: 'string' },
              trigger: { type: 'string' },
              shift: { type: 'string' },
              publicStateAfter: { type: 'string' },
            },
          },
          newMinorCharacter: {
            type: 'object',
            additionalProperties: false,
            required: ['nameOrLabel', 'narrativeFunction', 'interactionScope', 'firstAndOnlyUse', 'approvalPolicy'],
            properties: {
              nameOrLabel: { type: 'string' },
              narrativeFunction: { type: 'string' },
              interactionScope: { type: 'string' },
              firstAndOnlyUse: { type: 'boolean' },
              approvalPolicy: { type: 'string', enum: ['preview_only', 'needs_approval'] },
            },
          },
          concreteClue: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'sensoryDetail', 'laterUse'],
            properties: {
              name: { type: 'string' },
              sensoryDetail: { type: 'string' },
              laterUse: { type: 'string' },
            },
          },
          continuityState: {
            type: 'object',
            additionalProperties: false,
            required: ['characterPositions', 'activeThreats', 'ownedClues', 'relationshipChanges', 'nextImmediatePressure'],
            properties: {
              characterPositions: stringArraySchema,
              activeThreats: stringArraySchema,
              ownedClues: stringArraySchema,
              relationshipChanges: stringArraySchema,
              nextImmediatePressure: { type: 'string' },
            },
          },
        },
      },
    };
  }

  private buildRequiredJsonShapeExample(volumeNo: number, chapterRange: ChapterRange, allowedStoryUnitIds: string[]): string {
    const chapterNo = chapterRange.start;
    const storyUnitId = allowedStoryUnitIds[0] ?? 'allowed_story_unit_id';
    return JSON.stringify({
      batch: {
        volumeNo,
        chapterRange,
        storyUnitIds: allowedStoryUnitIds.length ? allowedStoryUnitIds : [storyUnitId],
        continuityBridgeIn: 'how this batch enters from prior pressure',
        continuityBridgeOut: 'how the final chapter hands off',
      },
      chapters: [{
        chapterNo,
        volumeNo,
        title: '...',
        objective: '...',
        conflict: '...',
        hook: '...',
        outline: '...',
        expectedWordCount: 2500,
        craftBrief: {
          visibleGoal: '...',
          hiddenEmotion: '...',
          coreConflict: '...',
          mainlineTask: '...',
          subplotTasks: ['...'],
          storyUnit: {
            unitId: storyUnitId,
            title: '...',
            chapterRange,
            chapterRole: '...',
            localGoal: '...',
            localConflict: '...',
            serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
            mainlineContribution: '...',
            characterContribution: '...',
            relationshipContribution: '...',
            worldOrThemeContribution: '...',
            unitPayoff: '...',
            stateChangeAfterUnit: '...',
          },
          actionBeats: ['...', '...', '...'],
          sceneBeats: [
            {
              sceneArcId: 'scene_1',
              scenePart: '1/3',
              continuesFromChapterNo: null,
              continuesToChapterNo: null,
              location: '...',
              participants: ['...'],
              localGoal: '...',
              visibleAction: '...',
              obstacle: '...',
              turningPoint: '...',
              partResult: '...',
              sensoryAnchor: '...',
            },
            {
              sceneArcId: 'scene_2',
              scenePart: '2/3',
              continuesFromChapterNo: null,
              continuesToChapterNo: null,
              location: '...',
              participants: ['...'],
              localGoal: '...',
              visibleAction: '...',
              obstacle: '...',
              turningPoint: '...',
              partResult: '...',
              sensoryAnchor: '...',
            },
            {
              sceneArcId: 'scene_3',
              scenePart: '3/3',
              continuesFromChapterNo: null,
              continuesToChapterNo: null,
              location: '...',
              participants: ['...'],
              localGoal: '...',
              visibleAction: '...',
              obstacle: '...',
              turningPoint: '...',
              partResult: '...',
              sensoryAnchor: '...',
            },
          ],
          characterExecution: {
            povCharacter: '...',
            cast: [{
              characterName: '...',
              source: 'existing',
              functionInChapter: '...',
              visibleGoal: '...',
              pressure: '...',
              actionBeatRefs: [1],
              sceneBeatRefs: ['scene_1', 'scene_2', 'scene_3'],
              entryState: '...',
              exitState: '...',
            }],
            relationshipBeats: [{
              participants: ['...', '...'],
              publicStateBefore: '...',
              trigger: '...',
              shift: '...',
              publicStateAfter: '...',
            }],
            newMinorCharacters: [],
          },
          concreteClues: [{ name: '...', sensoryDetail: '...', laterUse: '...' }],
          dialogueSubtext: '...',
          characterShift: '...',
          irreversibleConsequence: '...',
          progressTypes: ['info'],
          entryState: '...',
          exitState: '...',
          openLoops: ['...'],
          closedLoops: ['...'],
          handoffToNextChapter: '...',
          continuityState: {
            characterPositions: ['...'],
            activeThreats: ['...'],
            ownedClues: ['...'],
            relationshipChanges: ['...'],
            nextImmediatePressure: '...',
          },
        },
      }],
      risks: [],
    });
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

  private storyUnitPlanForPrompt(args: GenerateChapterOutlineBatchPreviewInput, volume: Record<string, unknown>): unknown {
    const provided = asRecord(args.storyUnitPlan);
    if (Object.keys(provided).length) return provided;
    return asRecord(volume.narrativePlan).storyUnitPlan;
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

  private volumeRepairSummary(volume: Record<string, unknown>): Record<string, unknown> {
    const narrativePlan = asRecord(volume.narrativePlan);
    return {
      volumeNo: volume.volumeNo,
      title: volume.title,
      objective: volume.objective,
      chapterCount: volume.chapterCount,
      narrativePlan: {
        globalMainlineStage: narrativePlan.globalMainlineStage,
        volumeMainline: narrativePlan.volumeMainline,
        dramaticQuestion: narrativePlan.dramaticQuestion,
        startState: narrativePlan.startState,
        endState: narrativePlan.endState,
        endingHook: narrativePlan.endingHook,
        storyUnits: Array.isArray(narrativePlan.storyUnits) ? narrativePlan.storyUnits : undefined,
        characterPlan: narrativePlan.characterPlan,
      },
    };
  }

  private safeJson(value: unknown, limit: number): string {
    const json = JSON.stringify(value ?? {});
    return json.length > limit ? `${json.slice(0, limit)}...` : json;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

interface MergeChapterOutlineBatchPreviewsInput {
  context?: Record<string, unknown>;
  volumeOutline?: Record<string, unknown>;
  storyUnitPlan?: Record<string, unknown>;
  volumeNo?: number;
  chapterCount?: number;
  batchPreviews?: ChapterOutlineBatchPreviewOutput[];
}

@Injectable()
export class MergeChapterOutlineBatchPreviewsTool implements BaseTool<MergeChapterOutlineBatchPreviewsInput, OutlinePreviewOutput> {
  name = 'merge_chapter_outline_batch_previews';
  description = 'Merge validated chapter outline batch previews into a standard OutlinePreviewOutput without filling missing chapters or craftBrief data.';
  inputSchema = {
    type: 'object' as const,
    required: ['batchPreviews', 'volumeNo', 'chapterCount'],
    properties: {
      context: { type: 'object' as const },
      volumeOutline: { type: 'object' as const },
      storyUnitPlan: { type: 'object' as const },
      volumeNo: { type: 'number' as const },
      chapterCount: { type: 'number' as const },
      batchPreviews: { type: 'array' as const, items: { type: 'object' as const } },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['volume', 'chapters', 'risks'],
    properties: {
      volume: { type: 'object' as const },
      chapters: { type: 'array' as const },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Merge chapter outline batch previews',
    description: 'Combines generate_chapter_outline_batch_preview outputs into standard outline_preview; fails on missing chapters, duplicate chapters, overlapping batches, incomplete craftBrief, or invalid characterExecution sources.',
    whenToUse: [
      'After every generate_chapter_outline_batch_preview step has succeeded for a whole-volume chapter outline plan.',
      'Before approval-gated persist_outline; do not append a terminal validate_outline for batch chapter outlines.',
    ],
    whenNotToUse: [
      'Do not use before every target chapter has a batch preview.',
      'Do not use for single-chapter preview merges; use merge_chapter_outline_previews.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      batchPreviews: { source: 'previous_step', description: 'All generate_chapter_outline_batch_preview outputs in chapter order.' },
      context: { source: 'previous_step', description: 'inspect_project_context.output for target volume metadata and existing character whitelist.' },
      volumeOutline: { source: 'previous_step', description: 'Optional generate_volume_outline_preview.output.volume when this run rebuilt the volume outline.' },
      storyUnitPlan: { source: 'previous_step', description: 'Optional generate_story_units_preview.output.storyUnitPlan when this run rebuilt story units; copied into volume.narrativePlan before persist_outline.' },
      volumeNo: { source: 'user_message', description: 'Target volume number.' },
      chapterCount: { source: 'user_message', description: 'Target full-volume chapter count.' },
    },
    failureHints: [
      { code: 'BATCH_MERGE_COVERAGE_INVALID', meaning: 'Batch previews do not cover 1..chapterCount exactly.', suggestedRepair: 'Regenerate or repair the missing/overlapping batch; do not synthesize chapters.' },
      { code: 'BATCH_MERGE_CRAFT_BRIEF_INVALID', meaning: 'A merged chapter has incomplete craftBrief or invalid characterExecution.', suggestedRepair: 'Regenerate the offending batch preview.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  async run(args: MergeChapterOutlineBatchPreviewsInput, _context: ToolContext): Promise<OutlinePreviewOutput> {
    const batchPreviews = Array.isArray(args.batchPreviews) ? args.batchPreviews : [];
    const volumeNo = positiveInt(args.volumeNo);
    const chapterCount = positiveInt(args.chapterCount);
    if (!volumeNo) throw new Error('merge_chapter_outline_batch_previews requires a valid volumeNo.');
    if (!chapterCount) throw new Error('merge_chapter_outline_batch_previews requires a valid chapterCount.');
    if (!batchPreviews.length) throw new Error('merge_chapter_outline_batch_previews requires batchPreviews.');

    const normalizedBatches = batchPreviews.map((preview, index) => this.normalizeBatchPreview(preview, index + 1, volumeNo));
    assertChapterRangeCoverage({
      chapterCount,
      ranges: normalizedBatches.map((preview) => ({ chapterRange: preview.batch.chapterRange, label: `batch ${preview.batch.batchNo}` })),
      label: 'merge_chapter_outline_batch_previews batch coverage',
    });

    const volume = this.resolveVolume(args.context, args.volumeOutline, args.storyUnitPlan, volumeNo, chapterCount);
    const characterCatalog = this.extractCharacterCatalog(args.context, volume, chapterCount);
    const chapters = normalizedBatches
      .flatMap((batch) => batch.chapters.map((chapter) => ({ chapter, batchRange: batch.batch.chapterRange })))
      .sort((left, right) => Number(left.chapter.chapterNo) - Number(right.chapter.chapterNo));

    assertChapterRangeCoverage({
      chapterCount,
      ranges: chapters.map(({ chapter }) => ({ chapterRange: { start: Number(chapter.chapterNo), end: Number(chapter.chapterNo) }, label: `chapter ${chapter.chapterNo}` })),
      label: 'merge_chapter_outline_batch_previews chapter coverage',
    });

    for (const { chapter, batchRange } of chapters) {
      if (Number(chapter.volumeNo) !== volumeNo) throw new Error(`merge_chapter_outline_batch_previews chapter ${chapter.chapterNo} volumeNo mismatch.`);
      if (Number(chapter.chapterNo) < batchRange.start || Number(chapter.chapterNo) > batchRange.end) {
        throw new Error(`merge_chapter_outline_batch_previews chapter ${chapter.chapterNo} is outside its batch range ${batchRange.start}-${batchRange.end}.`);
      }
      this.assertCompleteChapter(chapter, characterCatalog);
    }
    this.assertBatchContinuity(normalizedBatches);

    return {
      volume,
      chapters: chapters.map((item) => item.chapter),
      risks: [
        `Merged ${normalizedBatches.length} chapter-outline batches into ${chapterCount} chapters; no missing chapter content was synthesized.`,
        ...normalizedBatches.flatMap((batch) => batch.risks.map((risk) => `batch ${batch.batch.batchNo}: ${risk}`)),
      ],
    };
  }

  private normalizeBatchPreview(value: unknown, fallbackBatchNo: number, volumeNo: number): ChapterOutlineBatchPreviewOutput & { batch: ChapterOutlineBatchPreviewOutput['batch'] & { batchNo: number } } {
    const record = asRecord(value);
    const batch = asRecord(record.batch);
    const chapterRange = this.normalizeInputRange(batch.chapterRange);
    if (!chapterRange) throw new Error(`merge_chapter_outline_batch_previews batch ${fallbackBatchNo} missing valid chapterRange.`);
    if (positiveInt(batch.volumeNo) !== volumeNo) throw new Error(`merge_chapter_outline_batch_previews batch ${fallbackBatchNo} volumeNo mismatch.`);
    const chapters = asRecordArray(record.chapters) as unknown as OutlinePreviewOutput['chapters'];
    if (!chapters.length) throw new Error(`merge_chapter_outline_batch_previews batch ${fallbackBatchNo} has no chapters.`);
    return {
      batch: {
        batchNo: fallbackBatchNo,
        volumeNo,
        chapterRange,
        storyUnitIds: stringArray(batch.storyUnitIds),
        continuityBridgeIn: this.requiredText(batch.continuityBridgeIn, `batch ${fallbackBatchNo}.continuityBridgeIn`),
        continuityBridgeOut: this.requiredText(batch.continuityBridgeOut, `batch ${fallbackBatchNo}.continuityBridgeOut`),
      },
      chapters,
      risks: stringArray(record.risks),
      repairDiagnostics: Array.isArray(record.repairDiagnostics) ? record.repairDiagnostics as ChapterOutlineBatchPreviewOutput['repairDiagnostics'] : undefined,
    };
  }

  private assertCompleteChapter(chapter: OutlinePreviewOutput['chapters'][number], characterCatalog: CharacterReferenceCatalog & { volumeCandidateNames: string[] }): void {
    const chapterNo = positiveInt(chapter.chapterNo);
    if (!chapterNo) throw new Error('merge_chapter_outline_batch_previews encountered chapter without chapterNo.');
    this.requiredText(chapter.title, `chapter ${chapterNo}.title`);
    this.requiredText(chapter.objective, `chapter ${chapterNo}.objective`);
    this.requiredText(chapter.conflict, `chapter ${chapterNo}.conflict`);
    this.requiredText(chapter.hook, `chapter ${chapterNo}.hook`);
    this.requiredText(chapter.outline, `chapter ${chapterNo}.outline`);
    if (!positiveInt(chapter.expectedWordCount)) throw new Error(`merge_chapter_outline_batch_previews chapter ${chapterNo} expectedWordCount is invalid.`);
    const craftBrief = asRecord(chapter.craftBrief);
    if (!Object.keys(craftBrief).length) throw new Error(`merge_chapter_outline_batch_previews chapter ${chapterNo} missing craftBrief.`);
    assertCompleteChapterCraftBrief(craftBrief, { label: `merge_chapter_outline_batch_previews chapter ${chapterNo}.craftBrief` });
    for (const field of ['visibleGoal', 'hiddenEmotion', 'coreConflict', 'mainlineTask', 'dialogueSubtext', 'characterShift', 'irreversibleConsequence', 'entryState', 'exitState', 'handoffToNextChapter']) {
      this.requiredText(craftBrief[field], `chapter ${chapterNo}.craftBrief.${field}`);
    }
    for (const field of ['subplotTasks', 'actionBeats', 'progressTypes', 'openLoops', 'closedLoops']) {
      if (!stringArray(craftBrief[field]).length) throw new Error(`merge_chapter_outline_batch_previews chapter ${chapterNo} craftBrief.${field} is required.`);
    }
    const storyUnit = asRecord(craftBrief.storyUnit);
    if (!text(storyUnit.unitId)) throw new Error(`merge_chapter_outline_batch_previews chapter ${chapterNo} craftBrief.storyUnit.unitId is required.`);
    const actionBeats = stringArray(craftBrief.actionBeats);
    const sceneBeats = asRecordArray(craftBrief.sceneBeats);
    if (actionBeats.length < 3 || sceneBeats.length < 3) {
      throw new Error(`merge_chapter_outline_batch_previews chapter ${chapterNo} craftBrief actionBeats/sceneBeats are incomplete.`);
    }
    const continuityState = asRecord(craftBrief.continuityState);
    this.requiredText(continuityState.nextImmediatePressure, `chapter ${chapterNo}.craftBrief.continuityState.nextImmediatePressure`);
    assertChapterCharacterExecution(craftBrief.characterExecution, {
      existingCharacterNames: characterCatalog.existingCharacterNames,
      existingCharacterAliases: characterCatalog.existingCharacterAliases,
      volumeCandidateNames: characterCatalog.volumeCandidateNames,
      actionBeatCount: actionBeats.length,
      sceneBeats,
      label: `chapter ${chapterNo}.craftBrief.characterExecution`,
    });
  }

  private assertBatchContinuity(batches: Array<ChapterOutlineBatchPreviewOutput & { batch: ChapterOutlineBatchPreviewOutput['batch'] & { batchNo: number } }>): void {
    const ordered = [...batches].sort((left, right) => left.batch.chapterRange.start - right.batch.chapterRange.start);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const next = ordered[index];
      const previousLast = [...previous.chapters].sort((left, right) => Number(right.chapterNo) - Number(left.chapterNo))[0];
      const nextFirst = [...next.chapters].sort((left, right) => Number(left.chapterNo) - Number(right.chapterNo))[0];
      const previousBrief = asRecord(previousLast?.craftBrief);
      const nextBrief = asRecord(nextFirst?.craftBrief);
      this.requiredText(previousBrief.handoffToNextChapter, `batch ${previous.batch.batchNo} final handoffToNextChapter`);
      this.requiredText(asRecord(previousBrief.continuityState).nextImmediatePressure, `batch ${previous.batch.batchNo} final nextImmediatePressure`);
      this.requiredText(nextBrief.entryState, `batch ${next.batch.batchNo} first entryState`);
      if (!stringArray(nextBrief.openLoops).length) throw new Error(`merge_chapter_outline_batch_previews batch ${next.batch.batchNo} first chapter openLoops is required.`);
    }
  }

  private resolveVolume(contextValue: unknown, volumeOutlineValue: unknown, storyUnitPlanValue: unknown, volumeNo: number, chapterCount: number): OutlinePreviewOutput['volume'] {
    const volume = this.findTargetVolume(contextValue, volumeOutlineValue, volumeNo);
    if (!Object.keys(volume).length) throw new Error(`merge_chapter_outline_batch_previews cannot resolve volume ${volumeNo}.`);
    if (positiveInt(volume.volumeNo) !== volumeNo) throw new Error('merge_chapter_outline_batch_previews volumeNo mismatch.');
    if (positiveInt(volume.chapterCount) !== chapterCount) throw new Error('merge_chapter_outline_batch_previews volume.chapterCount mismatch.');
    const narrativePlan = { ...asRecord(volume.narrativePlan) };
    const storyUnitPlan = asRecord(storyUnitPlanValue);
    if (Object.keys(storyUnitPlan).length) {
      narrativePlan.storyUnitPlan = assertVolumeStoryUnitPlan(storyUnitPlan, {
        volumeNo,
        chapterCount,
        label: 'merge_chapter_outline_batch_previews.storyUnitPlan',
      }) as unknown as Record<string, unknown>;
    }
    return {
      volumeNo,
      title: this.requiredText(volume.title, 'volume.title'),
      synopsis: this.requiredText(volume.synopsis, 'volume.synopsis'),
      objective: this.requiredText(volume.objective, 'volume.objective'),
      chapterCount,
      ...(Object.keys(narrativePlan).length ? { narrativePlan } : {}),
    };
  }

  private extractCharacterCatalog(contextValue: unknown, volume: OutlinePreviewOutput['volume'], chapterCount: number): CharacterReferenceCatalog & { volumeCandidateNames: string[] } {
    const context = asRecord(contextValue);
    const existingCharacterNames: string[] = [];
    const existingCharacterAliases: Record<string, string[]> = {};
    for (const item of asRecordArray(context.characters)) {
      const name = text(item.name);
      if (!name) continue;
      existingCharacterNames.push(name);
      const aliases = stringArray(item.aliases).length ? stringArray(item.aliases) : stringArray(item.alias);
      if (aliases.length) existingCharacterAliases[name] = aliases;
    }
    const narrativePlan = asRecord(volume.narrativePlan);
    const characterPlan = assertVolumeCharacterPlan(narrativePlan.characterPlan, {
      chapterCount,
      existingCharacterNames,
      existingCharacterAliases,
      label: 'merge_chapter_outline_batch_previews.volume.characterPlan',
    });
    return {
      existingCharacterNames,
      existingCharacterAliases,
      volumeCandidateNames: characterPlan.newCharacterCandidates.map((candidate) => candidate.name),
    };
  }

  private findTargetVolume(contextValue: unknown, volumeOutlineValue: unknown, volumeNo: number): Record<string, unknown> {
    const volumeOutline = asRecord(volumeOutlineValue);
    if (Object.keys(volumeOutline).length) return volumeOutline;
    return asRecordArray(asRecord(contextValue).volumes).find((volume) => Number(volume.volumeNo) === volumeNo) ?? {};
  }

  private normalizeInputRange(value: unknown): ChapterRange | undefined {
    const range = asRecord(value);
    const start = positiveInt(range.start);
    const end = positiveInt(range.end);
    return start && end && end >= start ? { start, end } : undefined;
  }

  private requiredText(value: unknown, label: string): string {
    const item = text(value);
    if (!item) throw new Error(`merge_chapter_outline_batch_previews missing ${label}.`);
    return item;
  }
}
