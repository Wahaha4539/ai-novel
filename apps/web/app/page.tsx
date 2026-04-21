'use client';

import { useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

type ProjectSummary = {
  id: string;
  title: string;
  genre?: string | null;
  theme?: string | null;
  tone?: string | null;
  status: string;
  stats?: {
    chapterCount?: number;
    characterCount?: number;
    memoryChunkCount?: number;
    storyEventCount?: number;
    characterStateSnapshotCount?: number;
    foreshadowTrackCount?: number;
  };
};

type ChapterSummary = {
  id: string;
  chapterNo: number;
  title?: string | null;
  timelineSeq?: number | null;
  status?: string;
};

type StoryEventItem = {
  id: string;
  chapterId: string;
  chapterNo?: number | null;
  title: string;
  eventType: string;
  description: string;
  participants?: string[] | unknown;
  timelineSeq?: number | null;
  status: string;
};

type CharacterStateItem = {
  id: string;
  chapterId: string;
  chapterNo?: number | null;
  characterName: string;
  stateType: string;
  stateValue: string;
  summary?: string | null;
  status: string;
};

type ForeshadowItem = {
  id: string;
  chapterId: string;
  chapterNo?: number | null;
  title: string;
  detail?: string | null;
  status: string;
  reviewStatus?: string;
  foreshadowStatus?: string;
  firstSeenChapterNo?: number | null;
  lastSeenChapterNo?: number | null;
};

type ReviewItem = {
  id: string;
  memoryType: string;
  content: string;
  summary?: string | null;
  status: string;
  sourceTrace?: {
    chapterId?: string;
    chapterNo?: number;
    kind?: string;
  };
  metadata?: Record<string, unknown>;
};

type ValidationIssue = {
  id?: string;
  issueType: string;
  severity: 'error' | 'warning' | 'info' | string;
  message: string;
  suggestion?: string | null;
  chapterId?: string | null;
};

type DashboardPayload = {
  project: ProjectSummary;
  chapters: ChapterSummary[];
  storyEvents: StoryEventItem[];
  characterStateSnapshots: CharacterStateItem[];
  foreshadowTracks: ForeshadowItem[];
  reviewQueue: ReviewItem[];
  validationIssues: ValidationIssue[];
};

type RebuildResult = {
  processedChapterCount: number;
  failedChapterCount?: number;
  diffSummary?: Record<string, { deleted: number; created: number; delta: number }>;
  failedChapters?: Array<{ chapterNo?: number; error: string }>;
};

type ValidationRunResult = {
  createdCount: number;
  deletedCount: number;
  issues: ValidationIssue[];
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

function StatusBadge({ value }: { value: string }) {
  const style =
    value === 'error' || value === 'rejected'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
      : value === 'warning' || value === 'pending_review'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : value === 'user_confirmed' || value === 'completed' || value === 'detected'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          : 'border-slate-600 bg-slate-800 text-slate-200';

  return <span className={`badge ${style}`}>{value}</span>;
}

function SectionHeader({ title, desc, action }: { title: string; desc: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="mt-1 text-sm text-slate-400">{desc}</p>
      </div>
      {action}
    </div>
  );
}

export default function HomePage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedChapterId, setSelectedChapterId] = useState('all');
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [storyEvents, setStoryEvents] = useState<StoryEventItem[]>([]);
  const [characterStates, setCharacterStates] = useState<CharacterStateItem[]>([]);
  const [foreshadowTracks, setForeshadowTracks] = useState<ForeshadowItem[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [rebuildResult, setRebuildResult] = useState<RebuildResult | null>(null);
  const [validationRunResult, setValidationRunResult] = useState<ValidationRunResult | null>(null);

  const chapterQuery = useMemo(() => {
    if (!selectedProjectId || selectedChapterId === 'all') {
      return '';
    }
    return `?chapterId=${encodeURIComponent(selectedChapterId)}`;
  }, [selectedChapterId, selectedProjectId]);

  const loadProjects = async () => {
    const data = await apiFetch<ProjectSummary[]>('/projects');
    setProjects(data);
    if (!selectedProjectId && data[0]?.id) {
      setSelectedProjectId(data[0].id);
    }
  };

  const loadProjectData = async (projectId: string, chapterId: string) => {
    if (!projectId) {
      return;
    }

    const query = chapterId !== 'all' ? `?chapterId=${encodeURIComponent(chapterId)}` : '';
    setLoading(true);
    setError('');
    try {
      const [dashboardData, eventData, stateData, foreshadowData, reviewData, validationData] = await Promise.all([
        apiFetch<DashboardPayload>(`/projects/${projectId}/memory/dashboard${query}`),
        apiFetch<StoryEventItem[]>(`/projects/${projectId}/story-events${query}`),
        apiFetch<CharacterStateItem[]>(`/projects/${projectId}/character-state-snapshots${query}`),
        apiFetch<ForeshadowItem[]>(`/projects/${projectId}/foreshadow-tracks${query}`),
        apiFetch<ReviewItem[]>(`/projects/${projectId}/memory/reviews${query}`),
        apiFetch<ValidationIssue[]>(`/projects/${projectId}/validation-issues${query}`),
      ]);

      setDashboard(dashboardData);
      setStoryEvents(eventData);
      setCharacterStates(stateData);
      setForeshadowTracks(foreshadowData);
      setReviewQueue(reviewData);
      setValidationIssues(validationData);
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
    if (!selectedProjectId) {
      return;
    }
    loadProjectData(selectedProjectId, selectedChapterId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '数据加载失败');
    });
  }, [selectedProjectId, selectedChapterId]);

  const runReviewAction = async (memoryId: string, action: 'confirm' | 'reject') => {
    if (!selectedProjectId) {
      return;
    }
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
    if (!selectedProjectId) {
      return;
    }
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
    if (!selectedProjectId) {
      return;
    }
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

  const selectedProject = projects.find((item) => item.id === selectedProjectId) ?? dashboard?.project;
  const chapters = dashboard?.chapters ?? [];

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-6 py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="panel p-8">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-sm text-cyan-200">
                Phase 2 / Phase 4 Console
              </div>
              <h1 className="text-4xl font-bold tracking-tight text-white">结构化事实 / 记忆审核 / Rebuild / 校验面板</h1>
              <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-300">
                已接入结构化事实读取接口、待审核记忆工作流、rebuild 工具结果查看，以及首批基于事实层的硬规则校验。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:min-w-[420px]">
              <div>
                <label className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">项目</label>
                <select
                  className="select"
                  value={selectedProjectId}
                  onChange={(event) => {
                    setSelectedProjectId(event.target.value);
                    setSelectedChapterId('all');
                  }}
                >
                  <option value="">请选择项目</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500">章节范围</label>
                <select className="select" value={selectedChapterId} onChange={(event) => setSelectedChapterId(event.target.value)}>
                  <option value="all">全项目</option>
                  {chapters.map((chapter) => (
                    <option key={chapter.id} value={chapter.id}>
                      第{chapter.chapterNo}章 · {chapter.title || '未命名章节'}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3 text-sm text-slate-400">
            <span>API Base：{API_BASE}</span>
            {selectedProject && <span>当前项目：{selectedProject.title}</span>}
            {loading && <span>正在加载数据…</span>}
          </div>
          {(error || actionMessage) && (
            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-200">
              {error || actionMessage}
            </div>
          )}
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_1.2fr_1.2fr]">
          <article className="panel p-5">
            <SectionHeader
              title="项目概览"
              desc="查看项目统计、当前范围和基本工程状态。"
              action={
                <button className="btn-secondary" onClick={() => selectedProjectId && loadProjectData(selectedProjectId, selectedChapterId)}>
                  刷新
                </button>
              }
            />
            {selectedProject ? (
              <div className="mt-5 space-y-4 text-sm text-slate-300">
                <div>
                  <div className="text-xl font-semibold text-white">{selectedProject.title}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StatusBadge value={selectedProject.status} />
                    {selectedProject.genre ? <span className="badge border-slate-700 bg-slate-800 text-slate-200">{selectedProject.genre}</span> : null}
                    {selectedProject.theme ? <span className="badge border-slate-700 bg-slate-800 text-slate-200">{selectedProject.theme}</span> : null}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">章节</div>
                    <div className="mt-1 text-2xl font-semibold text-white">{selectedProject.stats?.chapterCount ?? chapters.length}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">待审核记忆</div>
                    <div className="mt-1 text-2xl font-semibold text-white">{reviewQueue.length}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">结构化事件</div>
                    <div className="mt-1 text-2xl font-semibold text-white">{storyEvents.length}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">校验问题</div>
                    <div className="mt-1 text-2xl font-semibold text-white">{validationIssues.length}</div>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-slate-400">
                  当前支持：StoryEvent / CharacterStateSnapshot / ForeshadowTrack 读取、pending_review 审核、单章/全项目 rebuild、基于事实层硬规则校验。
                </div>
              </div>
            ) : (
              <div className="mt-5 text-sm text-slate-500">暂无项目，请先通过 API 或验证脚本创建项目数据。</div>
            )}
          </article>

          <article className="panel p-5">
            <SectionHeader title="Rebuild 工具" desc="支持 dry-run / 正式执行，显示 diff 摘要与失败统计。" />
            <div className="mt-5 flex flex-wrap gap-3">
              <button className="btn-secondary" disabled={!selectedProjectId || loading} onClick={() => runRebuild(true)}>
                Dry Run
              </button>
              <button className="btn" disabled={!selectedProjectId || loading} onClick={() => runRebuild(false)}>
                正式 Rebuild
              </button>
            </div>
            {rebuildResult ? (
              <div className="mt-5 space-y-4 text-sm text-slate-300">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">成功章节</div>
                    <div className="mt-1 text-xl font-semibold text-white">{rebuildResult.processedChapterCount}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">失败章节</div>
                    <div className="mt-1 text-xl font-semibold text-white">{rebuildResult.failedChapterCount ?? 0}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {Object.entries(rebuildResult.diffSummary ?? {}).map(([key, value]) => (
                    <div key={key} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                      <div className="font-medium text-white">{key}</div>
                      <div className="mt-1 text-xs text-slate-400">
                        deleted {value.deleted} / created {value.created} / delta {value.delta}
                      </div>
                    </div>
                  ))}
                </div>
                {(rebuildResult.failedChapters?.length ?? 0) > 0 && (
                  <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4">
                    <div className="font-medium text-rose-200">失败章节</div>
                    <div className="mt-2 space-y-2 text-xs text-rose-100">
                      {rebuildResult.failedChapters?.map((item, index) => (
                        <div key={`${item.chapterNo}-${index}`}>第{item.chapterNo ?? '?'}章：{item.error}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-5 text-sm text-slate-500">执行 rebuild 后将在这里显示 diffSummary 与 failedChapters。</p>
            )}
          </article>

          <article className="panel p-5">
            <SectionHeader title="事实校验器" desc="运行 Phase 4 前置硬规则：时间线、死亡角色、伏笔首次出现。" />
            <div className="mt-5 flex flex-wrap gap-3">
              <button className="btn" disabled={!selectedProjectId || loading} onClick={runValidation}>
                运行硬规则校验
              </button>
            </div>
            {validationRunResult ? (
              <div className="mt-5 space-y-3 text-sm text-slate-300">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">新增问题</div>
                    <div className="mt-1 text-xl font-semibold text-white">{validationRunResult.createdCount}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="text-xs text-slate-500">替换旧问题</div>
                    <div className="mt-1 text-xl font-semibold text-white">{validationRunResult.deletedCount}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {validationRunResult.issues.slice(0, 5).map((issue, index) => (
                    <div key={`${issue.issueType}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge value={issue.severity} />
                        <span className="text-white">{issue.issueType}</span>
                      </div>
                      <div className="mt-2 text-slate-300">{issue.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-5 text-sm text-slate-500">运行后将展示本轮校验生成的问题摘要。</p>
            )}
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          <article className="panel p-5">
            <SectionHeader title="StoryEvent" desc="结构化事件读取接口结果。" />
            <div className="mt-5 space-y-3">
              {storyEvents.length ? (
                storyEvents.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-white">{event.title}</span>
                      <StatusBadge value={event.status} />
                      <span className="badge border-slate-700 bg-slate-800 text-slate-200">{event.eventType}</span>
                    </div>
                    <p className="mt-2 leading-6 text-slate-300">{event.description}</p>
                    <div className="mt-2 text-xs text-slate-500">
                      第{event.chapterNo ?? '?'}章 · timelineSeq {event.timelineSeq ?? '—'} · 参与者：
                      {Array.isArray(event.participants) ? event.participants.join('、') : '—'}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-500">暂无 StoryEvent 数据。</div>
              )}
            </div>
          </article>

          <article className="panel p-5">
            <SectionHeader title="CharacterStateSnapshot" desc="角色状态快照与审核状态。" />
            <div className="mt-5 space-y-3">
              {characterStates.length ? (
                characterStates.map((state) => (
                  <div key={state.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-white">{state.characterName}</span>
                      <StatusBadge value={state.status} />
                      <span className="badge border-slate-700 bg-slate-800 text-slate-200">{state.stateType}</span>
                    </div>
                    <div className="mt-2 text-slate-300">{state.stateValue}</div>
                    {state.summary ? <div className="mt-2 text-xs text-slate-500">{state.summary}</div> : null}
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-500">暂无 CharacterStateSnapshot 数据。</div>
              )}
            </div>
          </article>

          <article className="panel p-5">
            <SectionHeader title="ForeshadowTrack" desc="伏笔读取接口与首次/最近出现章节。" />
            <div className="mt-5 space-y-3">
              {foreshadowTracks.length ? (
                foreshadowTracks.map((track) => (
                  <div key={track.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-white">{track.title}</span>
                      <StatusBadge value={track.reviewStatus ?? track.status} />
                      <span className="badge border-slate-700 bg-slate-800 text-slate-200">{track.foreshadowStatus ?? track.status}</span>
                    </div>
                    {track.detail ? <div className="mt-2 text-slate-300">{track.detail}</div> : null}
                    <div className="mt-2 text-xs text-slate-500">
                      首次出现：第{track.firstSeenChapterNo ?? '—'}章 · 最近出现：第{track.lastSeenChapterNo ?? '—'}章
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-500">暂无 ForeshadowTrack 数据。</div>
              )}
            </div>
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_1.2fr]">
          <article className="panel p-5">
            <SectionHeader title="待审核记忆队列" desc="pending_review → user_confirmed / rejected 工作流。" />
            <div className="mt-5 space-y-3">
              {reviewQueue.length ? (
                reviewQueue.map((item) => (
                  <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge value={item.status} />
                      <span className="badge border-slate-700 bg-slate-800 text-slate-200">{item.memoryType}</span>
                      {item.sourceTrace?.chapterNo != null ? (
                        <span className="text-xs text-slate-500">第{item.sourceTrace.chapterNo}章</span>
                      ) : null}
                    </div>
                    <div className="mt-2 text-white">{item.summary || '未命名记忆'}</div>
                    <div className="mt-2 leading-6 text-slate-300">{item.content}</div>
                    <div className="mt-4 flex gap-3">
                      <button className="btn" onClick={() => runReviewAction(item.id, 'confirm')}>
                        确认
                      </button>
                      <button className="btn-danger" onClick={() => runReviewAction(item.id, 'reject')}>
                        拒绝
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-500">当前范围内没有 pending_review 记忆。</div>
              )}
            </div>
          </article>

          <article className="panel p-5">
            <SectionHeader title="ValidationIssue" desc="当前项目/章节的结构化事实校验结果。" />
            <div className="mt-5 space-y-3">
              {validationIssues.length ? (
                validationIssues.map((issue, index) => (
                  <div key={`${issue.issueType}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge value={issue.severity} />
                      <span className="text-white">{issue.issueType}</span>
                    </div>
                    <div className="mt-2 text-slate-300">{issue.message}</div>
                    {issue.suggestion ? <div className="mt-2 text-xs text-slate-500">建议：{issue.suggestion}</div> : null}
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-500">当前范围暂无校验问题。</div>
              )}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
