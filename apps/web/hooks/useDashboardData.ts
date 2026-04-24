import { useState, useEffect, useMemo } from 'react';
import {
  ProjectSummary,
  VolumeSummary,
  DashboardPayload,
  StoryEventItem,
  CharacterStateItem,
  ForeshadowItem,
  ReviewItem,
  ValidationIssue,
  RebuildResult,
  ValidationRunResult,
} from '../types/dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

type PolishResult = {
  draftId: string;
  originalWordCount?: number;
  polishedWordCount?: number;
  text?: string;
};

type ResolveValidationIssueResult = {
  issueId: string;
  resolved: boolean;
  updatedCount: number;
};

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

/**
 * Build a targeted LLM instruction for fixing one validation issue without rewriting unrelated prose.
 * The polish pipeline stores the result as a new current draft, so this instruction must be narrow.
 */
function buildValidationFixInstruction(issue: ValidationIssue) {
  return [
    '请只修复以下结构化事实校验问题，不要重写整章，不要改变主线结果。',
    '修复方式：优先在相关段落补充必要过渡、空间移动、时间衔接或事实澄清；保持原有叙事视角、语气和人物关系。',
    `问题类型：${issue.issueType}`,
    `严重程度：${issue.severity}`,
    `问题详情：${issue.message}`,
    issue.suggestion ? `已有建议：${issue.suggestion}` : '',
    '输出要求：直接输出修复后的完整章节正文，不要添加说明、标题、diff 或分析。',
  ].filter(Boolean).join('\n');
}

/**
 * Build a stable client-side action id so the issue card can show a loading state
 * even before every validation source consistently returns a database id.
 */
function getValidationIssueActionId(issue: ValidationIssue) {
  return issue.id ?? `${issue.issueType}:${issue.chapterId ?? 'project'}:${issue.message}`;
}

export function useDashboardData() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedChapterId, setSelectedChapterId] = useState('all');
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [storyEvents, setStoryEvents] = useState<StoryEventItem[]>([]);
  const [characterStates, setCharacterStates] = useState<CharacterStateItem[]>([]);
  const [foreshadowTracks, setForeshadowTracks] = useState<ForeshadowItem[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([]);
  const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [rebuildResult, setRebuildResult] = useState<RebuildResult | null>(null);
  const [validationRunResult, setValidationRunResult] = useState<ValidationRunResult | null>(null);
  const [draftRefreshKey, setDraftRefreshKey] = useState(0);
  const [fixingValidationIssueId, setFixingValidationIssueId] = useState('');

  const chapterQuery = useMemo(() => {
    if (!selectedProjectId || selectedChapterId === 'all') {
      return '';
    }
    return `?chapterId=${encodeURIComponent(selectedChapterId)}`;
  }, [selectedChapterId, selectedProjectId]);

  const loadProjects = async () => {
    const data = await apiFetch<ProjectSummary[]>('/projects');
    setProjects(data);
  };

  const loadProjectData = async (projectId: string, chapterId: string) => {
    if (!projectId) return;

    const query = chapterId !== 'all' ? `?chapterId=${encodeURIComponent(chapterId)}` : '';
    setLoading(true);
    setError('');
    try {
      const [dashboardData, eventData, stateData, foreshadowData, reviewData, validationData, volumeData] = await Promise.all([
        apiFetch<DashboardPayload>(`/projects/${projectId}/memory/dashboard${query}`),
        apiFetch<StoryEventItem[]>(`/projects/${projectId}/story-events${query}`),
        apiFetch<CharacterStateItem[]>(`/projects/${projectId}/character-state-snapshots${query}`),
        apiFetch<ForeshadowItem[]>(`/projects/${projectId}/foreshadow-tracks${query}`),
        apiFetch<ReviewItem[]>(`/projects/${projectId}/memory/reviews${query}`),
        apiFetch<ValidationIssue[]>(`/projects/${projectId}/validation-issues${query}`),
        apiFetch<VolumeSummary[]>(`/projects/${projectId}/volumes`),
      ]);

      setDashboard(dashboardData);
      setStoryEvents(eventData);
      setCharacterStates(stateData);
      setForeshadowTracks(foreshadowData);
      setReviewQueue(reviewData);
      setValidationIssues(validationData);
      setVolumes(volumeData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '项目列表加载失败');
    });
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    loadProjectData(selectedProjectId, selectedChapterId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '数据加载失败');
    });
  }, [selectedProjectId, selectedChapterId]);

  const runReviewAction = async (memoryId: string, action: 'confirm' | 'reject') => {
    if (!selectedProjectId) return;
    setActionMessage(action === 'confirm' ? '正在确认记忆…' : '正在拒绝记忆…');
    try {
      await apiFetch(`/projects/${selectedProjectId}/memory/reviews/${memoryId}/${action}`, { method: 'POST' });
      await loadProjectData(selectedProjectId, selectedChapterId);
      setActionMessage(action === 'confirm' ? '已确认记忆并同步到事实层。' : '已拒绝记忆并同步到事实层。');
    } catch (reviewError) {
      setActionMessage(reviewError instanceof Error ? reviewError.message : '审核操作失败');
    }
  };

  const runRebuild = async (dryRun: boolean) => {
    if (!selectedProjectId) return;
    setActionMessage(dryRun ? '正在执行 dry-run rebuild…' : '正在执行正式 rebuild…');
    setRebuildResult(null);
    try {
      const result = await apiFetch<RebuildResult>(
        `/projects/${selectedProjectId}/memory/rebuild${chapterQuery}${chapterQuery ? '&' : '?'}dryRun=${dryRun ? 'true' : 'false'}`,
        { method: 'POST' },
      );
      setRebuildResult(result);
      if (!dryRun) {
        await loadProjectData(selectedProjectId, selectedChapterId);
      }
      setActionMessage(dryRun ? 'dry-run 完成，可查看 diff 摘要。' : 'rebuild 完成，面板已刷新。');
    } catch (rebuildError) {
      setActionMessage(rebuildError instanceof Error ? rebuildError.message : 'rebuild 失败');
    }
  };

  const runValidation = async () => {
    if (!selectedProjectId) return;
    setActionMessage('正在执行结构化事实硬规则校验…');
    setValidationRunResult(null);
    try {
      const result = await apiFetch<ValidationRunResult>(
        `/projects/${selectedProjectId}/validation/run${chapterQuery}`,
        { method: 'POST' },
      );
      setValidationRunResult(result);
      await loadProjectData(selectedProjectId, selectedChapterId);
      setActionMessage('硬规则校验完成，问题列表已刷新。');
    } catch (validationError) {
      setActionMessage(validationError instanceof Error ? validationError.message : '校验执行失败');
    }
  };

  const fixValidationIssue = async (issue: ValidationIssue) => {
    if (!selectedProjectId) return;
    if (fixingValidationIssueId) return;

    const issueChapterId = issue.chapterId ?? (selectedChapterId !== 'all' ? selectedChapterId : '');
    if (!issueChapterId) {
      setActionMessage('该校验问题缺少章节信息，无法自动定位正文。');
      return;
    }

    const issueActionId = getValidationIssueActionId(issue);
    const issueChapterQuery = `?chapterId=${encodeURIComponent(issueChapterId)}`;
    setFixingValidationIssueId(issueActionId);
    setActionMessage('AI 正在根据校验问题修正文稿…');
    try {
      await apiFetch<PolishResult>(`/chapters/${issueChapterId}/polish`, {
        method: 'POST',
        body: JSON.stringify({ userInstruction: buildValidationFixInstruction(issue) }),
      });

      // 修复会生成新的当前草稿；必须重建事实层并复检，否则右侧问题列表仍是旧事实结果。
      setActionMessage('AI 已生成修正版，正在重建事实层…');
      await apiFetch<RebuildResult>(
        `/projects/${selectedProjectId}/memory/rebuild${issueChapterQuery}&dryRun=false`,
        { method: 'POST' },
      );

      setActionMessage('事实层已更新，正在重新校验…');
      const validationResult = await apiFetch<ValidationRunResult>(
        `/projects/${selectedProjectId}/validation/run${issueChapterQuery}`,
        { method: 'POST' },
      );

      if (issue.id) {
        // LLM 类问题（例如 spatial_error）不一定会被硬规则复检覆盖；成功生成修复稿后先关闭原问题，
        // 后续若 LLM 校验器再次发现同类问题，会重新写入一条新的 open issue。
        await apiFetch<ResolveValidationIssueResult>(`/validation-issues/${issue.id}/resolve`, { method: 'POST' });
      }

      setValidationRunResult(validationResult);
      await loadProjectData(selectedProjectId, selectedChapterId);
      setDraftRefreshKey((value) => value + 1);
      setActionMessage(
        validationResult.createdCount > 0
          ? `AI 修复已生成新草稿，但复检仍有 ${validationResult.createdCount} 个问题，请继续处理。`
          : 'AI 修复已生成新草稿，当前问题已处理；事实层重建与复检均已完成。',
      );
    } catch (fixError) {
      setActionMessage(fixError instanceof Error ? fixError.message : 'AI 修复失败');
    } finally {
      setFixingValidationIssueId('');
    }
  };

  return {
    API_BASE,
    projects,
    selectedProjectId,
    setSelectedProjectId,
    selectedChapterId,
    setSelectedChapterId,
    dashboard,
    volumes,
    storyEvents,
    characterStates,
    foreshadowTracks,
    reviewQueue,
    validationIssues,
    loading,
    error,
    actionMessage,
    rebuildResult,
    validationRunResult,
    draftRefreshKey,
    fixingValidationIssueId,
    loadProjects,
    loadProjectData,
    runReviewAction,
    runRebuild,
    runValidation,
    fixValidationIssue,
  };
}
