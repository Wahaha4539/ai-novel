import { ChapterCraftBrief } from './guided';

export type ProjectSummary = {
  id: string;
  title: string;
  genre?: string | null;
  theme?: string | null;
  tone?: string | null;
  synopsis?: string | null;
  outline?: string | null;
  status: string;
  stats?: {
    chapterCount?: number;
    characterCount?: number;
    memoryChunkCount?: number;
    storyEventCount?: number;
    characterStateSnapshotCount?: number;
    foreshadowTrackCount?: number;
  };
};

export type VolumeSummary = {
  id: string;
  projectId: string;
  volumeNo: number;
  title?: string | null;
  synopsis?: string | null;
  objective?: string | null;
  narrativePlan?: Record<string, unknown> | null;
  chapterCount?: number | null;
  status: string;
  _count?: { chapters: number };
};

export type CharacterCard = {
  id: string;
  projectId: string;
  name: string;
  roleType?: string | null;
  personalityCore?: string | null;
  motivation?: string | null;
  speechStyle?: string | null;
  backstory?: string | null;
  growthArc?: string | null;
  isDead: boolean;
  scope?: string | null;
  activeFromChapter?: number | null;
  activeToChapter?: number | null;
  source?: string;
  createdAt: string;
  updatedAt: string;
};

export type StoryBibleEntryType =
  | 'world_rule'
  | 'power_system'
  | 'faction'
  | 'faction_relation'
  | 'location'
  | 'item'
  | 'history_event'
  | 'religion'
  | 'economy'
  | 'technology'
  | 'forbidden_rule'
  | 'setting';

export type LorebookEntry = {
  id: string;
  projectId: string;
  title: string;
  entryType: StoryBibleEntryType | (string & {});
  content: string;
  summary?: string | null;
  tags: string[];
  priority?: number | null;
  triggerKeywords?: string[];
  relatedEntityIds?: string[];
  status: string;
  sourceType?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreativeProfile = {
  id?: string;
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
  createdAt?: string;
  updatedAt?: string;
};

export type GenerationProfile = {
  id?: string;
  projectId: string;
  defaultChapterWordCount?: number | null;
  autoContinue: boolean;
  autoSummarize: boolean;
  autoUpdateCharacterState: boolean;
  autoUpdateTimeline: boolean;
  autoValidation: boolean;
  allowNewCharacters: boolean;
  allowNewLocations: boolean;
  allowNewForeshadows: boolean;
  preGenerationChecks: unknown[];
  promptBudget: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type ChapterSummary = {
  id: string;
  volumeId?: string | null;
  chapterNo: number;
  title?: string | null;
  objective?: string | null;
  conflict?: string | null;
  outline?: string | null;
  craftBrief?: ChapterCraftBrief | Record<string, unknown> | null;
  timelineSeq?: number | null;
  status?: string;
};

export type StoryEventItem = {
  id: string;
  chapterId: string;
  chapterNo?: number | null;
  title: string;
  eventType: string;
  description: string;
  participants?: string[] | unknown;
  timelineSeq?: number | null;
  status: string;
};

export type CharacterStateItem = {
  id: string;
  chapterId: string;
  chapterNo?: number | null;
  characterName: string;
  stateType: string;
  stateValue: string;
  summary?: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
};

export type WritingRule = {
  id: string;
  projectId: string;
  ruleType: string;
  title: string;
  content: string;
  severity: 'info' | 'warning' | 'error';
  appliesFromChapterNo?: number | null;
  appliesToChapterNo?: number | null;
  entityType?: string | null;
  entityRef?: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipEdge = {
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
};

export type TimelineEvent = {
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
  eventStatus: string;
  sourceType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SceneCard = {
  id: string;
  projectId: string;
  volumeId?: string | null;
  chapterId?: string | null;
  sceneNo?: number | null;
  title: string;
  locationName?: string | null;
  participants: string[];
  purpose?: string | null;
  conflict?: string | null;
  emotionalTone?: string | null;
  keyInformation?: string | null;
  result?: string | null;
  relatedForeshadowIds: string[];
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ChapterPattern = {
  id: string;
  projectId: string;
  patternType: string;
  name: string;
  applicableScenes: string[];
  structure: Record<string, unknown>;
  pacingAdvice: Record<string, unknown>;
  emotionalAdvice: Record<string, unknown>;
  conflictAdvice: Record<string, unknown>;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type PacingBeat = {
  id: string;
  projectId: string;
  volumeId?: string | null;
  chapterId?: string | null;
  chapterNo?: number | null;
  beatType: string;
  emotionalTone?: string | null;
  emotionalIntensity: number;
  tensionLevel: number;
  payoffLevel: number;
  notes?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type QualityReport = {
  id: string;
  projectId: string;
  chapterId?: string | null;
  draftId?: string | null;
  agentRunId?: string | null;
  sourceType: string;
  sourceId?: string | null;
  reportType: string;
  scores: Record<string, unknown>;
  issues: unknown[];
  verdict: 'pass' | 'warn' | 'fail' | (string & {});
  summary?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ForeshadowItem = {
  id: string;
  chapterId: string;
  chapterNo?: number | null;
  title: string;
  detail?: string | null;
  status: string;
  scope?: string;
  source?: string;
  reviewStatus?: string;
  foreshadowStatus?: string;
  firstSeenChapterNo?: number | null;
  lastSeenChapterNo?: number | null;
};

export type ReviewItem = {
  id: string;
  memoryType: string;
  content: string;
  summary?: string | null;
  status: string;
  sourceTrace?: {
    chapterId?: string;
    chapterNo?: number;
    kind?: string;
  };
  metadata?: Record<string, unknown>;
};

export type ValidationIssue = {
  id?: string;
  issueType: string;
  severity: 'error' | 'warning' | 'info' | string;
  message: string;
  suggestion?: string | null;
  chapterId?: string | null;
};

export type PromptTemplate = {
  id: string;
  projectId?: string | null;
  stepKey: string;
  name: string;
  description?: string | null;
  systemPrompt: string;
  userTemplate: string;
  version: number;
  isDefault: boolean;
  tags: string[];
  effectPreview?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GuidedSession = {
  id: string;
  projectId: string;
  currentStep: string;
  stepData: Record<string, unknown>;
  isCompleted: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DashboardPayload = {
  project: ProjectSummary;
  chapters: ChapterSummary[];
  volumes: VolumeSummary[];
  storyEvents: StoryEventItem[];
  characterStateSnapshots: CharacterStateItem[];
  foreshadowTracks: ForeshadowItem[];
  reviewQueue: ReviewItem[];
  validationIssues: ValidationIssue[];
  /** 后端分区降级信息：某些面板查询失败时仍返回其余可用数据。 */
  diagnostics?: {
    partialFailures?: Array<{ section: string; message: string; code?: string }>;
  };
};

export type RebuildResult = {
  processedChapterCount: number;
  failedChapterCount?: number;
  diffSummary?: Record<string, { deleted: number; created: number; delta: number }>;
  failedChapters?: Array<{ chapterNo?: number; error: string }>;
};

export type ValidationRunResult = {
  createdCount: number;
  deletedCount: number;
  issues: ValidationIssue[];
};

/** AI-generated chapter draft content */
export type ChapterDraft = {
  id: string;
  chapterId: string;
  versionNo: number;
  content: string;
  source: string;
  modelInfo?: Record<string, unknown>;
  /** Metadata written by the API pipeline, e.g. polish.originalDraftId. */
  generationContext?: Record<string, unknown>;
  isCurrent: boolean;
  createdAt: string;
};

/** Generation job status for polling */
export type GenerationJob = {
  id: string;
  projectId: string;
  chapterId?: string | null;
  jobType: string;
  targetType: string;
  targetId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  responsePayload?: Record<string, unknown>;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
};
