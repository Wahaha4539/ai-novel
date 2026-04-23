import { useState, useCallback, useEffect } from 'react';
import { PromptTemplate } from '../types/dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }
  const text = await response.text();
  if (!text) return [] as T;
  return JSON.parse(text) as T;
}

export type PromptFormData = {
  projectId?: string;
  stepKey: string;
  name: string;
  description?: string;
  systemPrompt: string;
  userTemplate: string;
  isDefault?: boolean;
  tags?: string[];
  effectPreview?: string;
};

export function usePromptTemplates(projectId: string) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadTemplates = useCallback(async (stepKey?: string) => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const query = stepKey ? `?stepKey=${encodeURIComponent(stepKey)}` : '';
      const data = await apiFetch<PromptTemplate[]>(
        `/projects/${projectId}/prompt-templates${query}`,
      );
      setTemplates(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载提示词模板失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const createTemplate = useCallback(async (formData: PromptFormData) => {
    setError('');
    try {
      await apiFetch('/prompt-templates', {
        method: 'POST',
        body: JSON.stringify(formData),
      });
      await loadTemplates();
      return true;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建模板失败');
      return false;
    }
  }, [loadTemplates]);

  const updateTemplate = useCallback(async (id: string, data: Partial<PromptFormData>) => {
    setError('');
    try {
      await apiFetch(`/prompt-templates/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      await loadTemplates();
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新模板失败');
      return false;
    }
  }, [loadTemplates]);

  const setDefault = useCallback(async (id: string) => {
    setError('');
    try {
      await apiFetch(`/prompt-templates/${id}/set-default`, { method: 'PATCH' });
      await loadTemplates();
      return true;
    } catch (setDefaultError) {
      setError(setDefaultError instanceof Error ? setDefaultError.message : '设置默认失败');
      return false;
    }
  }, [loadTemplates]);

  const deleteTemplate = useCallback(async (id: string) => {
    setError('');
    try {
      await apiFetch(`/prompt-templates/${id}`, { method: 'DELETE' });
      await loadTemplates();
      return true;
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除模板失败');
      return false;
    }
  }, [loadTemplates]);

  useEffect(() => {
    if (projectId) loadTemplates();
  }, [projectId, loadTemplates]);

  return {
    templates,
    loading,
    error,
    setError,
    loadTemplates,
    createTemplate,
    updateTemplate,
    setDefault,
    deleteTemplate,
  };
}
