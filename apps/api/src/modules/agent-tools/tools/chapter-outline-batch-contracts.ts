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
