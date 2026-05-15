import { useCallback, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

export type ScoringTargetType = 'project_outline' | 'volume_outline' | 'chapter_outline' | 'chapter_craft_brief' | 'chapter_draft';
export type PlatformProfileKey = 'generic_longform' | 'qidian_like' | 'fanqie_like' | 'jinjiang_like' | 'published_literary';
export type ScoringVerdict = 'pass' | 'warn' | 'fail' | (string & {});

export interface PlatformScoringProfile {
  key: PlatformProfileKey;
  name: string;
  version: string;
  description: string;
  disclaimer: string;
  emphasis: string[];
  weightMultipliers: Record<string, number>;
}

export interface ScoringAssetOption {
  targetType: ScoringTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown> | null;
  title: string;
  volumeNo?: number | null;
  chapterNo?: number | null;
  draftId?: string | null;
  draftVersion?: number | null;
  source: string;
  updatedAt?: string | null;
  isScoreable?: boolean;
  unavailableReason?: string | null;
  hasScoringReports?: boolean;
  latestRun?: Pick<ScoringRun, 'id' | 'platformProfile' | 'overallScore' | 'verdict' | 'createdAt'> | null;
}

export interface ScoringDimensionScore {
  key: string;
  label: string;
  score: number;
  weight: number;
  weightedScore: number;
  confidence: 'low' | 'medium' | 'high' | (string & {});
  evidence: string;
  reason: string;
  suggestion: string;
}

export interface ScoringIssue {
  dimensionKey: string;
  severity: 'info' | 'warning' | 'blocking' | (string & {});
  path: string;
  evidence: string;
  reason: string;
  suggestion: string;
}

export interface ScoringRun {
  id: string;
  projectId: string;
  chapterId?: string | null;
  draftId?: string | null;
  agentRunId?: string | null;
  targetType: ScoringTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown> | null;
  platformProfile: PlatformProfileKey | (string & {});
  profileVersion: string;
  promptVersion: string;
  rubricVersion: string;
  overallScore: number;
  verdict: ScoringVerdict;
  summary: string;
  dimensions: ScoringDimensionScore[] | unknown;
  issues: ScoringIssue[] | unknown;
  revisionPriorities: string[] | unknown;
  extractedElements: Record<string, unknown> | unknown;
  targetSnapshot: Record<string, unknown> | unknown;
  sourceTrace: Record<string, unknown> | unknown;
  llmMetadata: Record<string, unknown> | unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScoringRunPayload {
  targetType: ScoringTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown> | null;
  draftId?: string | null;
  draftVersion?: number | null;
  profileKey: PlatformProfileKey;
}

export type ScoringRevisionEntryPoint = 'report' | 'dimension' | 'issue' | 'priority';

export interface CreateScoringRevisionPayload {
  scoringRunId: string;
  entryPoint?: ScoringRevisionEntryPoint;
  selectedIssueIndexes?: number[];
  selectedDimensions?: string[];
  selectedRevisionPriorities?: string[];
  userInstruction?: string;
}

export interface ScoringRevisionResult {
  scoringRunId: string;
  agentRunId: string;
  artifactId?: string;
  status: string;
  taskType?: string | null;
  targetType: ScoringTargetType;
  mapping: {
    targetType: ScoringTargetType;
    agentTarget: string;
    recommendedPreviewAction: string;
    expectedOutput: string;
  };
  prompt: string;
  approvalBoundary: {
    createsAgentTaskOnly: boolean;
    directlyPersistsAssets: boolean;
    requiresAgentPreviewValidationApprovalPersistFlow: boolean;
  };
}

export interface ScoringRunFilters {
  targetType?: ScoringTargetType;
  targetId?: string | null;
  profileKey?: string;
  chapterId?: string | null;
  draftId?: string | null;
}

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
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function buildScoringRunsPath(projectId: string, filters: ScoringRunFilters = {}) {
  const params = new URLSearchParams();
  if (filters.targetType) params.set('targetType', filters.targetType);
  if (filters.targetId) params.set('targetId', filters.targetId);
  if (filters.profileKey) params.set('profileKey', filters.profileKey);
  if (filters.chapterId) params.set('chapterId', filters.chapterId);
  if (filters.draftId) params.set('draftId', filters.draftId);
  const query = params.toString();
  return `/projects/${projectId}/scoring/runs${query ? `?${query}` : ''}`;
}

export function useScoringActions() {
  const [profiles, setProfiles] = useState<PlatformScoringProfile[]>([]);
  const [assets, setAssets] = useState<ScoringAssetOption[]>([]);
  const [runs, setRuns] = useState<ScoringRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState('');

  const loadProfiles = useCallback(async () => {
    setError('');
    const data = await apiFetch<PlatformScoringProfile[]>('/scoring/platform-profiles');
    setProfiles(data);
    return data;
  }, []);

  const loadAssets = useCallback(async (projectId: string) => {
    if (!projectId) {
      setAssets([]);
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<ScoringAssetOption[]>(`/projects/${projectId}/scoring/assets`);
      setAssets(data);
      return data;
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load scoring assets';
      setError(message);
      throw loadError;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (projectId: string, filters: ScoringRunFilters = {}) => {
    if (!projectId) {
      setRuns([]);
      return [];
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<ScoringRun[]>(buildScoringRunsPath(projectId, filters));
      setRuns(data);
      return data;
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load scoring reports';
      setError(message);
      throw loadError;
    } finally {
      setLoading(false);
    }
  }, []);

  const createRun = useCallback(async (projectId: string, payload: CreateScoringRunPayload) => {
    setFormLoading(true);
    setError('');
    try {
      const run = await apiFetch<ScoringRun>(`/projects/${projectId}/scoring/runs`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      return run;
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : 'Failed to create scoring report';
      setError(message);
      throw createError;
    } finally {
      setFormLoading(false);
    }
  }, []);

  const createRevision = useCallback(async (projectId: string, runId: string, payload: CreateScoringRevisionPayload) => {
    setFormLoading(true);
    setError('');
    try {
      return await apiFetch<ScoringRevisionResult>(`/projects/${projectId}/scoring/runs/${runId}/revision`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (revisionError) {
      const message = revisionError instanceof Error ? revisionError.message : 'Failed to create scoring revision task';
      setError(message);
      throw revisionError;
    } finally {
      setFormLoading(false);
    }
  }, []);

  return {
    profiles,
    assets,
    runs,
    loading,
    formLoading,
    error,
    setError,
    loadProfiles,
    loadAssets,
    loadRuns,
    createRun,
    createRevision,
  };
}
