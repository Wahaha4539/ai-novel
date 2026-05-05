export type RetrievalImportance = 'must' | 'should' | 'nice_to_have';

/**
 * Retrieval Planner 只表达“需要查什么”，不表达事实本身。
 * query 会经过程序校验、限流和真实数据库查询后，命中内容才允许进入 Prompt。
 */
export interface RetrievalPlanQuery {
  query: string;
  type: string;
  importance: RetrievalImportance;
  reason: string;
}

export interface RetrievalPlan {
  chapterTasks: string[];
  entities: {
    characters: string[];
    locations: string[];
    items: string[];
    factions: string[];
  };
  lorebookQueries: RetrievalPlanQuery[];
  memoryQueries: RetrievalPlanQuery[];
  relationshipQueries: RetrievalPlanQuery[];
  timelineQueries: RetrievalPlanQuery[];
  writingRuleQueries: RetrievalPlanQuery[];
  foreshadowQueries: RetrievalPlanQuery[];
  constraints: string[];
}

export interface RetrievalPlannerDiagnostics {
  status: 'ok' | 'fallback';
  elapsedMs: number;
  model?: string;
  usage?: Record<string, number>;
  rawQueryCount: number;
  normalizedQueryCount: number;
  warnings: string[];
  fallbackReason?: string;
}

export interface RetrievalPlannerResult {
  plan: RetrievalPlan;
  diagnostics: RetrievalPlannerDiagnostics;
}
