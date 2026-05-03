import { RetrievalBundle, RetrievalHit } from '../memory/retrieval.service';

/**
 * 写作 Prompt 的上下文包版本。
 * verifiedContext 只允许放入数据库真实命中的资料；userIntent 放入本章显式要求；retrievalDiagnostics 仅用于日志/排查，不直接进入正文事实区。
 */
export interface ChapterContextPack {
  schemaVersion: 1;
  verifiedContext: {
    lorebookHits: RetrievalHit[];
    memoryHits: RetrievalHit[];
    structuredHits: RetrievalHit[];
  };
  userIntent: {
    instruction?: string;
    chapterObjective?: string | null;
    chapterConflict?: string | null;
    chapterOutline?: string | null;
  };
  retrievalDiagnostics: {
    queryText?: string | null;
    includeLorebook: boolean;
    includeMemory: boolean;
    diagnostics: RetrievalBundle['diagnostics'];
    retrievalPlan?: Record<string, unknown>;
    plannerDiagnostics?: Record<string, unknown>;
  };
}