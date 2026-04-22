import { useState, useCallback } from 'react';
import { CharacterCard } from '../types/dashboard';

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

export interface CharacterFormData {
  name: string;
  roleType?: string;
  personalityCore?: string;
  motivation?: string;
  speechStyle?: string;
  backstory?: string;
  growthArc?: string;
  isDead?: boolean;
}

export function useCharacterActions(projectId: string) {
  const [characters, setCharacters] = useState<CharacterCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState('');

  const loadCharacters = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await apiFetch<CharacterCard[]>(`/projects/${projectId}/characters`);
      setCharacters(data);
    } catch (err) {
      console.error('加载角色列表失败', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const createCharacter = useCallback(async (data: CharacterFormData) => {
    setFormLoading(true);
    setFormError('');
    try {
      await apiFetch<CharacterCard>(`/projects/${projectId}/characters`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
      await loadCharacters();
      return true;
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '创建角色失败');
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [projectId, loadCharacters]);

  const updateCharacter = useCallback(async (characterId: string, data: Partial<CharacterFormData>) => {
    setFormLoading(true);
    setFormError('');
    try {
      await apiFetch<CharacterCard>(`/projects/${projectId}/characters/${characterId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      await loadCharacters();
      return true;
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '更新角色失败');
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [projectId, loadCharacters]);

  const deleteCharacter = useCallback(async (characterId: string) => {
    setFormLoading(true);
    setFormError('');
    try {
      await apiFetch(`/projects/${projectId}/characters/${characterId}`, { method: 'DELETE' });
      await loadCharacters();
      return true;
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '删除角色失败');
      return false;
    } finally {
      setFormLoading(false);
    }
  }, [projectId, loadCharacters]);

  return {
    characters,
    loading,
    formLoading,
    formError,
    setFormError,
    loadCharacters,
    createCharacter,
    updateCharacter,
    deleteCharacter,
  };
}
