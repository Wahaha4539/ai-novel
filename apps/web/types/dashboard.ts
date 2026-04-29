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

export type ChapterSummary = {
  id: string;
  volumeId?: string | null;
  chapterNo: number;
  title?: string | null;
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

