import { useState, useCallback } from 'react';
import { ProjectSummary } from '../types/dashboard';

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

  return (await response.json()) as T;
}

export interface ProjectFormData {
  title: string;
  genre?: string;
  theme?: string;
  tone?: string;
  targetWordCount?: number;
}

export function useProjectActions(onProjectsChanged: () => Promise<void>) {
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState('');

  const createProject = useCallback(async (data: ProjectFormData) => {
    setFormLoading(true);
    setFormError('');
    try {
      const result = await apiFetch<ProjectSummary>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      await onProjectsChanged();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建项目失败';
      setFormError(msg);
      return null;
    } finally {
      setFormLoading(false);
    }
  }, [onProjectsChanged]);

  const updateProject = useCallback(async (projectId: string, data: Partial<ProjectFormData>) => {
    setFormLoading(true);
    setFormError('');
    try {
      const result = await apiFetch<ProjectSummary>(`/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      await onProjectsChanged();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '更新项目失败';
      setFormError(msg);
      return null;
    } finally {
      setFormLoading(false);
    }
  }, [onProjectsChanged]);

  const deleteProject = useCallback(async (projectId: string) => {
    setFormLoading(true);
    setFormError('');
    try {
      await apiFetch(`/projects/${projectId}`, { method: 'DELETE' });
      await onProjectsChanged();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除项目失败';
      setFormError(msg);
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [onProjectsChanged]);

  /** 批量删除项目 — 逐个执行删除请求，避免并发过载 */
  const batchDeleteProjects = useCallback(async (projectIds: string[]) => {
    setFormLoading(true);
    setFormError('');
    try {
      for (const id of projectIds) {
        await apiFetch(`/projects/${id}`, { method: 'DELETE' });
      }
      await onProjectsChanged();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '批量删除失败';
      setFormError(msg);
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [onProjectsChanged]);

  return {
    formLoading,
    formError,
    setFormError,
    createProject,
    updateProject,
    deleteProject,
    batchDeleteProjects,
  };
}
