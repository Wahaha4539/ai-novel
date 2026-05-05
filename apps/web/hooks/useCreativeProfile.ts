import { useCallback, useEffect, useState } from 'react';
import { CreativeProfile } from '../types/dashboard';

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

export function useCreativeProfile(projectId: string) {
  const [profile, setProfile] = useState<CreativeProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadProfile = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<CreativeProfile>(`/projects/${projectId}/creative-profile`);
      setProfile(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载创作定位失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const updateProfile = useCallback(async (data: Partial<CreativeProfile>) => {
    if (!projectId) return false;
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<CreativeProfile>(`/projects/${projectId}/creative-profile`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      setProfile(updated);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存创作定位失败');
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) {
      void loadProfile();
    }
  }, [projectId, loadProfile]);

  return {
    profile,
    loading,
    saving,
    error,
    setError,
    loadProfile,
    updateProfile,
  };
}
