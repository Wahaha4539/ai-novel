import { BadRequestException } from '@nestjs/common';
import { ScoringTargetType } from './scoring-contracts';

export type ScoringRevisionEntryPoint = 'report' | 'dimension' | 'issue' | 'priority';

export interface CreateScoringRevisionInput {
  scoringRunId: string;
  entryPoint?: ScoringRevisionEntryPoint;
  selectedIssueIndexes?: number[];
  selectedDimensions?: string[];
  selectedRevisionPriorities?: string[];
  userInstruction?: string;
}

export interface ScoringRevisionTargetMapping {
  targetType: ScoringTargetType;
  agentTarget: string;
  recommendedPreviewAction: string;
  expectedOutput: string;
}

export const SCORING_REVISION_TARGETS: Record<ScoringTargetType, ScoringRevisionTargetMapping> = {
  project_outline: {
    targetType: 'project_outline',
    agentTarget: 'project_outline_preview',
    recommendedPreviewAction: 'Generate a project outline preview; do not persist project assets.',
    expectedOutput: 'project outline preview with changeSummary, preservedFacts, and remainingRisks',
  },
  volume_outline: {
    targetType: 'volume_outline',
    agentTarget: 'volume_outline_preview',
    recommendedPreviewAction: 'Generate a volume outline preview; preserve volumeNo and chapterCount and do not persist.',
    expectedOutput: 'volume outline preview with chapterCount check, changeSummary, preservedFacts, and remainingRisks',
  },
  chapter_outline: {
    targetType: 'chapter_outline',
    agentTarget: 'chapter_outline_preview',
    recommendedPreviewAction: 'Generate a chapter outline preview; preserve chapterNo and upstream references and do not persist.',
    expectedOutput: 'chapter outline preview with changeSummary, preservedFacts, and remainingRisks',
  },
  chapter_craft_brief: {
    targetType: 'chapter_craft_brief',
    agentTarget: 'chapter_craft_brief_preview',
    recommendedPreviewAction: 'Generate a new chapter craftBrief preview; validate it before any persist step.',
    expectedOutput: 'chapter craftBrief preview with executable scene chain, changeSummary, preservedFacts, and remainingRisks',
  },
  chapter_draft: {
    targetType: 'chapter_draft',
    agentTarget: 'chapter_draft_revision_preview',
    recommendedPreviewAction: 'Generate a new draft or revision preview; do not overwrite or delete existing drafts.',
    expectedOutput: 'new draft or revision preview with plan_adherence explanation, changeSummary, preservedFacts, and remainingRisks',
  },
};

const ENTRY_POINTS = new Set<ScoringRevisionEntryPoint>(['report', 'dimension', 'issue', 'priority']);

export function assertScoringRevisionInput(value: unknown, scoringRunId: string): CreateScoringRevisionInput {
  const record = requireRecord(value, 'scoringRevision');
  const bodyRunId = optionalString(record.scoringRunId, 'scoringRevision.scoringRunId') ?? scoringRunId;
  if (bodyRunId !== scoringRunId) {
    throw new BadRequestException('scoringRevision.scoringRunId must match the route scoringRunId.');
  }

  const entryPoint = optionalString(record.entryPoint, 'scoringRevision.entryPoint') ?? 'report';
  if (!ENTRY_POINTS.has(entryPoint as ScoringRevisionEntryPoint)) {
    throw new BadRequestException('scoringRevision.entryPoint must be report, dimension, issue, or priority.');
  }

  return {
    scoringRunId: bodyRunId,
    entryPoint: entryPoint as ScoringRevisionEntryPoint,
    selectedIssueIndexes: optionalIntegerArray(record.selectedIssueIndexes, 'scoringRevision.selectedIssueIndexes'),
    selectedDimensions: optionalStringArray(record.selectedDimensions, 'scoringRevision.selectedDimensions'),
    selectedRevisionPriorities: optionalStringArray(record.selectedRevisionPriorities, 'scoringRevision.selectedRevisionPriorities'),
    userInstruction: optionalString(record.userInstruction, 'scoringRevision.userInstruction'),
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function optionalStringArray(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be an array.`);
  const normalized = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new BadRequestException(`${field}[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
  return [...new Set(normalized)];
}

function optionalIntegerArray(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be an array.`);
  const normalized = value.map((item, index) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
      throw new BadRequestException(`${field}[${index}] must be a non-negative integer.`);
    }
    return item;
  });
  return [...new Set(normalized)];
}
