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
