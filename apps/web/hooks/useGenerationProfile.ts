import { useCallback, useEffect, useState } from 'react';
import { GenerationProfile } from '../types/dashboard';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createDefaultGenerationProfile(projectId: string): GenerationProfile {
  return {
    projectId,
    defaultChapterWordCount: null,
    autoContinue: false,
    autoSummarize: true,
    autoUpdateCharacterState: true,
    autoUpdateTimeline: false,
    autoValidation: true,
    allowNewCharacters: false,
    allowNewLocations: true,
    allowNewForeshadows: true,
    preGenerationChecks: [],
    promptBudget: {},
    metadata: {},
  };
}

export function normalizeGenerationProfile(projectId: string, profile?: Partial<GenerationProfile> | null): GenerationProfile {
  const defaults = createDefaultGenerationProfile(projectId);

  return {
    ...defaults,
    ...profile,
    projectId: profile?.projectId ?? projectId,
    defaultChapterWordCount: profile?.defaultChapterWordCount ?? defaults.defaultChapterWordCount,
    autoContinue: profile?.autoContinue ?? defaults.autoContinue,
    autoSummarize: profile?.autoSummarize ?? defaults.autoSummarize,
    autoUpdateCharacterState: profile?.autoUpdateCharacterState ?? defaults.autoUpdateCharacterState,
    autoUpdateTimeline: profile?.autoUpdateTimeline ?? defaults.autoUpdateTimeline,
    autoValidation: profile?.autoValidation ?? defaults.autoValidation,
    allowNewCharacters: profile?.allowNewCharacters ?? defaults.allowNewCharacters,
    allowNewLocations: profile?.allowNewLocations ?? defaults.allowNewLocations,
    allowNewForeshadows: profile?.allowNewForeshadows ?? defaults.allowNewForeshadows,
    preGenerationChecks: Array.isArray(profile?.preGenerationChecks) ? profile.preGenerationChecks : defaults.preGenerationChecks,
    promptBudget: isRecord(profile?.promptBudget) ? profile.promptBudget : defaults.promptBudget,
    metadata: isRecord(profile?.metadata) ? profile.metadata : defaults.metadata,
  };
}

export function useGenerationProfile(projectId: string) {
  const [profile, setProfile] = useState<GenerationProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadProfile = useCallback(async () => {
    if (!projectId) {
      setProfile(null);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<GenerationProfile>(`/projects/${projectId}/generation-profile`);
      setProfile(normalizeGenerationProfile(projectId, data));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载生成策略失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const updateProfile = useCallback(async (data: Partial<GenerationProfile>) => {
    if (!projectId) return false;

    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<GenerationProfile>(`/projects/${projectId}/generation-profile`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      setProfile(normalizeGenerationProfile(projectId, updated));
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存生成策略失败');
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

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
