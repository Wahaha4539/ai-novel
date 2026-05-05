import { useCallback, useState } from 'react';
import { LorebookEntry, StoryBibleEntryType } from '../types/dashboard';

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

export type LorebookFormData = {
  title: string;
  entryType: StoryBibleEntryType;
  content: string;
  summary?: string;
  tags?: string[];
  status?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
};

export function useLorebookActions(projectId: string) {
  const [entries, setEntries] = useState<LorebookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState('');

  const loadEntries = useCallback(async (entryType?: string) => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const query = entryType ? `?entryType=${encodeURIComponent(entryType)}` : '';
      const data = await apiFetch<LorebookEntry[]>(`/projects/${projectId}/lorebook${query}`);
      setEntries(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载 Story Bible 失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const createEntry = useCallback(async (data: LorebookFormData) => {
    if (!projectId) return false;
    setFormLoading(true);
    setError('');
    try {
      await apiFetch<LorebookEntry>(`/projects/${projectId}/lorebook`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return true;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建 Story Bible 条目失败');
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [projectId]);

  const updateEntry = useCallback(async (entryId: string, data: Partial<LorebookFormData>) => {
    setFormLoading(true);
    setError('');
    try {
      await apiFetch<LorebookEntry>(`/projects/${projectId}/lorebook/${entryId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新 Story Bible 条目失败');
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [projectId]);

  const deleteEntry = useCallback(async (entryId: string) => {
    setFormLoading(true);
    setError('');
    try {
      await apiFetch(`/projects/${projectId}/lorebook/${entryId}`, { method: 'DELETE' });
      return true;
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除 Story Bible 条目失败');
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [projectId]);

  return {
    entries,
    loading,
    formLoading,
    error,
    setError,
    loadEntries,
    createEntry,
    updateEntry,
    deleteEntry,
  };
}
