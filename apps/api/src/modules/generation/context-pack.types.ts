import { RetrievalBundle, RetrievalHit } from '../memory/retrieval.service';
import { GenerationProfileSnapshot } from '../generation-profile/generation-profile.defaults';

export interface SceneExecutionPlan {
  id: string;
  sceneNo: number | null;
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
  sourceTrace: {
    sourceType: 'scene_card';
    sourceId: string;
    projectId: string;
    volumeId?: string | null;
    chapterId?: string | null;
    chapterNo?: number;
    sceneNo?: number | null;
  };
}

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
  planningContext?: {
    sceneCards: SceneExecutionPlan[];
  };
  userIntent: {
    instruction?: string;
    chapterObjective?: string | null;
    chapterConflict?: string | null;
    chapterOutline?: string | null;
  };
  generationProfile?: GenerationProfileSnapshot;
  retrievalDiagnostics: {
    queryText?: string | null;
    includeLorebook: boolean;
    includeMemory: boolean;
    diagnostics: RetrievalBundle['diagnostics'];
    retrievalPlan?: Record<string, unknown>;
    plannerDiagnostics?: Record<string, unknown>;
  };
}
