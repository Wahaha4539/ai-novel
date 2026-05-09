export const STORY_UNIT_PURPOSES = [
  'mainline_progress',
  'survival_disaster',
  'character_intro',
  'character_depth',
  'relationship_emotion',
  'backstory',
  'worldbuilding',
  'faction',
  'mystery_clue',
  'growth_power',
  'payoff',
  'antagonist',
  'daily_buffer',
  'theme',
  'transition_hook',
] as const;

export type StoryUnitPurpose = typeof STORY_UNIT_PURPOSES[number];

export const STORY_UNIT_MAINLINE_RELATIONS = [
  'direct',
  'indirect',
  'parallel',
  'foreshadow',
  'payoff',
  'texture_only',
] as const;

export type StoryUnitMainlineRelation = typeof STORY_UNIT_MAINLINE_RELATIONS[number];

export interface VolumeMainlineSegment {
  segmentId: string;
  sequence: number;
  title: string;
  narrativeFunction: string;
  mainGoal: string;
  mainConflict: string;
  turningPoint: string;
  stateChange: string;
  requiredDeliveries: string[];
}

export interface VolumeStoryUnit {
  unitId: string;
  title: string;
  primaryPurpose: StoryUnitPurpose;
  secondaryPurposes: StoryUnitPurpose[];
  relationToMainline: StoryUnitMainlineRelation;
  mainlineSegmentIds: string[];
  serviceToMainline: string;
  suggestedChapterMin: number;
  suggestedChapterMax: number;
  narrativePurpose: string;
  localGoal: string;
  localConflict: string;
  requiredDeliveries: string[];
  characterFocus: string[];
  relationshipChanges: string[];
  worldbuildingReveals: string[];
  clueProgression: string[];
  emotionalEffect: string[];
  payoff: string;
  stateChangeAfterUnit: string;
}

export interface StoryUnitChapterAllocation {
  unitId: string;
  chapterRange: { start: number; end: number };
  chapterRoles: string[];
}

export interface VolumeStoryUnitPlan {
  planningPrinciple: string;
  purposeMix: Record<string, unknown> | Array<Record<string, unknown>>;
  mainlineSegments: VolumeMainlineSegment[];
  units: VolumeStoryUnit[];
  chapterAllocation?: StoryUnitChapterAllocation[];
}

export interface AssertVolumeStoryUnitPlanOptions {
  volumeNo?: number;
  chapterCount?: number;
  label?: string;
}

const PURPOSE_SET = new Set<string>(STORY_UNIT_PURPOSES);
const MAINLINE_RELATION_SET = new Set<string>(STORY_UNIT_MAINLINE_RELATIONS);

export function assertVolumeStoryUnitPlan(value: unknown, options: AssertVolumeStoryUnitPlanOptions = {}): VolumeStoryUnitPlan {
  const label = options.label ?? 'storyUnitPlan';
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    throw new Error(`${label} 缺失，未生成完整单元故事计划。`);
  }

  const planningPrinciple = requiredText(record.planningPrinciple, `${label}.planningPrinciple`);
  const purposeMix = normalizePurposeMix(record.purposeMix, `${label}.purposeMix`);
  const mainlineSegments = requiredRecordArray(record.mainlineSegments, `${label}.mainlineSegments`).map((segment, index) => normalizeMainlineSegment(segment, `${label}.mainlineSegments[${index}]`));
  assertUniqueSegmentIds(mainlineSegments, label);
  assertContinuousSegmentSequence(mainlineSegments, label);
  const mainlineSegmentIds = new Set(mainlineSegments.map((segment) => segment.segmentId));
  const units = requiredRecordArray(record.units, `${label}.units`).map((unit, index) => normalizeStoryUnit(unit, `${label}.units[${index}]`, mainlineSegmentIds));
  assertUniqueUnitIds(units, label);
  assertMainlineSegmentCoverage(mainlineSegments, units, label);

  const normalized: VolumeStoryUnitPlan = { planningPrinciple, purposeMix, mainlineSegments, units };
  if (record.chapterAllocation !== undefined && record.chapterAllocation !== null) {
    normalized.chapterAllocation = normalizeChapterAllocation(record.chapterAllocation, units, options, `${label}.chapterAllocation`);
  } else if (options.chapterCount !== undefined) {
    throw new Error(`${label}.chapterAllocation 缺失，未生成可用于章节细分的单元故事分配。`);
  }
  return normalized;
}

export function storyUnitForChapter(plan: VolumeStoryUnitPlan, chapterNo: number): (VolumeStoryUnit & StoryUnitChapterAllocation & { mainlineSegments: VolumeMainlineSegment[] }) | undefined {
  const allocation = plan.chapterAllocation?.find((item) => item.chapterRange.start <= chapterNo && chapterNo <= item.chapterRange.end);
  if (!allocation) return undefined;
  const unit = plan.units.find((item) => item.unitId === allocation.unitId);
  const mainlineSegments = unit ? plan.mainlineSegments.filter((segment) => unit.mainlineSegmentIds.includes(segment.segmentId)) : [];
  return unit ? { ...unit, ...allocation, mainlineSegments } : undefined;
}

export function storyUnitServiceFunctions(unit: Pick<VolumeStoryUnit, 'primaryPurpose' | 'secondaryPurposes'>): string[] {
  return [unit.primaryPurpose, ...unit.secondaryPurposes];
}

function normalizeMainlineSegment(record: Record<string, unknown>, label: string): VolumeMainlineSegment {
  return {
    segmentId: requiredText(record.segmentId, `${label}.segmentId`),
    sequence: requiredPositiveInt(record.sequence, `${label}.sequence`),
    title: requiredText(record.title, `${label}.title`),
    narrativeFunction: requiredText(record.narrativeFunction, `${label}.narrativeFunction`),
    mainGoal: requiredText(record.mainGoal, `${label}.mainGoal`),
    mainConflict: requiredText(record.mainConflict, `${label}.mainConflict`),
    turningPoint: requiredText(record.turningPoint, `${label}.turningPoint`),
    stateChange: requiredText(record.stateChange, `${label}.stateChange`),
    requiredDeliveries: requiredTextArray(record.requiredDeliveries, `${label}.requiredDeliveries`, 2),
  };
}

function normalizeStoryUnit(record: Record<string, unknown>, label: string, mainlineSegmentIds: Set<string>): VolumeStoryUnit {
  const primaryPurpose = requiredEnum(record.primaryPurpose, PURPOSE_SET, `${label}.primaryPurpose`) as StoryUnitPurpose;
  const secondaryPurposes = requiredEnumArray(record.secondaryPurposes, PURPOSE_SET, `${label}.secondaryPurposes`) as StoryUnitPurpose[];
  if (secondaryPurposes.length < 2) {
    throw new Error(`${label}.secondaryPurposes 至少需要 2 项，未生成足够丰富的单元故事功能。`);
  }
  const relationToMainline = requiredEnum(record.relationToMainline, MAINLINE_RELATION_SET, `${label}.relationToMainline`) as StoryUnitMainlineRelation;
  const referencedSegmentIds = requiredTextArray(record.mainlineSegmentIds, `${label}.mainlineSegmentIds`, 1);
  for (const segmentId of referencedSegmentIds) {
    if (!mainlineSegmentIds.has(segmentId)) {
      throw new Error(`${label}.mainlineSegmentIds 引用了不存在的主线段 ${segmentId}，未生成可承接卷主线的单元故事。`);
    }
  }
  const suggestedChapterMin = requiredPositiveInt(record.suggestedChapterMin, `${label}.suggestedChapterMin`);
  const suggestedChapterMax = requiredPositiveInt(record.suggestedChapterMax, `${label}.suggestedChapterMax`);
  if (suggestedChapterMax < suggestedChapterMin) {
    throw new Error(`${label}.suggestedChapterMax 小于 suggestedChapterMin，未生成有效单元故事篇幅建议。`);
  }

  const unit: VolumeStoryUnit = {
    unitId: requiredText(record.unitId, `${label}.unitId`),
    title: requiredText(record.title, `${label}.title`),
    primaryPurpose,
    secondaryPurposes,
    relationToMainline,
    mainlineSegmentIds: referencedSegmentIds,
    serviceToMainline: requiredText(record.serviceToMainline, `${label}.serviceToMainline`),
    suggestedChapterMin,
    suggestedChapterMax,
    narrativePurpose: requiredText(record.narrativePurpose, `${label}.narrativePurpose`),
    localGoal: requiredText(record.localGoal, `${label}.localGoal`),
    localConflict: requiredText(record.localConflict, `${label}.localConflict`),
    requiredDeliveries: requiredTextArray(record.requiredDeliveries, `${label}.requiredDeliveries`, 2),
    characterFocus: textArray(record.characterFocus),
    relationshipChanges: textArray(record.relationshipChanges),
    worldbuildingReveals: textArray(record.worldbuildingReveals),
    clueProgression: textArray(record.clueProgression),
    emotionalEffect: requiredTextArray(record.emotionalEffect, `${label}.emotionalEffect`, 1),
    payoff: requiredText(record.payoff, `${label}.payoff`),
    stateChangeAfterUnit: requiredText(record.stateChangeAfterUnit, `${label}.stateChangeAfterUnit`),
  };

  if (![unit.characterFocus, unit.relationshipChanges, unit.worldbuildingReveals, unit.clueProgression].some((items) => items.length > 0)) {
    throw new Error(`${label} 缺少人物、关系、世界观或线索贡献，未生成有效单元故事。`);
  }
  return unit;
}

function assertUniqueSegmentIds(segments: VolumeMainlineSegment[], label: string): void {
  const ids = segments.map((segment) => segment.segmentId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label}.mainlineSegments 存在重复 segmentId，未生成完整主线段落计划。`);
  }
}

function assertContinuousSegmentSequence(segments: VolumeMainlineSegment[], label: string): void {
  const sorted = [...segments].sort((left, right) => left.sequence - right.sequence);
  for (const [index, segment] of sorted.entries()) {
    if (segment.sequence !== index + 1) {
      throw new Error(`${label}.mainlineSegments.sequence 未从 1 连续递增，未生成完整主线段落计划。`);
    }
  }
}

function assertMainlineSegmentCoverage(segments: VolumeMainlineSegment[], units: VolumeStoryUnit[], label: string): void {
  const covered = new Set(units.flatMap((unit) => unit.mainlineSegmentIds));
  const missing = segments.filter((segment) => !covered.has(segment.segmentId));
  if (missing.length) {
    throw new Error(`${label}.mainlineSegments 未被单元故事覆盖：${missing.map((segment) => segment.segmentId).join(', ')}。`);
  }
}

function normalizeChapterAllocation(value: unknown, units: VolumeStoryUnit[], options: AssertVolumeStoryUnitPlanOptions, label: string): StoryUnitChapterAllocation[] {
  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  const allocations = requiredRecordArray(value, label).map((allocation, index) => {
    const itemLabel = `${label}[${index}]`;
    const unitId = requiredText(allocation.unitId, `${itemLabel}.unitId`);
    const unit = unitById.get(unitId);
    if (!unit) throw new Error(`${itemLabel}.unitId 未引用已生成的 units，未生成有效章节分配。`);
    const range = asRecord(allocation.chapterRange);
    const start = requiredPositiveInt(range.start, `${itemLabel}.chapterRange.start`);
    const end = requiredPositiveInt(range.end, `${itemLabel}.chapterRange.end`);
    if (end < start) throw new Error(`${itemLabel}.chapterRange 无效，未生成有效章节分配。`);
    const length = end - start + 1;
    const chapterRoles = requiredTextArray(allocation.chapterRoles, `${itemLabel}.chapterRoles`, length);
    if (chapterRoles.length !== length) {
      throw new Error(`${itemLabel}.chapterRoles 数量必须等于章节范围长度，未生成可执行章节分配。`);
    }
    return { unitId, chapterRange: { start, end }, chapterRoles };
  });

  if (options.chapterCount !== undefined) assertContinuousChapterAllocation(allocations, options.chapterCount, label);
  return allocations;
}

function assertContinuousChapterAllocation(allocations: StoryUnitChapterAllocation[], chapterCount: number, label: string): void {
  if (!Number.isInteger(chapterCount) || chapterCount < 1) {
    throw new Error(`${label} 校验需要有效 chapterCount。`);
  }
  const sorted = [...allocations].sort((left, right) => left.chapterRange.start - right.chapterRange.start);
  let expectedStart = 1;
  for (const [index, allocation] of sorted.entries()) {
    if (allocation.chapterRange.start !== expectedStart) {
      throw new Error(`${label}[${index}].chapterRange 未连续覆盖章节，未生成完整章节分配。`);
    }
    if (allocation.chapterRange.end > chapterCount) {
      throw new Error(`${label}[${index}].chapterRange 超出 chapterCount，未生成完整章节分配。`);
    }
    expectedStart = allocation.chapterRange.end + 1;
  }
  if (expectedStart !== chapterCount + 1) {
    throw new Error(`${label} 未覆盖到第 ${chapterCount} 章，未生成完整章节分配。`);
  }
}

function assertUniqueUnitIds(units: VolumeStoryUnit[], label: string): void {
  const ids = units.map((unit) => unit.unitId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label}.units 存在重复 unitId，未生成完整单元故事计划。`);
  }
}

function normalizePurposeMix(value: unknown, label: string): Record<string, unknown> | Array<Record<string, unknown>> {
  const record = asRecord(value);
  if (Object.keys(record).length) return record;
  const records = Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item) => Object.keys(item).length > 0) : [];
  if (records.length) return records;
  throw new Error(`${label} 缺失，未生成完整单元故事计划。`);
}

function requiredRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  const records = Array.isArray(value)
    ? value.map((item) => asRecord(item)).filter((item) => Object.keys(item).length > 0)
    : [];
  if (!records.length) throw new Error(`${label} 缺失，未生成完整单元故事计划。`);
  return records;
}

function requiredEnum(value: unknown, allowed: Set<string>, label: string): string {
  const textValue = requiredText(value, label);
  if (!allowed.has(textValue)) {
    throw new Error(`${label} 值非法：${textValue}。`);
  }
  return textValue;
}

function requiredEnumArray(value: unknown, allowed: Set<string>, label: string): string[] {
  const items = requiredTextArray(value, label, 1);
  for (const item of items) {
    if (!allowed.has(item)) throw new Error(`${label} 包含非法值：${item}。`);
  }
  return items;
}

function requiredTextArray(value: unknown, label: string, minItems: number): string[] {
  const items = textArray(value);
  if (items.length < minItems) {
    throw new Error(`${label} 至少需要 ${minItems} 项，未生成完整单元故事计划。`);
  }
  return items;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function requiredText(value: unknown, label: string): string {
  const textValue = text(value);
  if (!textValue) throw new Error(`${label} 缺失，未生成完整单元故事计划。`);
  return textValue;
}

function requiredPositiveInt(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${label} 缺失或不是正整数，未生成完整单元故事计划。`);
  }
  return numeric;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
