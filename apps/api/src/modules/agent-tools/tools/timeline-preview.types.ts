export type TimelineCandidateAction =
  | 'create_planned'
  | 'confirm_planned'
  | 'update_event'
  | 'archive_event'
  | 'create_discovered';

export type TimelineCandidateSourceKind = 'planned_timeline_event' | 'chapter_timeline_alignment';

export type TimelineCandidateIssueSeverity = 'warning' | 'error';

export type TimelineEventStatus = 'planned' | 'active' | 'changed' | 'archived' | (string & {});

export type TimelineEventSourceType =
  | 'manual'
  | 'agent_continuity'
  | 'agent_timeline_plan'
  | 'agent_timeline_alignment'
  | 'chapter_generation'
  | 'imported_asset'
  | (string & {});

export interface TimelineSourceRef {
  sourceType: string;
  sourceId?: string;
  title?: string;
  chapterId?: string;
  chapterNo?: number;
}

export interface TimelineCandidateSourceTrace {
  sourceKind: TimelineCandidateSourceKind;
  projectId: string;
  originTool: 'generate_timeline_preview' | 'align_chapter_timeline_preview';
  agentRunId?: string;
  planVersion?: number;
  toolName?: string;
  candidateId: string;
  candidateAction: TimelineCandidateAction;
  chapterId?: string;
  chapterNo?: number;
  draftId?: string;
  contextSources: TimelineSourceRef[];
  evidence?: string;
  generatedAt?: string;
  validatedAt?: string;
}

export interface TimelineValidationTrace {
  status: 'pending' | 'passed' | 'warning' | 'failed' | (string & {});
  issueCount?: number;
  errors?: string[];
  warnings?: string[];
  validatedAt?: string;
}

export interface TimelineCandidateMetadata extends Record<string, unknown> {
  sourceKind: TimelineCandidateSourceKind;
  sourceTrace: TimelineCandidateSourceTrace;
  validation?: TimelineValidationTrace;
  candidateId: string;
  candidateAction: TimelineCandidateAction;
  previousTimelineEventId?: string;
  persistedBy?: string;
  persistedAt?: string;
}

export type TimelineCandidateChapterRef =
  | { chapterId: string; chapterNo?: number }
  | { chapterId?: string; chapterNo: number };

export type TimelineCandidateWriteFields = TimelineCandidateChapterRef & {
  title: string;
  eventTime: string;
  locationName?: string | null;
  participants: string[];
  cause: string;
  result: string;
  impactScope: string;
  isPublic: boolean;
  knownBy: string[];
  unknownBy: string[];
  eventStatus: TimelineEventStatus;
  sourceType: TimelineEventSourceType;
  metadata: TimelineCandidateMetadata;
};

export type TimelineCandidate = TimelineCandidateWriteFields & {
  candidateId: string;
  action: TimelineCandidateAction;
  existingTimelineEventId?: string;
  sourceTrace: TimelineCandidateSourceTrace;
  impactAnalysis: string;
  conflictRisk: string;
  diffKey: {
    chapterId?: string;
    chapterNo?: number;
    title: string;
    eventTime: string;
    existingTimelineEventId?: string;
  };
  proposedFields: TimelineCandidateWriteFields;
};

export interface GenerateTimelinePreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  sourceType?: 'book_outline' | 'volume_outline' | 'chapter_outline' | 'craft_brief' | 'story_event' | (string & {});
  chapterId?: string;
  chapterNo?: number;
  draftId?: string;
  minCandidates?: number;
  maxCandidates?: number;
}

export interface GenerateTimelinePreviewOutput {
  candidates: TimelineCandidate[];
  assumptions: string[];
  risks: string[];
  writePlan: {
    mode: 'preview_only';
    target: 'TimelineEvent';
    sourceKind: TimelineCandidateSourceKind;
    candidateCount: number;
    allowedActions: TimelineCandidateAction[];
    requiresValidation: true;
    requiresApprovalBeforePersist: true;
  };
}

export interface AlignChapterTimelinePreviewInput {
  chapterId?: string;
  chapterNo?: number;
  draftId?: string;
  context?: Record<string, unknown>;
  instruction?: string;
  maxCandidates?: number;
}

export interface ValidateTimelinePreviewInput {
  preview?: GenerateTimelinePreviewOutput;
  taskContext?: Record<string, unknown>;
}

export interface TimelineValidationIssue {
  severity: TimelineCandidateIssueSeverity;
  candidateId?: string;
  action?: TimelineCandidateAction | string;
  message: string;
  path?: string;
  suggestion?: string;
}

export interface TimelineAcceptedCandidate {
  candidateId: string;
  action: TimelineCandidateAction;
  existingTimelineEventId: string | null;
  label: string;
  chapterId: string | null;
  chapterNo: number | null;
  sourceTrace: TimelineCandidateSourceTrace;
}

export interface TimelineRejectedCandidate {
  candidateId: string;
  action: TimelineCandidateAction | string;
  label: string;
  reason: string;
  issues: string[];
}

export interface TimelineWritePreviewEntry {
  candidateId: string;
  action: TimelineCandidateAction | 'reject';
  existingTimelineEventId: string | null;
  label: string;
  reason?: string;
  before: Record<string, unknown> | null;
  after: TimelineCandidateWriteFields | null;
  fieldDiff: Record<string, boolean>;
  sourceTrace?: TimelineCandidateSourceTrace;
}

export interface ValidateTimelinePreviewOutput {
  valid: boolean;
  issueCount: number;
  issues: TimelineValidationIssue[];
  accepted: TimelineAcceptedCandidate[];
  rejected: TimelineRejectedCandidate[];
  writePreview: {
    projectScope: 'context.projectId';
    target: 'TimelineEvent';
    sourceKind: TimelineCandidateSourceKind;
    summary: {
      createPlannedCount: number;
      confirmPlannedCount: number;
      updateCount: number;
      archiveCount: number;
      createDiscoveredCount: number;
      rejectCount: number;
    };
    entries: TimelineWritePreviewEntry[];
    requiresApprovalBeforePersist: true;
    approvalMessage: string;
  };
}

export interface PersistTimelineEventsInput {
  preview?: GenerateTimelinePreviewOutput;
  validation?: ValidateTimelinePreviewOutput;
  selectedCandidateIds?: string[];
  dryRun?: boolean;
}

export interface PersistTimelineEventsOutput {
  createdCount: number;
  confirmedCount: number;
  updatedCount: number;
  archivedCount: number;
  skippedUnselectedCount: number;
  events: Array<{
    candidateId: string;
    action: TimelineCandidateAction;
    timelineEventId: string;
    eventStatus: TimelineEventStatus;
  }>;
}
