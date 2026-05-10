import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import {
  asRecord,
  asRecordArray,
  assertChapterRangeCoverage,
  ChapterOutlineBatch,
  ChapterOutlineBatchPlan,
  ChapterRange,
  positiveInt,
} from './chapter-outline-batch-contracts';
import { assertVolumeStoryUnitPlan, type VolumeStoryUnitPlan } from './story-unit-contracts';

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
