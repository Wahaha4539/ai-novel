import { useCallback, useState } from 'react';
import { RelationshipEdge, TimelineEvent, WritingRule } from '../types/dashboard';

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
