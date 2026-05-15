export const SCORING_TARGET_TYPES = [
  'project_outline',
  'volume_outline',
  'chapter_outline',
  'chapter_craft_brief',
  'chapter_draft',
] as const;

export type ScoringTargetType = typeof SCORING_TARGET_TYPES[number];

export const PLATFORM_PROFILE_KEYS = [
  'generic_longform',
  'qidian_like',
  'fanqie_like',
  'jinjiang_like',
  'published_literary',
] as const;

export type PlatformProfileKey = typeof PLATFORM_PROFILE_KEYS[number];

export const SCORING_VERDICTS = ['pass', 'warn', 'fail'] as const;
export type ScoringVerdict = typeof SCORING_VERDICTS[number];

export const SCORING_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type ScoringConfidence = typeof SCORING_CONFIDENCE_LEVELS[number];

export const SCORING_ISSUE_SEVERITIES = ['info', 'warning', 'blocking'] as const;
export type ScoringIssueSeverity = typeof SCORING_ISSUE_SEVERITIES[number];

export const SCORING_PROMPT_VERSION = 'multidimensional_scoring.prompt.v1';
export const SCORING_RUBRIC_VERSION = 'multidimensional_scoring.rubric.v1';

export interface ScoringDimensionScore {
  key: string;
  label: string;
  score: number;
  weight: number;
  weightedScore: number;
  confidence: ScoringConfidence;
  evidence: string;
  reason: string;
  suggestion: string;
}

export interface ScoringIssue {
  dimensionKey: string;
  severity: ScoringIssueSeverity;
  path: string;
  evidence: string;
  reason: string;
  suggestion: string;
}

export interface ScoringReportPayload {
  targetType: ScoringTargetType;
  platformProfile: PlatformProfileKey;
  overallScore: number;
  verdict: ScoringVerdict;
  summary: string;
  extractedElements: Record<string, unknown>;
  dimensions: ScoringDimensionScore[];
  blockingIssues: ScoringIssue[];
  revisionPriorities: string[];
}

export interface ScoringAssetSummary {
  title: string;
  targetType: ScoringTargetType;
  volumeNo?: number | null;
  chapterNo?: number | null;
  draftId?: string | null;
  draftVersion?: number | null;
  source: string;
  updatedAt?: string | null;
}

export interface ScoringTargetSnapshot {
  targetType: ScoringTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown> | null;
  assetSummary: ScoringAssetSummary;
  content: Record<string, unknown>;
  sourceTrace: Record<string, unknown>;
}

export interface ScoringRunContractPayload {
  targetType: ScoringTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown> | null;
  profileKey: PlatformProfileKey;
  targetSnapshot: ScoringTargetSnapshot;
  sourceTrace: Record<string, unknown>;
  report: ScoringReportPayload;
  promptVersion: string;
  rubricVersion: string;
  profileVersion: string;
}

export interface ValidateScoringReportOptions {
  targetType: ScoringTargetType;
  platformProfile: PlatformProfileKey;
  expectedDimensionWeights: Record<string, number>;
}

export class ScoringContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringContractError';
  }
}

export function isScoringTargetType(value: unknown): value is ScoringTargetType {
  return typeof value === 'string' && (SCORING_TARGET_TYPES as readonly string[]).includes(value);
}

export function isPlatformProfileKey(value: unknown): value is PlatformProfileKey {
  return typeof value === 'string' && (PLATFORM_PROFILE_KEYS as readonly string[]).includes(value);
}

export function validateScoringReportPayload(value: unknown, options: ValidateScoringReportOptions): ScoringReportPayload {
  const record = requireRecord(value, 'report');
  const targetType = requireEnum(record.targetType, SCORING_TARGET_TYPES, 'report.targetType');
  const platformProfile = requireEnum(record.platformProfile, PLATFORM_PROFILE_KEYS, 'report.platformProfile');
  if (targetType !== options.targetType) {
    throw new ScoringContractError(`report.targetType must match requested targetType ${options.targetType}.`);
  }
  if (platformProfile !== options.platformProfile) {
    throw new ScoringContractError(`report.platformProfile must match requested profile ${options.platformProfile}.`);
  }

  const expectedKeys = Object.keys(options.expectedDimensionWeights);
  if (!expectedKeys.length) {
    throw new ScoringContractError('expectedDimensionWeights must not be empty.');
  }

  const dimensions = requireArray(record.dimensions, 'report.dimensions').map((item, index) =>
    normalizeDimensionScore(item, index, options.expectedDimensionWeights),
  );
  assertExactDimensionCoverage(dimensions, expectedKeys);

  const blockingIssues = requireArray(record.blockingIssues, 'report.blockingIssues').map((item, index) =>
    normalizeIssue(item, index, expectedKeys),
  );
  const revisionPriorities = requireArray(record.revisionPriorities, 'report.revisionPriorities').map((item, index) =>
    requireNonEmptyString(item, `report.revisionPriorities[${index}]`),
  );

  return {
    targetType,
    platformProfile,
    overallScore: requireScore(record.overallScore, 'report.overallScore'),
    verdict: requireEnum(record.verdict, SCORING_VERDICTS, 'report.verdict'),
    summary: requireNonEmptyString(record.summary, 'report.summary'),
    extractedElements: requireRecord(record.extractedElements, 'report.extractedElements'),
    dimensions,
    blockingIssues,
    revisionPriorities,
  };
}

export function validateScoringTargetSnapshot(value: unknown, expectedTargetType?: ScoringTargetType): ScoringTargetSnapshot {
  const record = requireRecord(value, 'targetSnapshot');
  const targetType = requireEnum(record.targetType, SCORING_TARGET_TYPES, 'targetSnapshot.targetType');
  if (expectedTargetType && targetType !== expectedTargetType) {
    throw new ScoringContractError(`targetSnapshot.targetType must match ${expectedTargetType}.`);
  }

  const targetId = optionalString(record.targetId, 'targetSnapshot.targetId');
  const targetRef = record.targetRef === undefined || record.targetRef === null
    ? null
    : requireRecord(record.targetRef, 'targetSnapshot.targetRef');
  if (!targetId && !targetRef) {
    throw new ScoringContractError('targetSnapshot must include targetId or targetRef.');
  }

  const assetSummary = normalizeAssetSummary(record.assetSummary, targetType);
  const content = requireRecord(record.content, 'targetSnapshot.content');
  if (!Object.keys(content).length) {
    throw new ScoringContractError('targetSnapshot.content must not be empty.');
  }
  const sourceTrace = requireRecord(record.sourceTrace, 'targetSnapshot.sourceTrace');
  if (!Object.keys(sourceTrace).length) {
    throw new ScoringContractError('targetSnapshot.sourceTrace must not be empty.');
  }

  return {
    targetType,
    targetId,
    targetRef,
    assetSummary,
    content,
    sourceTrace,
  };
}

export function validateScoringRunContractPayload(value: unknown, options: ValidateScoringReportOptions): ScoringRunContractPayload {
  const record = requireRecord(value, 'scoringRun');
  const targetType = requireEnum(record.targetType, SCORING_TARGET_TYPES, 'scoringRun.targetType');
  const profileKey = requireEnum(record.profileKey, PLATFORM_PROFILE_KEYS, 'scoringRun.profileKey');
  if (targetType !== options.targetType) {
    throw new ScoringContractError(`scoringRun.targetType must match ${options.targetType}.`);
  }
  if (profileKey !== options.platformProfile) {
    throw new ScoringContractError(`scoringRun.profileKey must match ${options.platformProfile}.`);
  }

  return {
    targetType,
    targetId: optionalString(record.targetId, 'scoringRun.targetId'),
    targetRef: record.targetRef === undefined || record.targetRef === null ? null : requireRecord(record.targetRef, 'scoringRun.targetRef'),
    profileKey,
    targetSnapshot: validateScoringTargetSnapshot(record.targetSnapshot, targetType),
    sourceTrace: requireRecord(record.sourceTrace, 'scoringRun.sourceTrace'),
    report: validateScoringReportPayload(record.report, options),
    promptVersion: requireExactVersion(record.promptVersion, SCORING_PROMPT_VERSION, 'scoringRun.promptVersion'),
    rubricVersion: requireExactVersion(record.rubricVersion, SCORING_RUBRIC_VERSION, 'scoringRun.rubricVersion'),
    profileVersion: requireNonEmptyString(record.profileVersion, 'scoringRun.profileVersion'),
  };
}

function normalizeAssetSummary(value: unknown, targetType: ScoringTargetType): ScoringAssetSummary {
  const record = requireRecord(value, 'targetSnapshot.assetSummary');
  const summaryTargetType = requireEnum(record.targetType, SCORING_TARGET_TYPES, 'targetSnapshot.assetSummary.targetType');
  if (summaryTargetType !== targetType) {
    throw new ScoringContractError('targetSnapshot.assetSummary.targetType must match targetSnapshot.targetType.');
  }
  return {
    title: requireNonEmptyString(record.title, 'targetSnapshot.assetSummary.title'),
    targetType: summaryTargetType,
    volumeNo: optionalNumber(record.volumeNo, 'targetSnapshot.assetSummary.volumeNo'),
    chapterNo: optionalNumber(record.chapterNo, 'targetSnapshot.assetSummary.chapterNo'),
    draftId: optionalString(record.draftId, 'targetSnapshot.assetSummary.draftId'),
    draftVersion: optionalNumber(record.draftVersion, 'targetSnapshot.assetSummary.draftVersion'),
    source: requireNonEmptyString(record.source, 'targetSnapshot.assetSummary.source'),
    updatedAt: optionalString(record.updatedAt, 'targetSnapshot.assetSummary.updatedAt'),
  };
}

function normalizeDimensionScore(value: unknown, index: number, expectedWeights: Record<string, number>): ScoringDimensionScore {
  const record = requireRecord(value, `report.dimensions[${index}]`);
  const key = requireNonEmptyString(record.key, `report.dimensions[${index}].key`);
  if (!Object.prototype.hasOwnProperty.call(expectedWeights, key)) {
    throw new ScoringContractError(`report.dimensions[${index}].key is not expected for this target/profile: ${key}.`);
  }
  const weight = requireWeight(record.weight, `report.dimensions[${index}].weight`);
  const expectedWeight = expectedWeights[key];
  if (Math.abs(weight - expectedWeight) > 0.001) {
    throw new ScoringContractError(`report.dimensions[${index}].weight must be ${expectedWeight} for ${key}.`);
  }
  const score = requireScore(record.score, `report.dimensions[${index}].score`);
  const weightedScore = requireNumber(record.weightedScore, `report.dimensions[${index}].weightedScore`);
  const expectedWeightedScore = Number(((score * weight) / 100).toFixed(4));
  if (Math.abs(weightedScore - expectedWeightedScore) > 0.05) {
    throw new ScoringContractError(`report.dimensions[${index}].weightedScore must equal score * weight / 100.`);
  }
  return {
    key,
    label: requireNonEmptyString(record.label, `report.dimensions[${index}].label`),
    score,
    weight,
    weightedScore,
    confidence: requireEnum(record.confidence, SCORING_CONFIDENCE_LEVELS, `report.dimensions[${index}].confidence`),
    evidence: requireNonEmptyString(record.evidence, `report.dimensions[${index}].evidence`),
    reason: requireNonEmptyString(record.reason, `report.dimensions[${index}].reason`),
    suggestion: requireNonEmptyString(record.suggestion, `report.dimensions[${index}].suggestion`),
  };
}

function normalizeIssue(value: unknown, index: number, expectedDimensionKeys: string[]): ScoringIssue {
  const record = requireRecord(value, `report.blockingIssues[${index}]`);
  const dimensionKey = requireNonEmptyString(record.dimensionKey, `report.blockingIssues[${index}].dimensionKey`);
  if (!expectedDimensionKeys.includes(dimensionKey)) {
    throw new ScoringContractError(`report.blockingIssues[${index}].dimensionKey is not in report dimensions.`);
  }
  return {
    dimensionKey,
    severity: requireEnum(record.severity, SCORING_ISSUE_SEVERITIES, `report.blockingIssues[${index}].severity`),
    path: requireNonEmptyString(record.path, `report.blockingIssues[${index}].path`),
    evidence: requireNonEmptyString(record.evidence, `report.blockingIssues[${index}].evidence`),
    reason: requireNonEmptyString(record.reason, `report.blockingIssues[${index}].reason`),
    suggestion: requireNonEmptyString(record.suggestion, `report.blockingIssues[${index}].suggestion`),
  };
}

function assertExactDimensionCoverage(dimensions: ScoringDimensionScore[], expectedKeys: string[]) {
  const seen = new Set<string>();
  for (const dimension of dimensions) {
    if (seen.has(dimension.key)) {
      throw new ScoringContractError(`report.dimensions contains duplicate dimension: ${dimension.key}.`);
    }
    seen.add(dimension.key);
  }
  const missing = expectedKeys.filter((key) => !seen.has(key));
  if (missing.length) {
    throw new ScoringContractError(`report.dimensions missing required dimensions: ${missing.join(', ')}.`);
  }
  const extra = [...seen].filter((key) => !expectedKeys.includes(key));
  if (extra.length) {
    throw new ScoringContractError(`report.dimensions contains unexpected dimensions: ${extra.join(', ')}.`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScoringContractError(`${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ScoringContractError(`${field} must be an array.`);
  }
  return value;
}

function requireEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ScoringContractError(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T[number];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScoringContractError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireScore(value: unknown, field: string): number {
  const score = requireNumber(value, field);
  if (score < 0 || score > 100) {
    throw new ScoringContractError(`${field} must be between 0 and 100.`);
  }
  return score;
}

function requireWeight(value: unknown, field: string): number {
  const weight = requireNumber(value, field);
  if (weight <= 0 || weight > 100) {
    throw new ScoringContractError(`${field} must be greater than 0 and at most 100.`);
  }
  return weight;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScoringContractError(`${field} must be a finite number.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScoringContractError(`${field} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScoringContractError(`${field} must be a finite number when provided.`);
  }
  return value;
}

function requireExactVersion(value: unknown, expected: string, field: string): string {
  const actual = requireNonEmptyString(value, field);
  if (actual !== expected) {
    throw new ScoringContractError(`${field} must be ${expected}.`);
  }
  return actual;
}
