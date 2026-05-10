import type { AgentPlanStep, AgentRunStepRecord } from '../../hooks/useAgentRun';

export interface ChapterRangeView {
  start: number;
  end: number;
}

export interface OutlineChapterCoverageView {
  totalChapters: number;
  visibleChapters: number[];
  batchCount: number;
  singleChapterCount: number;
}

export interface OutlineChapterProgressView extends OutlineChapterCoverageView {
  generatedChapters: number[];
  generatedCount: number;
}

const BATCH_PREVIEW_TOOL = 'generate_chapter_outline_batch_preview';
const SINGLE_PREVIEW_TOOL = 'generate_chapter_outline_preview';

export function chapterRangeFromPlanStep(step: Pick<AgentPlanStep, 'tool' | 'args'>): ChapterRangeView | undefined {
  const args = asRecord(step.args);
  if (step.tool === BATCH_PREVIEW_TOOL) {
    const range = asRecord(args.chapterRange);
    const start = positiveInt(range.start);
    const end = positiveInt(range.end);
    return start && end && end >= start ? { start, end } : undefined;
  }
  if (step.tool === SINGLE_PREVIEW_TOOL) {
    const chapterNo = positiveInt(args.chapterNo);
    return chapterNo ? { start: chapterNo, end: chapterNo } : undefined;
  }
  return undefined;
}

export function chapterNosFromPlanStep(step: Pick<AgentPlanStep, 'tool' | 'args'>): number[] {
  const range = chapterRangeFromPlanStep(step);
  if (!range) return [];
  return Array.from({ length: range.end - range.start + 1 }, (_item, index) => range.start + index);
}

export function chapterRangeLabel(step: Pick<AgentPlanStep, 'tool' | 'args'>): string | undefined {
  const range = chapterRangeFromPlanStep(step);
  if (!range) return undefined;
  return range.start === range.end ? `第 ${range.start} 章` : `第 ${range.start}-${range.end} 章`;
}

export function outlineChapterCoverage(planSteps: AgentPlanStep[]): OutlineChapterCoverageView | undefined {
  const visibleChapters = uniqueSorted(planSteps.flatMap((step) => chapterNosFromPlanStep(step)));
  if (!visibleChapters.length) return undefined;
  const targetCounts = planSteps
    .map((step) => positiveInt(asRecord(step.args).chapterCount))
    .filter((item): item is number => Boolean(item));
  const totalChapters = Math.max(...targetCounts, visibleChapters[visibleChapters.length - 1] ?? 0);
  return {
    totalChapters,
    visibleChapters,
    batchCount: planSteps.filter((step) => step.tool === BATCH_PREVIEW_TOOL).length,
    singleChapterCount: planSteps.filter((step) => step.tool === SINGLE_PREVIEW_TOOL).length,
  };
}

export function outlineChapterProgress(planSteps: AgentPlanStep[], runSteps: AgentRunStepRecord[], activePlanVersion: number): OutlineChapterProgressView | undefined {
  const coverage = outlineChapterCoverage(planSteps);
  if (!coverage) return undefined;
  const generatedChapters = uniqueSorted(planSteps.flatMap((step) => {
    if (step.tool !== BATCH_PREVIEW_TOOL && step.tool !== SINGLE_PREVIEW_TOOL) return [];
    const record = findRunStepRecord(runSteps, step.stepNo, activePlanVersion);
    return record?.status === 'succeeded' ? chapterNosFromPlanStep(step) : [];
  }));
  return {
    ...coverage,
    generatedChapters,
    generatedCount: generatedChapters.length,
  };
}

export function formatChapterProgress(progress: Pick<OutlineChapterProgressView, 'generatedCount' | 'totalChapters'>): string {
  return `${progress.generatedCount}/${progress.totalChapters}`;
}

function findRunStepRecord(records: AgentRunStepRecord[], stepNo: number, planVersion: number): AgentRunStepRecord | undefined {
  const matching = records.filter((item) => item.stepNo === stepNo && (item.planVersion ?? 1) === planVersion);
  return matching.find((item) => item.mode === 'act') ?? matching.find((item) => item.mode === 'plan') ?? matching[0];
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInt(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}
