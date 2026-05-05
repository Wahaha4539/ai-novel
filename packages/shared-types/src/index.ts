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
