import { ScoringTargetType, ScoringTargetSnapshot, validateScoringTargetSnapshot } from './scoring-contracts';

export interface ScoringTargetSelector {
  targetType: ScoringTargetType;
  targetId?: string;
  targetRef?: Record<string, unknown>;
  draftId?: string;
  draftVersion?: number;
}

export interface ScoringAssetOption {
  targetType: ScoringTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown> | null;
  title: string;
  volumeNo?: number | null;
  chapterNo?: number | null;
  draftId?: string | null;
  draftVersion?: number | null;
  source: string;
  updatedAt?: string | null;
  hasScoringReports?: boolean;
}

export function assertScoringTargetSelector(value: unknown): ScoringTargetSelector {
  const record = requireRecord(value, 'target');
  const targetType = record.targetType;
  if (targetType !== 'project_outline'
    && targetType !== 'volume_outline'
    && targetType !== 'chapter_outline'
    && targetType !== 'chapter_craft_brief'
    && targetType !== 'chapter_draft') {
    throw new Error('target.targetType is not supported by scoring center.');
  }

  const selector: ScoringTargetSelector = {
    targetType,
    targetId: optionalString(record.targetId, 'target.targetId'),
    targetRef: record.targetRef === undefined || record.targetRef === null ? undefined : requireRecord(record.targetRef, 'target.targetRef'),
    draftId: optionalString(record.draftId, 'target.draftId'),
    draftVersion: optionalInteger(record.draftVersion, 'target.draftVersion'),
  };

  if (!selector.targetId && !selector.targetRef) {
    throw new Error('target must include targetId or targetRef.');
  }
  if (selector.targetType === 'chapter_draft' && (!selector.draftId || !selector.draftVersion)) {
    throw new Error('chapter_draft scoring requires explicit draftId and draftVersion.');
  }
  return selector;
}

export function assertScoringTargetSnapshot(value: unknown, targetType: ScoringTargetType): ScoringTargetSnapshot {
  return validateScoringTargetSnapshot(value, targetType);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer when provided.`);
  }
  return value;
}
