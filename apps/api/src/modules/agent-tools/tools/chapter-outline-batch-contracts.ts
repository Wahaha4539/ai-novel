import type { OutlinePreviewOutput } from './generate-outline-preview.tool';

export interface ChapterRange {
  start: number;
  end: number;
}

export interface ChapterOutlineBatch {
  batchNo: number;
  chapterRange: ChapterRange;
  storyUnitIds: string[];
  reason: string;
}

export interface ChapterOutlineBatchPlan {
  volumeNo: number;
  chapterCount: number;
  batches: ChapterOutlineBatch[];
  risks: string[];
}

export interface ChapterOutlineBatchQualityIssue {
  severity: 'warning' | 'error';
  chapterNo?: number;
  path?: string;
  message: string;
  suggestion?: string;
  evidence?: string;
}

export interface ChapterOutlineBatchQualityReview {
  valid: boolean;
  summary?: string;
  issues: ChapterOutlineBatchQualityIssue[];
}

export interface BuildChapterOutlineBatchesOptions {
  preferredBatchSize?: number;
  maxBatchSize?: number;
  label?: string;
}

export interface ChapterOutlineBatchStoryUnitPlanLike {
  chapterAllocation?: Array<{ unitId: string; chapterRange: ChapterRange }>;
  units: Array<{ unitId: string; title?: string }>;
}

export const DEFAULT_CHAPTER_OUTLINE_PREFERRED_BATCH_SIZE = 4;
export const DEFAULT_CHAPTER_OUTLINE_MAX_BATCH_SIZE = 5;
export const MIN_CHAPTER_OUTLINE_BATCH_SIZE = 3;

export interface ChapterOutlineBatchPreviewOutput {
  batch: {
    volumeNo: number;
    chapterRange: ChapterRange;
    storyUnitIds: string[];
    continuityBridgeIn: string;
    continuityBridgeOut: string;
  };
  chapters: OutlinePreviewOutput['chapters'];
  risks: string[];
  qualityReview?: ChapterOutlineBatchQualityReview;
  repairDiagnostics?: Array<{
    attempted: boolean;
    attempts: number;
    repairedFromErrors: string[];
    model?: string;
  }>;
}

export interface AssertChapterRangeCoverageInput {
  chapterCount: number;
  ranges: Array<{ chapterRange: ChapterRange; label?: string }>;
  label: string;
}

/**
 * Structural guard for chapter outline planning. It validates numeric coverage only;
 * it must never invent chapter outlines, craftBrief data, or story content.
 */
export function assertChapterRangeCoverage(input: AssertChapterRangeCoverageInput): void {
  const chapterCount = positiveInt(input.chapterCount);
  if (!chapterCount) throw new Error(`${input.label} requires a positive chapterCount.`);
  if (!input.ranges.length) throw new Error(`${input.label} requires at least one chapter range.`);

  const seen = new Map<number, string>();
  let expectedStart = 1;
  for (const [index, item] of input.ranges.entries()) {
    const rangeLabel = item.label ?? `${input.label}[${index}]`;
    const start = positiveInt(item.chapterRange?.start);
    const end = positiveInt(item.chapterRange?.end);
    if (!start || !end || end < start) {
      throw new Error(`${rangeLabel} has an invalid chapterRange.`);
    }
    if (start !== expectedStart) {
      throw new Error(`${input.label} is not continuous: expected chapter ${expectedStart}, got ${start}.`);
    }
    if (end > chapterCount) {
      throw new Error(`${rangeLabel} is out of range: ${start}-${end} exceeds chapterCount ${chapterCount}.`);
    }
    for (let chapterNo = start; chapterNo <= end; chapterNo += 1) {
      const previous = seen.get(chapterNo);
      if (previous) {
        throw new Error(`${input.label} overlaps at chapter ${chapterNo}: ${previous} and ${rangeLabel}.`);
      }
      seen.set(chapterNo, rangeLabel);
    }
    expectedStart = end + 1;
  }

  const missing = Array.from({ length: chapterCount }, (_item, index) => index + 1)
    .filter((chapterNo) => !seen.has(chapterNo));
  if (missing.length) {
    throw new Error(`${input.label} is missing chapters: ${missing.join(', ')}.`);
  }
}

/**
 * Shared structural splitter for chapter-outline batches. It follows upstream
 * storyUnitPlan.chapterAllocation and never invents chapter or craftBrief content.
 */
export function buildChapterOutlineBatchesFromStoryUnitPlan(
  storyUnitPlan: ChapterOutlineBatchStoryUnitPlanLike,
  options: BuildChapterOutlineBatchesOptions = {},
): ChapterOutlineBatch[] {
  const label = options.label ?? 'chapter outline batch plan';
  const preferredBatchSize = normalizeChapterOutlineBatchSize(options.preferredBatchSize, DEFAULT_CHAPTER_OUTLINE_PREFERRED_BATCH_SIZE);
  const maxBatchSize = Math.max(preferredBatchSize, normalizeChapterOutlineBatchSize(options.maxBatchSize, DEFAULT_CHAPTER_OUTLINE_MAX_BATCH_SIZE));
  const allocations = [...(storyUnitPlan.chapterAllocation ?? [])].sort((left, right) => left.chapterRange.start - right.chapterRange.start);
  if (!allocations.length) throw new Error(`${label} requires storyUnitPlan.chapterAllocation.`);

  const batches: ChapterOutlineBatch[] = [];
  for (const allocation of allocations) {
    const unit = storyUnitPlan.units.find((item) => item.unitId === allocation.unitId);
    const title = unit?.title ? ` (${unit.title})` : '';
    for (const range of splitChapterRangeIntoBatches(allocation.chapterRange, preferredBatchSize, maxBatchSize, label)) {
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

export function splitChapterRangeIntoBatches(range: ChapterRange, preferredBatchSize: number, maxBatchSize: number, label = 'chapter outline batch plan'): ChapterRange[] {
  const total = range.end - range.start + 1;
  if (total <= 0) throw new Error(`${label} received an invalid storyUnit chapterRange.`);
  if (total <= maxBatchSize) return [{ start: range.start, end: range.end }];

  let batchCount = Math.ceil(total / preferredBatchSize);
  while (Math.ceil(total / batchCount) > maxBatchSize) batchCount += 1;
  while (batchCount > 1 && Math.floor(total / batchCount) < MIN_CHAPTER_OUTLINE_BATCH_SIZE && Math.ceil(total / (batchCount - 1)) <= maxBatchSize) {
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

export function normalizeChapterOutlineBatchSize(value: unknown, fallback: number): number {
  const numeric = positiveInt(value);
  if (!numeric) return fallback;
  return Math.max(1, Math.min(8, numeric));
}

export function chapterCountForRange(range: ChapterRange): number {
  const start = positiveInt(range.start);
  const end = positiveInt(range.end);
  if (!start || !end || end < start) throw new Error('Invalid chapter range.');
  return end - start + 1;
}

export function positiveInt(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item) => Object.keys(item).length > 0) : [];
}

export function text(value: unknown, defaultValue = ''): string {
  if (typeof value === 'string') return value.trim() || defaultValue;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return defaultValue;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}
