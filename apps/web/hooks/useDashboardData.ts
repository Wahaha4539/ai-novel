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

type AiReviewResolveResult = {
  reviewedCount: number;
  confirmedCount: number;
  rejectedCount: number;
  skippedCount?: number;
};

type ChapterCompletionResult = {
  id: string;
  status: 'planned' | 'drafted';
  actualWordCount?: number | null;
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
 * Build a targeted LLM instruction for fixing all visible validation issues in one pass.
 * The polish pipeline stores the result as a new current draft, so the prompt keeps edits scoped while
 * still asking the model to resolve cross-issue continuity together instead of patching cards one by one.
 */
function buildValidationFixInstruction(issues: ValidationIssue[]) {
  const issueLines = issues.map((issue, index) => [
    `问题 ${index + 1}`,
    `- 类型：${issue.issueType}`,
    `- 严重程度：${issue.severity}`,
    `- 详情：${issue.message}`,
    issue.suggestion ? `- 已有建议：${issue.suggestion}` : '',
  ].filter(Boolean).join('\n'));

  return [
    '请一次性修复以下全部结构化事实校验问题，不要逐条孤立改写，不要重写整章，不要改变主线结果。',
    '修复方式：合并考虑所有问题，在相关段落补充必要过渡、空间移动、时间衔接或事实澄清；保持原有叙事视角、语气和人物关系。',
    issueLines.join('\n\n'),
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
  const [acceptedMemories, setAcceptedMemories] = useState<ReviewItem[]>([]);
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
    // 同一个 reviews 接口可按 status 过滤；这里显式请求已采纳记忆，避免和 pending_review 队列混在一起。
    const acceptedMemoryQuery = `${query}${query ? '&' : '?'}status=user_confirmed`;
    setLoading(true);
    setError('');
    try {
      const [dashboardData, eventData, stateData, foreshadowData, reviewData, acceptedMemoryData, validationData, volumeData] = await Promise.all([
        apiFetch<DashboardPayload>(`/projects/${projectId}/memory/dashboard${query}`),
        apiFetch<StoryEventItem[]>(`/projects/${projectId}/story-events${query}`),
        apiFetch<CharacterStateItem[]>(`/projects/${projectId}/character-state-snapshots${query}`),
        apiFetch<ForeshadowItem[]>(`/projects/${projectId}/foreshadow-tracks${query}`),
        apiFetch<ReviewItem[]>(`/projects/${projectId}/memory/reviews${query}`),
        apiFetch<ReviewItem[]>(`/projects/${projectId}/memory/reviews${acceptedMemoryQuery}`),
        apiFetch<ValidationIssue[]>(`/projects/${projectId}/validation-issues${query}`),
        apiFetch<VolumeSummary[]>(`/projects/${projectId}/volumes`),
      ]);

      setDashboard(dashboardData);
      setStoryEvents(eventData);
      setCharacterStates(stateData);
      setForeshadowTracks(foreshadowData);
      setReviewQueue(reviewData);
      setAcceptedMemories(acceptedMemoryData);
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

  const fixValidationIssues = async (issues: ValidationIssue[]) => {
    if (!selectedProjectId) return;
    if (fixingValidationIssueId) return;
    if (!issues.length) return;

    const issueChapterIds = Array.from(new Set(issues.map((issue) => issue.chapterId ?? (selectedChapterId !== 'all' ? selectedChapterId : '')).filter(Boolean)));
    if (issueChapterIds.length > 1) {
      setActionMessage('当前列表包含多个章节的问题，请先选择单个章节后再执行 AI 一键修复。');
      return;
    }

    const issueChapterId = issueChapterIds[0] ?? '';
    if (!issueChapterId) {
      setActionMessage('当前校验问题缺少章节信息，无法自动定位正文。');
      return;
    }

    const issueActionId = issues.length === 1 ? getValidationIssueActionId(issues[0]) : `batch:${issueChapterId}:${issues.length}`;
    const issueChapterQuery = `?chapterId=${encodeURIComponent(issueChapterId)}`;
    setFixingValidationIssueId(issueActionId);
    setActionMessage(`AI 正在一次性修复 ${issues.length} 个校验问题…`);
    try {
      await apiFetch<PolishResult>(`/chapters/${issueChapterId}/polish`, {
        method: 'POST',
        body: JSON.stringify({ userInstruction: buildValidationFixInstruction(issues) }),
      });

      // 批量修复只生成一次当前草稿；随后统一重建事实层并复检，避免每个问题单独 rebuild 产生抖动。
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

      const issueIds = issues.map((issue) => issue.id).filter((id): id is string => Boolean(id));
      if (issueIds.length) {
        // LLM 类问题（例如 spatial_error）不一定会被硬规则复检覆盖；成功生成修复稿后先关闭原问题，
        // 后续若 LLM 校验器再次发现同类问题，会重新写入一条新的 open issue。
        await Promise.all(issueIds.map((issueId) => apiFetch<ResolveValidationIssueResult>(`/validation-issues/${issueId}/resolve`, { method: 'POST' })));
      }

      setValidationRunResult(validationResult);
      await loadProjectData(selectedProjectId, selectedChapterId);
      setDraftRefreshKey((value) => value + 1);
      setActionMessage(
        validationResult.createdCount > 0
          ? `AI 已批量生成新草稿，但复检仍有 ${validationResult.createdCount} 个问题，请继续处理。`
          : 'AI 已批量生成新草稿，当前问题已处理；事实层重建与复检均已完成。',
      );
    } catch (fixError) {
      setActionMessage(fixError instanceof Error ? fixError.message : 'AI 批量修复失败');
    } finally {
      setFixingValidationIssueId('');
    }
  };

  const runAiReviewQueue = async () => {
    if (!selectedProjectId) return;

    const chapterId = selectedChapterId !== 'all' ? selectedChapterId : undefined;
    setActionMessage('AI 正在审核 pending_review 记忆…');
    try {
      const result = await apiFetch<AiReviewResolveResult>(`/projects/${selectedProjectId}/memory/reviews/ai-resolve`, {
        method: 'POST',
        body: JSON.stringify({ chapterId }),
      });

      await loadProjectData(selectedProjectId, selectedChapterId);
      setActionMessage(
        `AI 记忆审核完成：采纳 ${result.confirmedCount} 条，拒绝 ${result.rejectedCount} 条。`,
      );
    } catch (reviewError) {
      setActionMessage(reviewError instanceof Error ? reviewError.message : 'AI 记忆审核失败');
    }
  };

  /**
   * Mark the current chapter as complete without running AI, rebuild, validation, or memory review.
   * The sidebar green dot is driven by chapter.status === 'drafted', so this is a deliberate manual action.
   */
  const markChapterComplete = async (chapterId: string) => {
    if (!selectedProjectId || !chapterId || chapterId === 'all') return;

    setActionMessage('正在标记章节完成…');
    try {
      await apiFetch<ChapterCompletionResult>(`/chapters/${chapterId}/complete`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      await loadProjectData(selectedProjectId, selectedChapterId);
      setActionMessage('章节已标记完成。');
    } catch (completeError) {
      setActionMessage(completeError instanceof Error ? completeError.message : '标记章节完成失败');
    }
  };

  /**
   * Run the unattended post-generation maintenance chain: polish newly generated drafts first,
   * then stabilize the chapter through rebuild/validation before reviewing memories. Pending memories
   * are reviewed only after the text stops changing, otherwise AI may confirm facts from an intermediate
   * draft that a later validation repair rewrites.
   */
  const runAutoMaintenance = async (chapterIds?: string[]) => {
    if (!selectedProjectId) return;
    if (fixingValidationIssueId) return;

    const scopedChapterIds = chapterIds?.filter(Boolean) ?? [];
    const canUseCurrentScope = selectedChapterId !== 'all';
    const targetChapterIds = scopedChapterIds.length ? Array.from(new Set(scopedChapterIds)) : canUseCurrentScope ? [selectedChapterId] : [];

    const rebuildChapterFacts = async (chapterId: string) => {
      await apiFetch<RebuildResult>(
        `/projects/${selectedProjectId}/memory/rebuild?chapterId=${encodeURIComponent(chapterId)}&dryRun=false`,
        { method: 'POST' },
      );
    };

    const validateChapterFacts = async (chapterId: string) => apiFetch<ValidationRunResult>(
      `/projects/${selectedProjectId}/validation/run?chapterId=${encodeURIComponent(chapterId)}`,
      { method: 'POST' },
    );

    const polishChapter = async (chapterId: string, userInstruction: string) => apiFetch<PolishResult>(`/chapters/${chapterId}/polish`, {
      method: 'POST',
      body: JSON.stringify({ userInstruction }),
    });

    const reviewStableMemories = async (chapterId?: string) => apiFetch<AiReviewResolveResult>(`/projects/${selectedProjectId}/memory/reviews/ai-resolve`, {
      method: 'POST',
      body: JSON.stringify({ chapterId }),
    });

    setActionMessage(targetChapterIds.length ? '全自动流程：AI 正在润色生成草稿…' : '全自动流程：AI 正在审核待确认记忆…');
    try {
      if (targetChapterIds.length) {
        for (const chapterId of targetChapterIds) {
          await polishChapter(chapterId, '请在不改变剧情事实、人物关系和章节主线结果的前提下，润色当前章节正文：提升句子流畅度、画面感、节奏和衔接，修正明显语病与重复表达。直接输出润色后的完整章节正文，不要添加说明。');
        }
      }

      setActionMessage('全自动流程：正在根据最新正文重建事实层…');
      if (targetChapterIds.length) {
        for (const chapterId of targetChapterIds) {
          await rebuildChapterFacts(chapterId);
        }
      } else {
        await apiFetch<RebuildResult>(`/projects/${selectedProjectId}/memory/rebuild?dryRun=false`, { method: 'POST' });
      }

      setActionMessage('全自动流程：正在执行硬规则校验…');
      const validationScopes = targetChapterIds.length ? targetChapterIds : [undefined];
      let latestValidationResult: ValidationRunResult | null = null;
      const issuesToFix: ValidationIssue[] = [];
      for (const chapterId of validationScopes) {
        const query = chapterId ? `?chapterId=${encodeURIComponent(chapterId)}` : '';
        latestValidationResult = chapterId ? await validateChapterFacts(chapterId) : await apiFetch<ValidationRunResult>(`/projects/${selectedProjectId}/validation/run${query}`, { method: 'POST' });
        issuesToFix.push(...latestValidationResult.issues);
      }

      setValidationRunResult(latestValidationResult);

      if (issuesToFix.length && targetChapterIds.length === 1) {
        const issueChapterId = targetChapterIds[0];
        const issueIds = issuesToFix.map((issue) => issue.id).filter((id): id is string => Boolean(id));

        // 自动流程只修复一轮：如果复检仍失败，保留问题给用户判断，避免 LLM 无限改写正文。
        setActionMessage(`全自动流程：AI 正在修复 ${issuesToFix.length} 个校验问题…`);
        await polishChapter(issueChapterId, buildValidationFixInstruction(issuesToFix));

        setActionMessage('全自动流程：修复后正在重建事实层…');
        await rebuildChapterFacts(issueChapterId);

        setActionMessage('全自动流程：正在复查修复结果…');
        latestValidationResult = await validateChapterFacts(issueChapterId);
        setValidationRunResult(latestValidationResult);

        if (!latestValidationResult.issues.length && issueIds.length) {
          // 只有在复检通过后才关闭原问题；未通过时保留 issue，方便用户继续人工处理。
          await Promise.all(issueIds.map((issueId) => apiFetch<ResolveValidationIssueResult>(`/validation-issues/${issueId}/resolve`, { method: 'POST' })));
        }
      }

      const remainingIssues = latestValidationResult?.issues ?? [];
      if (remainingIssues.length) {
        await loadProjectData(selectedProjectId, selectedChapterId);
        setDraftRefreshKey((value) => value + 1);
        setActionMessage(`全自动流程已完成润色、重建与复检；仍有 ${remainingIssues.length} 个问题需要人工确认后再审核记忆。`);
        return;
      }

      setActionMessage('全自动流程：正文已通过校验，AI 正在审核待确认记忆…');
      const reviewScopes = targetChapterIds.length ? targetChapterIds : [undefined];
      let reviewedCount = 0;
      let confirmedCount = 0;
      let rejectedCount = 0;
      for (const chapterId of reviewScopes) {
        const reviewResult = await reviewStableMemories(chapterId);
        reviewedCount += reviewResult.reviewedCount;
        confirmedCount += reviewResult.confirmedCount;
        rejectedCount += reviewResult.rejectedCount;
      }

      setActionMessage('全自动流程：记忆审核完成，正在刷新事实层…');
      if (targetChapterIds.length) {
        for (const chapterId of targetChapterIds) {
          await rebuildChapterFacts(chapterId);
        }
      } else {
        await apiFetch<RebuildResult>(`/projects/${selectedProjectId}/memory/rebuild?dryRun=false`, { method: 'POST' });
      }

      await loadProjectData(selectedProjectId, selectedChapterId);
      setDraftRefreshKey((value) => value + 1);
      setActionMessage(
        `全自动流程已完成：正文已稳定，AI 审核 ${reviewedCount} 条记忆，采纳 ${confirmedCount} 条，拒绝 ${rejectedCount} 条；事实层已刷新。`,
      );
    } catch (autoError) {
      setActionMessage(autoError instanceof Error ? autoError.message : '全自动流程失败');
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
    acceptedMemories,
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
    fixValidationIssues,
    runAiReviewQueue,
    markChapterComplete,
    runAutoMaintenance,
  };
}
