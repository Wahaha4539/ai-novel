import { Injectable } from '@nestjs/common';
import { IMPORT_ASSET_TYPES, type ImportAssetType } from '../../agent-tools/tools/import-preview.types';
import type { AgentContextV2 } from '../agent-context-builder.service';
import type { AgentPlanSpec } from '../agent-planner.service';
import type { RouteDecision, SelectedToolBundle } from './planner-graph.state';

export interface PlanValidatorInput {
  plan: AgentPlanSpec;
  context?: AgentContextV2;
  route?: RouteDecision;
  selectedBundle?: SelectedToolBundle;
}

export interface RawPlanValidatorInput {
  data: unknown;
  context?: AgentContextV2;
  route?: RouteDecision;
  selectedBundle?: SelectedToolBundle;
}

const IMPORT_TARGET_TOOL_BY_ASSET_TYPE: Record<ImportAssetType, string> = {
  projectProfile: 'generate_import_project_profile_preview',
  outline: 'generate_import_outline_preview',
  characters: 'generate_import_characters_preview',
  worldbuilding: 'generate_import_worldbuilding_preview',
  writingRules: 'generate_import_writing_rules_preview',
};

const IMPORT_TARGET_ASSET_BY_TOOL = new Map<string, ImportAssetType>(
  Object.entries(IMPORT_TARGET_TOOL_BY_ASSET_TYPE).map(([assetType, tool]) => [tool, assetType as ImportAssetType]),
);

const WRITE_TOOL_NAMES = new Set([
  'write_chapter',
  'write_chapter_series',
  'rewrite_chapter',
  'polish_chapter',
  'auto_repair_chapter',
  'extract_chapter_facts',
  'rebuild_memory',
  'ai_quality_review',
]);

const GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL = 'generate_chapter_outline_preview';
const MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL = 'merge_chapter_outline_previews';
const SEGMENT_CHAPTER_OUTLINE_BATCHES_TOOL = 'segment_chapter_outline_batches';
const GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL = 'generate_chapter_outline_batch_preview';
const MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL = 'merge_chapter_outline_batch_previews';

interface ChapterRange {
  start: number;
  end: number;
}

@Injectable()
export class PlanValidatorService {
  validateRaw(input: RawPlanValidatorInput): void {
    const plan = this.rawPlan(input.data);
    if (!plan) return;
    this.assertBundleTools(plan, input.selectedBundle);
    this.assertRouteBoundaries(plan, input.route);
    this.assertImportScope(plan, input.route, input.context);
  }

  validate(input: PlanValidatorInput): void {
    this.assertBundleTools(input.plan, input.selectedBundle);
    this.assertWriteApproval(input.plan);
    this.assertRouteBoundaries(input.plan, input.route);
    this.assertImportScope(input.plan, input.route, input.context);
  }

  private assertBundleTools(plan: AgentPlanSpec, selectedBundle?: SelectedToolBundle): void {
    if (!selectedBundle) return;
    const allowed = new Set([...selectedBundle.strictToolNames, ...selectedBundle.optionalToolNames]);
    const outside = plan.steps.map((step) => step.tool).filter((tool) => !allowed.has(tool));
    if (outside.length) {
      throw new Error(`PlanValidator blocked bundle-outside tools for ${selectedBundle.bundleName}: ${[...new Set(outside)].join(', ')}`);
    }
  }

  private assertWriteApproval(plan: AgentPlanSpec): void {
    const unsafe = plan.steps.filter((step) => (WRITE_TOOL_NAMES.has(step.tool) || step.tool.startsWith('persist_')) && !step.requiresApproval);
    if (unsafe.length) throw new Error(`PlanValidator blocked write tools without approval: ${unsafe.map((step) => step.tool).join(', ')}`);
  }

  private assertRouteBoundaries(plan: AgentPlanSpec, route?: RouteDecision): void {
    if (!route) return;
    const tools = new Set(plan.steps.map((step) => step.tool));
    if (route.domain === 'outline' && route.intent === 'generate_volume_outline') {
      this.rejectTools(tools, ['generate_outline_preview', GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL, MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL, SEGMENT_CHAPTER_OUTLINE_BATCHES_TOOL, GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL, MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL, 'validate_outline', 'persist_outline', 'write_chapter', 'write_chapter_series'], 'volume outline route');
    }
    if (route.domain === 'outline' && route.intent === 'split_volume_to_chapters') {
      if (!tools.has(GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL) && !tools.has(GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL)) {
        throw new Error('PlanValidator blocked outline.chapter route without generate_chapter_outline_preview or generate_chapter_outline_batch_preview');
      }
      this.assertOutlineChapterSplitCompleteness(plan, route);
    }
    if (route.domain === 'guided') {
      this.rejectTools(tools, ['write_chapter', 'write_chapter_series', 'rewrite_chapter', 'polish_chapter', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory'], 'guided route');
    }
    if (route.domain === 'timeline' && !route.needsPersistence) {
      this.rejectTools(tools, ['persist_timeline_events'], 'timeline preview route');
    }
  }

  private assertImportScope(plan: AgentPlanSpec, route?: RouteDecision, context?: AgentContextV2): void {
    if (route?.domain !== 'import') return;
    const requestedAssetTypes = this.importAssetTypes(context?.session.requestedAssetTypes);
    if (!requestedAssetTypes.length) return;
    const requested = new Set(requestedAssetTypes);
    const targetToolAssets = plan.steps
      .map((step) => IMPORT_TARGET_ASSET_BY_TOOL.get(step.tool))
      .filter((assetType): assetType is ImportAssetType => Boolean(assetType));
    const extraTargetTools = targetToolAssets.filter((assetType) => !requested.has(assetType));
    if (extraTargetTools.length) {
      throw new Error(`PlanValidator blocked import target expansion: ${[...new Set(extraTargetTools)].join(', ')}`);
    }
    for (const step of plan.steps) {
      if (step.tool !== 'build_import_preview' && step.tool !== 'merge_import_previews') continue;
      const explicit = this.importAssetTypes(step.args.requestedAssetTypes);
      if (!explicit.length) {
        throw new Error(`PlanValidator blocked import step without requestedAssetTypes: ${step.tool}`);
      }
      const extra = explicit.filter((assetType) => !requested.has(assetType));
      const missing = requestedAssetTypes.filter((assetType) => !explicit.includes(assetType));
      if (extra.length || missing.length) {
        throw new Error(`PlanValidator blocked import requestedAssetTypes mismatch for ${step.tool}: expected ${requestedAssetTypes.join(', ')}, got ${explicit.join(', ')}`);
      }
    }
  }

  private rejectTools(actualTools: Set<string>, deniedTools: string[], label: string): void {
    const found = deniedTools.filter((tool) => actualTools.has(tool));
    if (found.length) throw new Error(`PlanValidator blocked ${label} tools: ${found.join(', ')}`);
  }

  private assertOutlineChapterSplitCompleteness(plan: AgentPlanSpec, route: RouteDecision): void {
    const chapterSteps = plan.steps.filter((step) => step.tool === GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL);
    const batchSteps = plan.steps.filter((step) => step.tool === GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL);
    const chapterCount = this.positiveInt(route.chapterCount) ?? this.inferOutlineChapterCount(plan);
    const targetChapterNo = this.positiveInt(route.chapterNo);
    if (targetChapterNo && chapterSteps.length === 1) {
      const stepChapterNo = this.positiveInt(chapterSteps[0].args.chapterNo);
      if (stepChapterNo !== targetChapterNo) {
        throw new Error(`PlanValidator blocked outline.chapter plan for chapter ${targetChapterNo} with mismatched generate_chapter_outline_preview.args.chapterNo.`);
      }
      if (chapterCount && this.positiveInt(chapterSteps[0].args.chapterCount) !== chapterCount) {
        throw new Error(`PlanValidator blocked outline.chapter plan with generate_chapter_outline_preview.args.chapterCount not equal to ${chapterCount}.`);
      }
      return;
    }
    if (!chapterCount) return;
    if (plan.steps.some((step) => step.tool === 'generate_outline_preview')) {
      throw new Error(`PlanValidator blocked outline.chapter route using aggregate generate_outline_preview for ${chapterCount} chapters; use explicit chapter steps or chapter-outline batches.`);
    }
    if (chapterSteps.length && batchSteps.length) {
      throw new Error('PlanValidator blocked outline.chapter plan mixing single-chapter and batch chapter outline preview steps.');
    }
    if (batchSteps.length) {
      this.assertBatchOutlineChapterSplitCompleteness(plan, route, chapterCount, batchSteps);
      return;
    }
    this.assertSingleOutlineChapterSplitCompleteness(plan, route, chapterCount, chapterSteps);
  }

  private assertSingleOutlineChapterSplitCompleteness(plan: AgentPlanSpec, _route: RouteDecision, chapterCount: number, chapterSteps: AgentPlanSpec['steps']): void {
    if (chapterSteps.length !== chapterCount) {
      throw new Error(`PlanValidator blocked incomplete outline.chapter plan: expected ${chapterCount} generate_chapter_outline_preview steps, got ${chapterSteps.length}. Return one visible chapter outline step per target chapter; do not rely on backend expansion.`);
    }

    const chapterNos = chapterSteps.map((step) => this.positiveInt(step.args.chapterNo));
    if (chapterNos.some((chapterNo) => !chapterNo)) {
      throw new Error('PlanValidator blocked outline.chapter plan with missing generate_chapter_outline_preview.args.chapterNo.');
    }
    const concreteChapterNos = chapterNos.filter((chapterNo): chapterNo is number => chapterNo !== undefined);
    const duplicateChapterNos = this.duplicates(concreteChapterNos);
    const missingChapterNos = Array.from({ length: chapterCount }, (_, index) => index + 1).filter((chapterNo) => !chapterNos.includes(chapterNo));
    const outOfRangeChapterNos = concreteChapterNos.filter((chapterNo) => chapterNo > chapterCount);
    if (duplicateChapterNos.length || missingChapterNos.length || outOfRangeChapterNos.length) {
      throw new Error(`PlanValidator blocked outline.chapter plan with non-continuous chapterNo sequence: missing [${missingChapterNos.join(', ')}], duplicate [${duplicateChapterNos.join(', ')}], outOfRange [${outOfRangeChapterNos.join(', ')}].`);
    }

    const mismatchedChapterCountSteps = chapterSteps.filter((step) => this.positiveInt(step.args.chapterCount) !== chapterCount);
    if (mismatchedChapterCountSteps.length) {
      throw new Error(`PlanValidator blocked outline.chapter plan with generate_chapter_outline_preview.args.chapterCount not equal to ${chapterCount}.`);
    }

    const volumeNos = [...new Set(chapterSteps.map((step) => this.positiveInt(step.args.volumeNo)).filter((volumeNo): volumeNo is number => Boolean(volumeNo)))];
    if (volumeNos.length > 1) {
      throw new Error(`PlanValidator blocked outline.chapter plan with mixed volumeNo values: ${volumeNos.join(', ')}.`);
    }

    const chapterStepNos = new Set(chapterSteps.map((step) => step.stepNo));
    const mergeSteps = plan.steps.filter((step) => step.tool === MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL);
    if (!mergeSteps.length) {
      throw new Error(`PlanValidator blocked outline.chapter plan without merge_chapter_outline_previews for ${chapterCount} chapter previews.`);
    }
    const mergeStep = mergeSteps[0];
    if (mergeStep.stepNo <= Math.max(...chapterSteps.map((step) => step.stepNo))) {
      throw new Error('PlanValidator blocked outline.chapter plan where merge_chapter_outline_previews runs before all chapter outline steps.');
    }
    if (this.positiveInt(mergeStep.args.chapterCount) !== chapterCount) {
      throw new Error(`PlanValidator blocked outline.chapter plan with merge_chapter_outline_previews.args.chapterCount not equal to ${chapterCount}.`);
    }
    const previews = Array.isArray(mergeStep.args.previews) ? mergeStep.args.previews : [];
    if (previews.length !== chapterCount) {
      throw new Error(`PlanValidator blocked incomplete outline.chapter merge: expected ${chapterCount} previews, got ${previews.length}. Include every generate_chapter_outline_preview output in order.`);
    }
    const numericPreviewRefs = previews
      .map((preview) => (typeof preview === 'string' ? preview.match(/\{\{steps\.(\d+)\.output\}\}/)?.[1] : undefined))
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));
    if (numericPreviewRefs.length && numericPreviewRefs.some((stepNo) => !chapterStepNos.has(stepNo))) {
      throw new Error('PlanValidator blocked outline.chapter merge with previews that do not reference chapter outline step outputs.');
    }
  }

  private assertBatchOutlineChapterSplitCompleteness(plan: AgentPlanSpec, route: RouteDecision, chapterCount: number, batchSteps: AgentPlanSpec['steps']): void {
    const segmentSteps = plan.steps.filter((step) => step.tool === SEGMENT_CHAPTER_OUTLINE_BATCHES_TOOL);
    if (!segmentSteps.length) {
      throw new Error('PlanValidator blocked outline.chapter batch plan without segment_chapter_outline_batches.');
    }
    const segmentStep = segmentSteps[0];
    this.assertStepChapterCount(segmentStep, chapterCount, SEGMENT_CHAPTER_OUTLINE_BATCHES_TOOL);
    if (this.positiveInt(route.volumeNo)) this.assertStepVolumeNo(segmentStep, route.volumeNo, SEGMENT_CHAPTER_OUTLINE_BATCHES_TOOL);
    if (segmentStep.stepNo >= Math.min(...batchSteps.map((step) => step.stepNo))) {
      throw new Error('PlanValidator blocked outline.chapter batch plan where segment_chapter_outline_batches does not run before batch preview steps.');
    }

    const ranges = batchSteps.map((step) => {
      this.assertStepChapterCount(step, chapterCount, GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL);
      if (this.positiveInt(route.volumeNo)) this.assertStepVolumeNo(step, route.volumeNo, GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL);
      const range = this.chapterRange(step.args.chapterRange);
      if (!range) {
        throw new Error('PlanValidator blocked outline.chapter batch plan with missing generate_chapter_outline_batch_preview.args.chapterRange.');
      }
      if (range.end - range.start + 1 > 5) {
        throw new Error(`PlanValidator blocked outline.chapter batch range ${range.start}-${range.end} larger than 5 chapters.`);
      }
      return range;
    });
    this.assertRangeCoverage(ranges, chapterCount, 'outline.chapter batch plan');

    const batchStepNos = new Set(batchSteps.map((step) => step.stepNo));
    const mergeSteps = plan.steps.filter((step) => step.tool === MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL);
    if (!mergeSteps.length) {
      throw new Error(`PlanValidator blocked outline.chapter batch plan without merge_chapter_outline_batch_previews for ${chapterCount} chapters.`);
    }
    const mergeStep = mergeSteps[0];
    if (mergeStep.stepNo <= Math.max(...batchSteps.map((step) => step.stepNo))) {
      throw new Error('PlanValidator blocked outline.chapter batch plan where merge_chapter_outline_batch_previews runs before all batch preview steps.');
    }
    this.assertStepChapterCount(mergeStep, chapterCount, MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL);
    if (this.positiveInt(route.volumeNo)) this.assertStepVolumeNo(mergeStep, route.volumeNo, MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL);
    const batchPreviews = Array.isArray(mergeStep.args.batchPreviews) ? mergeStep.args.batchPreviews : [];
    if (batchPreviews.length !== batchSteps.length) {
      throw new Error(`PlanValidator blocked incomplete outline.chapter batch merge: expected ${batchSteps.length} batchPreviews, got ${batchPreviews.length}. Include every generate_chapter_outline_batch_preview output in order.`);
    }
    const numericPreviewRefs = batchPreviews
      .map((preview) => (typeof preview === 'string' ? preview.match(/\{\{steps\.(\d+)\.output\}\}/)?.[1] : undefined))
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));
    if (numericPreviewRefs.length && numericPreviewRefs.some((stepNo) => !batchStepNos.has(stepNo))) {
      throw new Error('PlanValidator blocked outline.chapter batch merge with batchPreviews that do not reference batch preview step outputs.');
    }
  }

  private inferOutlineChapterCount(plan: AgentPlanSpec): number | undefined {
    const candidates = plan.steps
      .filter((step) => [
        'generate_volume_outline_preview',
        'generate_story_units_preview',
        GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL,
        MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL,
        SEGMENT_CHAPTER_OUTLINE_BATCHES_TOOL,
        GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL,
        MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL,
        'generate_outline_preview',
      ].includes(step.tool))
      .map((step) => this.positiveInt(step.args.chapterCount))
      .filter((chapterCount): chapterCount is number => Boolean(chapterCount));
    const unique = [...new Set(candidates)];
    if (unique.length > 1) {
      throw new Error(`PlanValidator blocked outline.chapter plan with mismatched chapterCount values: ${unique.join(', ')}.`);
    }
    return unique[0];
  }

  private assertStepChapterCount(step: AgentPlanSpec['steps'][number], chapterCount: number, tool: string): void {
    if (this.positiveInt(step.args.chapterCount) !== chapterCount) {
      throw new Error(`PlanValidator blocked outline.chapter plan with ${tool}.args.chapterCount not equal to ${chapterCount}.`);
    }
  }

  private assertStepVolumeNo(step: AgentPlanSpec['steps'][number], volumeNo: number | undefined, tool: string): void {
    if (!volumeNo) return;
    const stepVolumeNo = this.positiveInt(step.args.volumeNo);
    if (stepVolumeNo && stepVolumeNo !== volumeNo) {
      throw new Error(`PlanValidator blocked outline.chapter plan with ${tool}.args.volumeNo not equal to ${volumeNo}.`);
    }
  }

  private chapterRange(value: unknown): ChapterRange | undefined {
    const record = this.asRecord(value);
    const start = this.positiveInt(record.start);
    const end = this.positiveInt(record.end);
    if (!start || !end || end < start) return undefined;
    return { start, end };
  }

  private assertRangeCoverage(ranges: ChapterRange[], chapterCount: number, label: string): void {
    const ordered = [...ranges].sort((left, right) => left.start - right.start);
    let expected = 1;
    const duplicatesOrOverlaps: string[] = [];
    const missing: string[] = [];
    const outOfRange: string[] = [];
    for (const range of ordered) {
      if (range.start < expected) duplicatesOrOverlaps.push(`${range.start}-${range.end}`);
      if (range.start > expected) missing.push(`${expected}-${range.start - 1}`);
      if (range.end > chapterCount) outOfRange.push(`${range.start}-${range.end}`);
      expected = Math.max(expected, range.end + 1);
    }
    if (expected <= chapterCount) missing.push(`${expected}-${chapterCount}`);
    if (duplicatesOrOverlaps.length || missing.length || outOfRange.length) {
      throw new Error(`PlanValidator blocked ${label} with invalid chapter coverage: missing [${missing.join(', ')}], overlaps [${duplicatesOrOverlaps.join(', ')}], outOfRange [${outOfRange.join(', ')}].`);
    }
  }

  private positiveInt(value: unknown): number | undefined {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
  }

  private duplicates(values: number[]): number[] {
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    for (const value of values) {
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    }
    return [...duplicated];
  }

  private importAssetTypes(value: unknown): ImportAssetType[] {
    if (!Array.isArray(value)) return [];
    const normalized = value.filter((item): item is ImportAssetType => typeof item === 'string' && IMPORT_ASSET_TYPES.includes(item as ImportAssetType));
    return [...new Set(normalized)];
  }

  private rawPlan(data: unknown): AgentPlanSpec | undefined {
    const record = this.asRecord(data);
    if (!Array.isArray(record.steps)) return undefined;
    const steps = record.steps.map((item, index) => {
      const step = this.asRecord(item);
      return {
        stepNo: index + 1,
        name: typeof step.name === 'string' ? step.name : `raw step ${index + 1}`,
        tool: typeof step.tool === 'string' ? step.tool : '',
        mode: 'act' as const,
        requiresApproval: Boolean(step.requiresApproval),
        args: this.asRecord(step.args),
      };
    });
    if (!steps.length) return undefined;
    return {
      taskType: typeof record.taskType === 'string' ? record.taskType : 'raw',
      summary: typeof record.summary === 'string' ? record.summary : 'raw plan',
      assumptions: [],
      risks: [],
      requiredApprovals: [],
      steps,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
