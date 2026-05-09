import { assertVolumeCharacterPlan, type CharacterReferenceCatalog } from './outline-character-contracts';

export interface AssertVolumeNarrativePlanOptions extends CharacterReferenceCatalog {
  chapterCount: number;
  label?: string;
}

export function assertVolumeNarrativePlan(value: unknown, options: AssertVolumeNarrativePlanOptions): Record<string, unknown> {
  const label = options.label ?? 'narrativePlan';
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    throw new Error(`${label} 缺失，未生成完整卷纲。`);
  }

  for (const field of ['globalMainlineStage', 'volumeMainline', 'dramaticQuestion', 'startState', 'endState', 'endingHook', 'handoffToNextVolume']) {
    requiredText(record[field], `${label}.${field}`);
  }
  if (!stringArray(record.mainlineMilestones).length) {
    throw new Error(`${label}.mainlineMilestones 缺失，未生成完整卷纲。`);
  }
  const foreshadowPlan = requiredForeshadowPlan(record.foreshadowPlan, `${label}.foreshadowPlan`, options.chapterCount);

  const subStoryLines = requiredRecordArray(record.subStoryLines, `${label}.subStoryLines`);
  if (subStoryLines.length < 2) {
    throw new Error(`${label}.subStoryLines 少于 2 条，未生成完整卷纲。`);
  }
  for (const [index, subStoryLine] of subStoryLines.entries()) {
    const itemLabel = `${label}.subStoryLines[${index}]`;
    for (const field of ['name', 'type', 'function', 'startState', 'progress', 'endState']) {
      requiredText(subStoryLine[field], `${itemLabel}.${field}`);
    }
    if (!stringArray(subStoryLine.relatedCharacters).length) {
      throw new Error(`${itemLabel}.relatedCharacters 缺失，未生成完整卷纲。`);
    }
    if (!positiveIntArray(subStoryLine.chapterNodes).length) {
      throw new Error(`${itemLabel}.chapterNodes 缺失，未生成完整卷纲。`);
    }
  }

  const storyUnits = requiredRecordArray(record.storyUnits, `${label}.storyUnits`);
  const normalizedRanges: Array<{ start: number; end: number; label: string }> = [];
  for (const [index, storyUnit] of storyUnits.entries()) {
    const itemLabel = `${label}.storyUnits[${index}]`;
    for (const field of ['unitId', 'title', 'localGoal', 'localConflict', 'payoff', 'stateChangeAfterUnit']) {
      requiredText(storyUnit[field], `${itemLabel}.${field}`);
    }
    const range = asRecord(storyUnit.chapterRange);
    const start = requiredPositiveInt(range.start, `${itemLabel}.chapterRange.start`);
    const end = requiredPositiveInt(range.end, `${itemLabel}.chapterRange.end`);
    if (end < start || start > options.chapterCount) {
      throw new Error(`${itemLabel}.chapterRange 无效，未生成完整卷纲。`);
    }
    const length = end - start + 1;
    if (options.chapterCount >= 3 && (length < 3 || length > 5)) {
      throw new Error(`${itemLabel}.chapterRange 必须覆盖 3-5 章，未生成完整卷纲。`);
    }
    if (stringArray(storyUnit.serviceFunctions).length < 3) {
      throw new Error(`${itemLabel}.serviceFunctions 少于 3 项，未生成完整卷纲。`);
    }
    normalizedRanges.push({ start, end, label: itemLabel });
  }

  const sortedRanges = normalizedRanges.sort((left, right) => left.start - right.start);
  let expectedStart = 1;
  for (const range of sortedRanges) {
    if (range.start !== expectedStart) {
      throw new Error(`${range.label}.chapterRange 未连续覆盖全卷章节，未生成完整卷纲。`);
    }
    expectedStart = range.end + 1;
  }
  if (expectedStart !== options.chapterCount + 1) {
    throw new Error(`${label}.storyUnits 未覆盖到第 ${options.chapterCount} 章，未生成完整卷纲。`);
  }

  return {
    ...record,
    foreshadowPlan,
    characterPlan: assertVolumeCharacterPlan(record.characterPlan, {
      chapterCount: options.chapterCount,
      existingCharacterNames: options.existingCharacterNames,
      existingCharacterAliases: options.existingCharacterAliases,
      volumeCandidateNames: options.volumeCandidateNames,
      label: `${label}.characterPlan`,
    }),
  };
}

type ForeshadowPlanItem = string | Record<string, unknown>;

const FORESHADOW_SETUP_RANGE_KEYS = ['appearRange', 'setupRange'] as const;
const FORESHADOW_RECOVER_RANGE_KEYS = ['recoverRange', 'recoveryRange', 'payoffRange'] as const;
const FORESHADOW_RECOVERY_METHOD_KEYS = ['recoveryMethod', 'payoffMethod'] as const;

function requiredForeshadowPlan(value: unknown, label: string, chapterCount: number): ForeshadowPlanItem[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${label} 缺失，未生成完整卷纲。`);
  }
  return value.map((item, index) => normalizeForeshadowPlanItem(item, `${label}[${index}]`, chapterCount));
}

function normalizeForeshadowPlanItem(item: unknown, label: string, chapterCount: number): ForeshadowPlanItem {
  const itemText = text(item);
  if (itemText) return itemText;

  const record = asRecord(item);
  if (!Object.keys(record).length) {
    throw new Error(`${label} 缺失，未生成完整卷纲。`);
  }

  requiredText(record.name, `${label}.name`);
  const setupRangeKey = firstPresentKey(record, FORESHADOW_SETUP_RANGE_KEYS);
  if (!setupRangeKey) {
    throw new Error(`${label}.appearRange 缺失，未生成完整卷纲。`);
  }
  const recoverRangeKey = firstPresentKey(record, FORESHADOW_RECOVER_RANGE_KEYS);
  if (!recoverRangeKey) {
    throw new Error(`${label}.recoverRange 缺失，未生成完整卷纲。`);
  }
  const recoveryMethodKey = firstPresentKey(record, FORESHADOW_RECOVERY_METHOD_KEYS);
  if (!recoveryMethodKey) {
    throw new Error(`${label}.recoveryMethod 缺失，未生成完整卷纲。`);
  }

  const setupRange = requiredForeshadowRange(record[setupRangeKey], `${label}.${setupRangeKey}`, chapterCount);
  const recoverRange = requiredForeshadowRange(record[recoverRangeKey], `${label}.${recoverRangeKey}`, chapterCount);
  const recoveryMethod = requiredText(record[recoveryMethodKey], `${label}.${recoveryMethodKey}`);

  return {
    ...record,
    [setupRangeKey]: setupRange,
    [recoverRangeKey]: recoverRange,
    [recoveryMethodKey]: recoveryMethod,
  };
}

function requiredForeshadowRange(value: unknown, label: string, chapterCount: number): unknown {
  const range = asRecord(value);
  if (Object.keys(range).length) {
    const start = requiredPositiveInt(range.start, `${label}.start`);
    const end = requiredPositiveInt(range.end, `${label}.end`);
    assertForeshadowRangeBounds(start, end, chapterCount, label);
    return { ...range, start, end };
  }

  const rangeText = text(value);
  if (!rangeText) {
    throw new Error(`${label} 缺失，未生成完整卷纲。`);
  }
  const numbers = rangeText.match(/\d+/g)?.map((item) => Number(item)) ?? [];
  if (!numbers.length) {
    throw new Error(`${label} 缺失章节区间，未生成完整卷纲。`);
  }
  const start = numbers[0];
  const end = numbers.length > 1 ? numbers[1] : numbers[0];
  assertForeshadowRangeBounds(start, end, chapterCount, label);
  return rangeText;
}

function assertForeshadowRangeBounds(start: number, end: number, chapterCount: number, label: string) {
  if (end < start || start > chapterCount || end > chapterCount) {
    throw new Error(`${label} 无效，未生成完整卷纲。`);
  }
}

function firstPresentKey(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return keys.find((key) => record[key] !== undefined && record[key] !== null);
}

function requiredText(value: unknown, label: string): string {
  const textValue = text(value);
  if (!textValue) throw new Error(`${label} 缺失，未生成完整卷纲。`);
  return textValue;
}

function requiredPositiveInt(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${label} 缺失或不是正整数，未生成完整卷纲。`);
  }
  return numeric;
}

function requiredRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  const records = Array.isArray(value)
    ? value.map((item) => asRecord(item)).filter((item) => Object.keys(item).length > 0)
    : [];
  if (!records.length) throw new Error(`${label} 缺失，未生成完整卷纲。`);
  return records;
}

function positiveIntArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
