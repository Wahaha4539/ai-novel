import {
  TimelineCandidate,
  TimelineCandidateAction,
  TimelineCandidateIssueSeverity,
  TimelineCandidateSourceKind,
  TimelineCandidateSourceTrace,
  TimelineCandidateWriteFields,
  TimelineEventSourceType,
  TimelineEventStatus,
  TimelineSourceRef,
} from './timeline-preview.types';

const TIMELINE_ACTIONS = new Set<TimelineCandidateAction>([
  'create_planned',
  'confirm_planned',
  'update_event',
  'archive_event',
  'create_discovered',
]);

const TIMELINE_SOURCE_KINDS = new Set<TimelineCandidateSourceKind>([
  'planned_timeline_event',
  'chapter_timeline_alignment',
]);

const TIMELINE_ORIGIN_TOOLS = new Set<TimelineCandidateSourceTrace['originTool']>([
  'generate_timeline_preview',
  'align_chapter_timeline_preview',
]);

export interface NormalizeTimelineCandidateOptions {
  expectedProjectId?: string;
  expectedSourceKind?: TimelineCandidateSourceKind;
  expectedOriginTool?: TimelineCandidateSourceTrace['originTool'];
}

export interface NormalizeTimelineCandidatesOptions extends NormalizeTimelineCandidateOptions {
  minCandidates?: number;
  maxCandidates?: number;
}

export interface TimelineChapterRefRow {
  id: string;
  projectId: string;
  chapterNo: number;
}

export interface TimelineResolvedChapterRef {
  candidateId: string;
  chapterId: string;
  chapterNo: number;
}

export interface ExistingTimelineEventRef {
  id: string;
  projectId: string;
  chapterId?: string | null;
  chapterNo?: number | null;
  title: string;
  eventTime?: string | null;
}

export function normalizeTimelineCandidates(value: unknown, options: NormalizeTimelineCandidatesOptions = {}): TimelineCandidate[] {
  if (!Array.isArray(value)) {
    throw new Error('timelineCandidates must be an array.');
  }
  const minCandidates = options.minCandidates ?? 1;
  if (value.length < minCandidates) {
    throw new Error(`timelineCandidates count ${value.length} is below required minimum ${minCandidates}.`);
  }
  if (options.maxCandidates !== undefined && value.length > options.maxCandidates) {
    throw new Error(`timelineCandidates count ${value.length} exceeds maximum ${options.maxCandidates}.`);
  }
  return value.map((item, index) => normalizeTimelineCandidate(item, { ...options, path: `timelineCandidates[${index}]` }));
}

export function validateTimelineCandidateChapterRefs(
  candidates: TimelineCandidate[],
  chapters: TimelineChapterRefRow[],
  expectedProjectId: string,
): TimelineResolvedChapterRef[] {
  const chaptersById = new Map<string, TimelineChapterRefRow>();
  const chaptersByNo = new Map<number, TimelineChapterRefRow>();
  for (const chapter of chapters) {
    if (chapter.projectId !== expectedProjectId) {
      throw new Error(`Chapter reference index contains cross-project chapter: ${chapter.id}.`);
    }
    if (chaptersById.has(chapter.id)) {
      throw new Error(`Chapter reference index contains duplicate chapterId: ${chapter.id}.`);
    }
    if (chaptersByNo.has(chapter.chapterNo)) {
      throw new Error(`Chapter reference index contains duplicate chapterNo: ${chapter.chapterNo}.`);
    }
    chaptersById.set(chapter.id, chapter);
    chaptersByNo.set(chapter.chapterNo, chapter);
  }

  return candidates.map((candidate) => {
    const chapterById = candidate.chapterId ? chaptersById.get(candidate.chapterId) : undefined;
    const chapterByNo = candidate.chapterNo !== undefined ? chaptersByNo.get(candidate.chapterNo) : undefined;
    if (candidate.chapterId && !chapterById) {
      throw new Error(`Timeline candidate ${candidate.candidateId} chapterId does not belong to current project: ${candidate.chapterId}.`);
    }
    if (candidate.chapterNo !== undefined && !chapterByNo) {
      throw new Error(`Timeline candidate ${candidate.candidateId} chapterNo does not belong to current project: ${candidate.chapterNo}.`);
    }
    if (chapterById && chapterByNo && chapterById.id !== chapterByNo.id) {
      throw new Error(`Timeline candidate ${candidate.candidateId} chapterId and chapterNo do not match: ${candidate.chapterId} != chapter ${candidate.chapterNo}.`);
    }
    const chapter = chapterById ?? chapterByNo;
    if (!chapter) {
      throw new Error(`Timeline candidate ${candidate.candidateId} must reference a current-project chapter.`);
    }
    return { candidateId: candidate.candidateId, chapterId: chapter.id, chapterNo: chapter.chapterNo };
  });
}

export function assertNoTimelineDuplicateConflicts(
  candidates: TimelineCandidate[],
  existingEvents: ExistingTimelineEventRef[],
  options: { expectedProjectId: string; resolvedChapterRefs?: TimelineResolvedChapterRef[] },
): void {
  const resolvedByCandidateId = new Map((options.resolvedChapterRefs ?? []).map((ref) => [ref.candidateId, ref]));
  const existingByKey = new Map<string, ExistingTimelineEventRef>();
  for (const event of existingEvents) {
    if (event.projectId !== options.expectedProjectId) {
      throw new Error(`Existing TimelineEvent index contains cross-project event: ${event.id}.`);
    }
    const key = timelineKeyFromExisting(event);
    if (!key) continue;
    const previous = existingByKey.get(key);
    if (previous) {
      throw new Error(`Existing TimelineEvent rows already duplicate same chapter/title/time: ${previous.id} and ${event.id}.`);
    }
    existingByKey.set(key, event);
  }

  const candidateByKey = new Map<string, TimelineCandidate>();
  for (const candidate of candidates) {
    if (candidate.action === 'archive_event') continue;
    const key = timelineKeyFromCandidate(candidate, resolvedByCandidateId.get(candidate.candidateId));
    const previousCandidate = candidateByKey.get(key);
    if (previousCandidate) {
      throw new Error(`Duplicate timeline candidates write same chapter/title/time: ${previousCandidate.candidateId} and ${candidate.candidateId}.`);
    }
    candidateByKey.set(key, candidate);

    const existing = existingByKey.get(key);
    if (existing && existing.id !== candidate.existingTimelineEventId) {
      throw new Error(`Timeline candidate ${candidate.candidateId} would duplicate existing same-project TimelineEvent: ${existing.id}.`);
    }
  }
}

export function normalizeTimelineCandidate(value: unknown, options: NormalizeTimelineCandidateOptions & { path?: string } = {}): TimelineCandidate {
  const path = options.path ?? 'timelineCandidate';
  const record = requireRecord(value, path);
  const candidateId = requireText(record, 'candidateId', path);
  const action = requireAction(record, path);
  const chapterId = optionalText(record, 'chapterId', path);
  const chapterNo = optionalPositiveInt(record, 'chapterNo', path);
  if (!chapterId && chapterNo === undefined) {
    throw new Error(`${path}.chapterId or ${path}.chapterNo is required.`);
  }
  const chapterRef = chapterId
    ? { chapterId, ...(chapterNo !== undefined ? { chapterNo } : {}) }
    : { chapterNo: chapterNo as number };

  const sourceTrace = normalizeSourceTrace(record.sourceTrace, {
    ...options,
    path: `${path}.sourceTrace`,
    candidateId,
    action,
  });
  const existingTimelineEventId = optionalText(record, 'existingTimelineEventId', path);
  const metadata = normalizeMetadata(record.metadata, path, sourceTrace, candidateId, action, existingTimelineEventId);
  const writeFields: TimelineCandidateWriteFields = {
    ...chapterRef,
    title: requireText(record, 'title', path),
    eventTime: requireText(record, 'eventTime', path),
    locationName: optionalText(record, 'locationName', path) ?? null,
    participants: requireStringArray(record, 'participants', path),
    cause: requireText(record, 'cause', path),
    result: requireText(record, 'result', path),
    impactScope: requireText(record, 'impactScope', path),
    isPublic: requireBoolean(record, 'isPublic', path),
    knownBy: requireStringArray(record, 'knownBy', path),
    unknownBy: requireStringArray(record, 'unknownBy', path),
    eventStatus: requireText(record, 'eventStatus', path) as TimelineEventStatus,
    sourceType: requireText(record, 'sourceType', path) as TimelineEventSourceType,
    metadata,
  };

  return {
    ...writeFields,
    candidateId,
    action,
    ...(existingTimelineEventId ? { existingTimelineEventId } : {}),
    sourceTrace,
    impactAnalysis: requireText(record, 'impactAnalysis', path),
    conflictRisk: requireText(record, 'conflictRisk', path),
    diffKey: {
      ...(chapterId ? { chapterId } : {}),
      ...(chapterNo !== undefined ? { chapterNo } : {}),
      title: writeFields.title,
      eventTime: writeFields.eventTime,
      ...(existingTimelineEventId ? { existingTimelineEventId } : {}),
    },
    proposedFields: writeFields,
  };
}

export function summarizeTimelineActions(candidates: TimelineCandidate[]) {
  return candidates.reduce(
    (summary, candidate) => {
      if (candidate.action === 'create_planned') summary.createPlannedCount += 1;
      else if (candidate.action === 'confirm_planned') summary.confirmPlannedCount += 1;
      else if (candidate.action === 'update_event') summary.updateCount += 1;
      else if (candidate.action === 'archive_event') summary.archiveCount += 1;
      else if (candidate.action === 'create_discovered') summary.createDiscoveredCount += 1;
      return summary;
    },
    { createPlannedCount: 0, confirmPlannedCount: 0, updateCount: 0, archiveCount: 0, createDiscoveredCount: 0, rejectCount: 0 },
  );
}

export function severityRank(severity: TimelineCandidateIssueSeverity): number {
  return severity === 'error' ? 2 : 1;
}

function normalizeSourceTrace(
  value: unknown,
  options: NormalizeTimelineCandidateOptions & {
    path: string;
    candidateId: string;
    action: TimelineCandidateAction;
  },
): TimelineCandidateSourceTrace {
  const record = requireRecord(value, options.path);
  const sourceKind = requireText(record, 'sourceKind', options.path) as TimelineCandidateSourceKind;
  if (!TIMELINE_SOURCE_KINDS.has(sourceKind)) {
    throw new Error(`${options.path}.sourceKind is invalid: ${sourceKind}.`);
  }
  if (options.expectedSourceKind && sourceKind !== options.expectedSourceKind) {
    throw new Error(`${options.path}.sourceKind does not match expected source kind ${options.expectedSourceKind}.`);
  }
  const projectId = requireText(record, 'projectId', options.path);
  if (options.expectedProjectId && projectId !== options.expectedProjectId) {
    throw new Error(`${options.path}.projectId is cross-project or mismatched: ${projectId}.`);
  }
  const originTool = requireText(record, 'originTool', options.path) as TimelineCandidateSourceTrace['originTool'];
  if (!TIMELINE_ORIGIN_TOOLS.has(originTool)) {
    throw new Error(`${options.path}.originTool is invalid: ${originTool}.`);
  }
  if (options.expectedOriginTool && originTool !== options.expectedOriginTool) {
    throw new Error(`${options.path}.originTool does not match expected origin tool ${options.expectedOriginTool}.`);
  }
  const traceCandidateId = requireText(record, 'candidateId', options.path);
  if (traceCandidateId !== options.candidateId) {
    throw new Error(`${options.path}.candidateId does not match candidateId ${options.candidateId}.`);
  }
  const traceAction = requireText(record, 'candidateAction', options.path);
  if (traceAction !== options.action) {
    throw new Error(`${options.path}.candidateAction does not match action ${options.action}.`);
  }

  return {
    sourceKind,
    projectId,
    originTool,
    agentRunId: optionalText(record, 'agentRunId', options.path),
    planVersion: optionalPositiveInt(record, 'planVersion', options.path),
    toolName: optionalText(record, 'toolName', options.path),
    candidateId: traceCandidateId,
    candidateAction: options.action,
    chapterId: optionalText(record, 'chapterId', options.path),
    chapterNo: optionalPositiveInt(record, 'chapterNo', options.path),
    draftId: optionalText(record, 'draftId', options.path),
    contextSources: normalizeContextSources(record.contextSources, `${options.path}.contextSources`),
    evidence: optionalText(record, 'evidence', options.path),
    generatedAt: optionalText(record, 'generatedAt', options.path),
    validatedAt: optionalText(record, 'validatedAt', options.path),
  };
}

function normalizeMetadata(
  value: unknown,
  path: string,
  sourceTrace: TimelineCandidateSourceTrace,
  candidateId: string,
  action: TimelineCandidateAction,
  existingTimelineEventId?: string,
) {
  const metadata = value === undefined || value === null ? {} : requireRecord(value, `${path}.metadata`);
  if (metadata.sourceTrace !== undefined && JSON.stringify(metadata.sourceTrace) !== JSON.stringify(sourceTrace)) {
    throw new Error(`${path}.metadata.sourceTrace does not match sourceTrace.`);
  }
  if (metadata.candidateId !== undefined && metadata.candidateId !== candidateId) {
    throw new Error(`${path}.metadata.candidateId does not match candidateId ${candidateId}.`);
  }
  if (metadata.candidateAction !== undefined && metadata.candidateAction !== action) {
    throw new Error(`${path}.metadata.candidateAction does not match action ${action}.`);
  }
  return {
    ...metadata,
    sourceKind: sourceTrace.sourceKind,
    sourceTrace,
    candidateId,
    candidateAction: action,
    ...(existingTimelineEventId ? { previousTimelineEventId: existingTimelineEventId } : {}),
  };
}

function normalizeContextSources(value: unknown, path: string): TimelineSourceRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  if (!value.length) {
    throw new Error(`${path} must contain at least one source.`);
  }
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = requireRecord(item, itemPath);
    return {
      sourceType: requireText(record, 'sourceType', itemPath),
      sourceId: optionalText(record, 'sourceId', itemPath),
      title: optionalText(record, 'title', itemPath),
      chapterId: optionalText(record, 'chapterId', itemPath),
      chapterNo: optionalPositiveInt(record, 'chapterNo', itemPath),
    };
  });
}

function timelineKeyFromCandidate(candidate: TimelineCandidate, resolved?: TimelineResolvedChapterRef): string {
  const chapterKey = resolved
    ? `chapterNo:${resolved.chapterNo}`
    : candidate.chapterNo !== undefined
      ? `chapterNo:${candidate.chapterNo}`
      : `chapterId:${candidate.chapterId}`;
  return `${chapterKey}|${normalizeKeyPart(candidate.title)}|${normalizeKeyPart(candidate.eventTime)}`;
}

function timelineKeyFromExisting(event: ExistingTimelineEventRef): string | null {
  const chapterKey = event.chapterNo != null
    ? `chapterNo:${event.chapterNo}`
    : event.chapterId
      ? `chapterId:${event.chapterId}`
      : null;
  if (!chapterKey) return null;
  return `${chapterKey}|${normalizeKeyPart(event.title)}|${normalizeKeyPart(event.eventTime ?? '')}`;
}

function normalizeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function requireAction(record: Record<string, unknown>, path: string): TimelineCandidateAction {
  const action = requireText(record, 'action', path) as TimelineCandidateAction;
  if (!TIMELINE_ACTIONS.has(action)) {
    throw new Error(`${path}.action is invalid: ${action}.`);
  }
  return action;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  const text = value.trim();
  if (!text) {
    throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  return text;
}

function optionalText(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${path}.${key} must be a string when provided.`);
  }
  const text = value.trim();
  if (!text) {
    throw new Error(`${path}.${key} must not be blank when provided.`);
  }
  return text;
}

function optionalPositiveInt(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path}.${key} must be a positive integer when provided.`);
  }
  return value as number;
}

function requireBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${path}.${key} must be a boolean.`);
  }
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string, path: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${path}.${key} must be a non-empty string array.`);
  }
  if (!value.length) {
    throw new Error(`${path}.${key} must contain at least one string.`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`${path}.${key}[${index}] must be a string.`);
    }
    const text = item.trim();
    if (!text || text === '无' || text.toLowerCase() === 'none' || text.toLowerCase() === 'n/a') {
      throw new Error(`${path}.${key}[${index}] must be a meaningful string.`);
    }
    return text;
  });
}
