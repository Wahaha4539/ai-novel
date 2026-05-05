import { useCallback, useState } from 'react';
import {
  ChapterPattern,
  PacingBeat,
  QualityReport,
  RelationshipEdge,
  SceneCard,
  TimelineEvent,
  WritingRule,
} from '../types/dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }

  const text = await response.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

export type WritingRuleFormData = {
  ruleType: string;
  title: string;
  content: string;
  severity: WritingRule['severity'];
  appliesFromChapterNo?: number | null;
  appliesToChapterNo?: number | null;
  entityType?: string | null;
  entityRef?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
};

export type RelationshipEdgeFormData = {
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
  metadata?: Record<string, unknown>;
};

export type TimelineEventFormData = {
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
  metadata?: Record<string, unknown>;
};

export type SceneCardFormData = {
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
  metadata?: Record<string, unknown>;
};

export type ChapterPatternFormData = {
  patternType: string;
  name: string;
  applicableScenes: string[];
  structure?: Record<string, unknown>;
  pacingAdvice?: Record<string, unknown>;
  emotionalAdvice?: Record<string, unknown>;
  conflictAdvice?: Record<string, unknown>;
  status: string;
  metadata?: Record<string, unknown>;
};

export type PacingBeatFormData = {
  volumeId?: string | null;
  chapterId?: string | null;
  chapterNo?: number | null;
  beatType: string;
  emotionalTone?: string | null;
  emotionalIntensity?: number;
  tensionLevel?: number;
  payoffLevel?: number;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

export type QualityReportFilters = {
  chapterId?: string;
  draftId?: string;
  sourceType?: string;
  reportType?: string;
  verdict?: string;
};

export type QualityReportFormData = {
  chapterId?: string | null;
  draftId?: string | null;
  agentRunId?: string | null;
  sourceType: string;
  sourceId?: string | null;
  reportType: string;
  scores?: Record<string, unknown>;
  issues?: unknown[];
  verdict: QualityReport['verdict'];
  summary?: string | null;
  metadata?: Record<string, unknown>;
};

function useContinuityResource<TItem, TFormData>(projectId: string, resourcePath: string, createErrorText: string, updateErrorText: string, deleteErrorText: string, loadErrorText: string) {
  const [items, setItems] = useState<TItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState('');

  const collectionPath = useCallback(() => `/projects/${projectId}/${resourcePath}`, [projectId, resourcePath]);
  const itemPath = useCallback((itemId: string) => `/projects/${projectId}/${resourcePath}/${itemId}`, [projectId, resourcePath]);

  const loadItems = useCallback(async () => {
    if (!projectId) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<TItem[]>(collectionPath());
      setItems(data ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : loadErrorText);
    } finally {
      setLoading(false);
    }
  }, [collectionPath, loadErrorText, projectId]);

  const createItem = useCallback(async (data: TFormData) => {
    if (!projectId) return false;

    setFormLoading(true);
    setError('');
    try {
      await apiFetch<TItem>(collectionPath(), {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return true;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : createErrorText);
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [collectionPath, createErrorText, projectId]);

  const updateItem = useCallback(async (itemId: string, data: Partial<TFormData>) => {
    if (!projectId) return false;

    setFormLoading(true);
    setError('');
    try {
      await apiFetch<TItem>(itemPath(itemId), {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : updateErrorText);
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [itemPath, projectId, updateErrorText]);

  const deleteItem = useCallback(async (itemId: string) => {
    if (!projectId) return false;

    setFormLoading(true);
    setError('');
    try {
      await apiFetch<void>(itemPath(itemId), { method: 'DELETE' });
      return true;
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : deleteErrorText);
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [deleteErrorText, itemPath, projectId]);

  return {
    items,
    loading,
    formLoading,
    error,
    setError,
    loadItems,
    createItem,
    updateItem,
    deleteItem,
  };
}

function buildQuery(filters?: QualityReportFilters) {
  const params = new URLSearchParams();
  Object.entries(filters ?? {}).forEach(([key, value]) => {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === 'all') return;
    params.set(key, trimmed);
  });

  const query = params.toString();
  return query ? `?${query}` : '';
}

export function useWritingRuleActions(projectId: string) {
  const resource = useContinuityResource<WritingRule, WritingRuleFormData>(
    projectId,
    'writing-rules',
    '创建写作规则失败',
    '更新写作规则失败',
    '删除写作规则失败',
    '加载写作规则失败',
  );

  return {
    writingRules: resource.items,
    loading: resource.loading,
    formLoading: resource.formLoading,
    error: resource.error,
    setError: resource.setError,
    loadWritingRules: resource.loadItems,
    createWritingRule: resource.createItem,
    updateWritingRule: resource.updateItem,
    deleteWritingRule: resource.deleteItem,
  };
}

export function useRelationshipActions(projectId: string) {
  const resource = useContinuityResource<RelationshipEdge, RelationshipEdgeFormData>(
    projectId,
    'relationships',
    '创建人物关系失败',
    '更新人物关系失败',
    '删除人物关系失败',
    '加载人物关系失败',
  );

  return {
    relationships: resource.items,
    loading: resource.loading,
    formLoading: resource.formLoading,
    error: resource.error,
    setError: resource.setError,
    loadRelationships: resource.loadItems,
    createRelationship: resource.createItem,
    updateRelationship: resource.updateItem,
    deleteRelationship: resource.deleteItem,
  };
}

export function useTimelineActions(projectId: string) {
  const resource = useContinuityResource<TimelineEvent, TimelineEventFormData>(
    projectId,
    'timeline-events',
    '创建时间线事件失败',
    '更新时间线事件失败',
    '删除时间线事件失败',
    '加载时间线事件失败',
  );

  return {
    timelineEvents: resource.items,
    loading: resource.loading,
    formLoading: resource.formLoading,
    error: resource.error,
    setError: resource.setError,
    loadTimelineEvents: resource.loadItems,
    createTimelineEvent: resource.createItem,
    updateTimelineEvent: resource.updateItem,
    deleteTimelineEvent: resource.deleteItem,
  };
}

export function useSceneActions(projectId: string) {
  const resource = useContinuityResource<SceneCard, SceneCardFormData>(
    projectId,
    'scenes',
    '创建场景卡失败',
    '更新场景卡失败',
    '删除场景卡失败',
    '加载场景卡失败',
  );

  return {
    scenes: resource.items,
    loading: resource.loading,
    formLoading: resource.formLoading,
    error: resource.error,
    setError: resource.setError,
    loadScenes: resource.loadItems,
    createScene: resource.createItem,
    updateScene: resource.updateItem,
    deleteScene: resource.deleteItem,
  };
}

export function useChapterPatternActions(projectId: string) {
  const resource = useContinuityResource<ChapterPattern, ChapterPatternFormData>(
    projectId,
    'chapter-patterns',
    '创建章节模式失败',
    '更新章节模式失败',
    '删除章节模式失败',
    '加载章节模式失败',
  );

  return {
    chapterPatterns: resource.items,
    loading: resource.loading,
    formLoading: resource.formLoading,
    error: resource.error,
    setError: resource.setError,
    loadChapterPatterns: resource.loadItems,
    createChapterPattern: resource.createItem,
    updateChapterPattern: resource.updateItem,
    deleteChapterPattern: resource.deleteItem,
  };
}

export function usePacingBeatActions(projectId: string) {
  const resource = useContinuityResource<PacingBeat, PacingBeatFormData>(
    projectId,
    'pacing-beats',
    '创建节奏节点失败',
    '更新节奏节点失败',
    '删除节奏节点失败',
    '加载节奏节点失败',
  );

  return {
    pacingBeats: resource.items,
    loading: resource.loading,
    formLoading: resource.formLoading,
    error: resource.error,
    setError: resource.setError,
    loadPacingBeats: resource.loadItems,
    createPacingBeat: resource.createItem,
    updatePacingBeat: resource.updateItem,
    deletePacingBeat: resource.deleteItem,
  };
}

export function useQualityReportActions(projectId: string) {
  const {
    formLoading,
    error,
    setError,
    createItem,
    updateItem,
    deleteItem,
  } = useContinuityResource<QualityReport, QualityReportFormData>(
    projectId,
    'quality-reports',
    '创建质量报告失败',
    '更新质量报告失败',
    '删除质量报告失败',
    '加载质量报告失败',
  );

  const loadQualityReports = useCallback(async (filters?: QualityReportFilters) => {
    if (!projectId) {
      setError('');
      return;
    }

    setError('');
    const query = buildQuery(filters);
    const path = `/projects/${projectId}/quality-reports${query}`;

    try {
      const data = await apiFetch<QualityReport[]>(path);
      setError('');
      return data ?? [];
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载质量报告失败');
      return null;
    }
  }, [projectId, setError]);

  const [qualityReports, setQualityReports] = useState<QualityReport[]>([]);
  const [loading, setLoading] = useState(false);

  const loadAndStoreQualityReports = useCallback(async (filters?: QualityReportFilters) => {
    if (!projectId) {
      setQualityReports([]);
      return;
    }

    setLoading(true);
    try {
      const data = await loadQualityReports(filters);
      if (data) setQualityReports(data);
    } finally {
      setLoading(false);
    }
  }, [loadQualityReports, projectId]);

  return {
    qualityReports,
    loading,
    formLoading,
    error,
    setError,
    loadQualityReports: loadAndStoreQualityReports,
    createQualityReport: createItem,
    updateQualityReport: updateItem,
    deleteQualityReport: deleteItem,
  };
}
