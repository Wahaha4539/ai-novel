export interface ProjectRecord {
  id: string;
  title: string;
  genre?: string;
  theme?: string;
  tone?: string;
  logline?: string;
  synopsis?: string;
  targetWordCount?: number;
  status: 'draft' | 'active';
  defaultStyleProfileId?: string | null;
  defaultModelProfileId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterRecord {
  id: string;
  projectId: string;
  name: string;
  roleType?: string;
  personalityCore?: string;
  motivation?: string;
  speechStyle?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LorebookRecord {
  id: string;
  projectId: string;
  title: string;
  entryType: string;
  content: string;
  summary?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChapterRecord {
  id: string;
  projectId: string;
  volumeId?: string | null;
  chapterNo: number;
  title?: string;
  objective?: string;
  conflict?: string;
  outline?: string;
  status: 'planned' | 'drafted';
  expectedWordCount?: number;
  actualWordCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssueRecord {
  id: string;
  projectId: string;
  chapterId?: string;
  severity: 'error' | 'warning' | 'info';
  issueType: string;
  message: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface MemoryChunkRecord {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  memoryType: string;
  content: string;
  summary?: string;
  tags: string[];
  importanceScore: number;
  recencyScore: number;
  createdAt: string;
}

export interface GenerationJobRecord {
  id: string;
  projectId: string;
  jobType: 'write_chapter' | 'write_scene' | 'rewrite' | 'summarize' | 'validate';
  targetType: 'chapter' | 'scene' | 'draft';
  targetId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
  retrievalPayload: Record<string, unknown>;
  promptSnapshot?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}
