export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type GenerationStage =
  | 'queued'
  | 'retrieving_memory'
  | 'validating_context'
  | 'generating_text'
  | 'summarizing'
  | 'extracting_facts'
  | 'validating_output'
  | 'completed';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssueDto {
  severity: ValidationSeverity;
  issueType: string;
  entityType?: string;
  entityId?: string;
  message: string;
  evidence: Array<{
    sourceType: string;
    sourceId?: string;
    snippet?: string;
  }>;
  suggestion?: string;
}

export interface GenerateChapterRequest {
  mode: 'draft' | 'rewrite';
  instruction?: string;
  wordCount?: number;
  styleProfileId?: string;
  modelProfileId?: string;
  includeLorebook?: boolean;
  includeMemory?: boolean;
  validateBeforeWrite?: boolean;
  validateAfterWrite?: boolean;
  stream?: boolean;
}

export interface BuiltPromptDebug {
  tokenBudget: number;
  lorebookCount: number;
  memoryCount: number;
  truncated: boolean;
}

export const STORY_BIBLE_ENTRY_TYPES = [
  'world_rule',
  'power_system',
  'faction',
  'faction_relation',
  'location',
  'item',
  'history_event',
  'religion',
  'economy',
  'technology',
  'forbidden_rule',
  'setting',
] as const;

export type StoryBibleEntryType = (typeof STORY_BIBLE_ENTRY_TYPES)[number];

export interface LorebookEntryDto {
  id: string;
  projectId: string;
  title: string;
  entryType: StoryBibleEntryType | string;
  content: string;
  summary?: string | null;
  tags: string[];
  priority: number;
  triggerKeywords: string[];
  relatedEntityIds: string[];
  status: string;
  sourceType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCreativeProfileDto {
  id: string;
  projectId: string;
  audienceType?: string | null;
  platformTarget?: string | null;
  sellingPoints: string[];
  pacingPreference?: string | null;
  targetWordCount?: number | null;
  chapterWordCount?: number | null;
  contentRating?: string | null;
  centralConflict: Record<string, unknown>;
  generationDefaults: Record<string, unknown>;
  validationDefaults: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type WritingRuleSeverity = ValidationSeverity;

export interface WritingRuleDto {
  id: string;
  projectId: string;
  ruleType: string;
  title: string;
  content: string;
  severity: WritingRuleSeverity;
  appliesFromChapterNo?: number | null;
  appliesToChapterNo?: number | null;
  entityType?: string | null;
  entityRef?: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWritingRuleRequest {
  ruleType: string;
  title: string;
  content: string;
  severity?: WritingRuleSeverity;
  appliesFromChapterNo?: number;
  appliesToChapterNo?: number;
  entityType?: string;
  entityRef?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export type UpdateWritingRuleRequest = Partial<CreateWritingRuleRequest>;

export interface ListWritingRulesQuery {
  ruleType?: string;
  status?: string;
  severity?: WritingRuleSeverity;
  chapterNo?: number;
  entityType?: string;
  entityRef?: string;
  q?: string;
}

export interface RelationshipEdgeDto {
  id: string;
  projectId: string;
  characterAId?: string | null;
  characterBId?: string | null;
  characterAName: string;
  characterBName: string;
  relationType: string;
  publicState?: string | null;
  hiddenState?: string | null;
  conflictPoint?: string | null;
  emotionalArc?: string | null;
  turnChapterNos: number[];
  finalState?: string | null;
  status: string;
  sourceType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRelationshipEdgeRequest {
  characterAId?: string;
  characterBId?: string;
  characterAName: string;
  characterBName: string;
  relationType: string;
  publicState?: string;
  hiddenState?: string;
  conflictPoint?: string;
  emotionalArc?: string;
  turnChapterNos?: number[];
  finalState?: string;
  status?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

export type UpdateRelationshipEdgeRequest = Partial<CreateRelationshipEdgeRequest>;

export interface ListRelationshipEdgesQuery {
  characterName?: string;
  status?: string;
  chapterNo?: number;
  q?: string;
}

export type TimelineEventStatus = 'planned' | 'active' | 'changed' | 'archived' | (string & {});

export type TimelineEventSourceType =
  | 'manual'
  | 'agent_continuity'
  | 'agent_timeline_plan'
  | 'agent_timeline_alignment'
  | 'chapter_generation'
  | 'imported_asset'
  | (string & {});

export interface TimelineEventSourceRef {
  sourceType: string;
  sourceId?: string;
  title?: string;
  chapterId?: string;
  chapterNo?: number;
}

export interface TimelineEventSourceTrace {
  sourceKind: string;
  projectId?: string;
  agentRunId?: string;
  planVersion?: number;
  toolName?: string;
  candidateId?: string;
  candidateAction?: string;
  chapterId?: string;
  chapterNo?: number;
  draftId?: string;
  contextSources?: TimelineEventSourceRef[];
  evidence?: string;
  generatedAt?: string;
  validatedAt?: string;
}

export interface TimelineEventValidationTrace {
  status: 'pending' | 'passed' | 'warning' | 'failed' | (string & {});
  issueCount?: number;
  errors?: string[];
  warnings?: string[];
  validatedAt?: string;
}

export interface TimelineEventMetadata extends Record<string, unknown> {
  sourceKind?: string;
  sourceTrace?: TimelineEventSourceTrace;
  validation?: TimelineEventValidationTrace;
  candidateId?: string;
  candidateAction?: string;
  previousTimelineEventId?: string;
  persistedBy?: string;
  persistedAt?: string;
}

export interface TimelineEventDto {
  id: string;
  projectId: string;
  chapterId?: string | null;
  chapterNo?: number | null;
  title: string;
  eventTime?: string | null;
  locationName?: string | null;
  participants: string[];
  cause?: string | null;
  result?: string | null;
  impactScope?: string | null;
  isPublic: boolean;
  knownBy: string[];
  unknownBy: string[];
  eventStatus: TimelineEventStatus;
  sourceType: TimelineEventSourceType;
  metadata: TimelineEventMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTimelineEventRequest {
  chapterId?: string;
  chapterNo?: number;
  title: string;
  eventTime?: string;
  locationName?: string;
  participants?: string[];
  cause?: string;
  result?: string;
  impactScope?: string;
  isPublic?: boolean;
  knownBy?: string[];
  unknownBy?: string[];
  eventStatus?: TimelineEventStatus;
  sourceType?: TimelineEventSourceType;
  metadata?: TimelineEventMetadata;
}

export type UpdateTimelineEventRequest = Partial<CreateTimelineEventRequest>;

export interface ListTimelineEventsQuery {
  chapterNo?: number;
  eventStatus?: string;
  knownBy?: string;
  q?: string;
}
