import { useState, useCallback } from 'react';
import { VolumeSummary } from '../types/dashboard';

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

export type VolumeFormData = {
  volumeNo: number;
  title?: string;
  synopsis?: string;
  objective?: string;
  chapterCount?: number;
};

export function useVolumeActions(projectId: string) {
  const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadVolumes = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<VolumeSummary[]>(`/projects/${projectId}/volumes`);
      setVolumes(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '卷列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const createVolume = useCallback(async (formData: VolumeFormData) => {
    if (!projectId) return false;
    setError('');
    try {
      await apiFetch(`/projects/${projectId}/volumes`, {
        method: 'POST',
        body: JSON.stringify(formData),
      });
      await loadVolumes();
      return true;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建卷失败');
      return false;
    }
  }, [projectId, loadVolumes]);

  const updateVolume = useCallback(async (volumeId: string, formData: Partial<VolumeFormData> & { status?: string }) => {
    if (!projectId) return false;
    setError('');
    try {
      await apiFetch(`/projects/${projectId}/volumes/${volumeId}`, {
        method: 'PATCH',
        body: JSON.stringify(formData),
      });
      await loadVolumes();
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新卷失败');
      return false;
    }
  }, [projectId, loadVolumes]);

  const deleteVolume = useCallback(async (volumeId: string) => {
    if (!projectId) return false;
    setError('');
    try {
      await apiFetch(`/projects/${projectId}/volumes/${volumeId}`, {
        method: 'DELETE',
      });
      await loadVolumes();
      return true;
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除卷失败');
      return false;
    }
  }, [projectId, loadVolumes]);

  return {
    volumes,
    loading,
    error,
    setError,
    loadVolumes,
    createVolume,
    updateVolume,
    deleteVolume,
  };
}
