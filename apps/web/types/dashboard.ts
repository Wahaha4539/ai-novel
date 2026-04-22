export type ProjectSummary = {
  id: string;
  title: string;
  genre?: string | null;
  theme?: string | null;
  tone?: string | null;
  synopsis?: string | null;
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
  createdAt: string;
  updatedAt: string;
};

export type ChapterSummary = {
  id: string;
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

export type DashboardPayload = {
  project: ProjectSummary;
  chapters: ChapterSummary[];
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
