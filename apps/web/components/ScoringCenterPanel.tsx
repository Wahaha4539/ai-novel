'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectSummary } from '../types/dashboard';
import {
  PlatformProfileKey,
  ScoringAssetOption,
  ScoringComparison,
  ScoringDimensionScore,
  ScoringIssue,
  ScoringRevisionResult,
  ScoringRun,
  ScoringTargetType,
  ScoringTrends,
  useScoringActions,
} from '../hooks/useScoringActions';

const TARGET_LABELS: Record<ScoringTargetType, string> = {
  project_outline: '总大纲',
  volume_outline: '卷大纲',
  chapter_outline: '章节细纲',
  chapter_craft_brief: '章节执行卡',
  chapter_draft: '章节正文',
};

const TARGET_ORDER: ScoringTargetType[] = ['project_outline', 'volume_outline', 'chapter_outline', 'chapter_craft_brief', 'chapter_draft'];
const CHAPTER_TARGETS = new Set<ScoringTargetType>(['chapter_outline', 'chapter_craft_brief', 'chapter_draft']);

type AssetTreeSection =
  | { kind: 'project'; key: string; assets: ScoringAssetOption[]; count: number }
  | { kind: 'volume'; key: string; volumeNo: number | null; volumeAssets: ScoringAssetOption[]; chapters: ChapterAssetGroup[]; looseAssets: ScoringAssetOption[]; count: number }
  | { kind: 'other'; key: string; assets: ScoringAssetOption[]; count: number };

interface ChapterAssetGroup {
  key: string;
  volumeNo: number | null;
  chapterNo: number | null;
  title: string;
  assets: ScoringAssetOption[];
}

interface MutableVolumeSection {
  key: string;
  volumeNo: number | null;
  volumeAssets: ScoringAssetOption[];
  chapters: Map<string, ChapterAssetGroup>;
  looseAssets: ScoringAssetOption[];
}

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function ScoringCenterPanel({ selectedProject, selectedProjectId }: Props) {
  const { profiles, assets, runs, comparison, trends, loading, formLoading, error, setError, loadProfiles, loadAssets, loadRuns, createRun, createBatchRuns, loadComparison, loadTrends, createRevision } = useScoringActions();
  const [targetFilter, setTargetFilter] = useState<ScoringTargetType | 'all'>('all');
  const [selectedAssetKey, setSelectedAssetKey] = useState('');
  const [profileKey, setProfileKey] = useState<PlatformProfileKey>('generic_longform');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedIssueIndexes, setSelectedIssueIndexes] = useState<number[]>([]);
  const [revisionResult, setRevisionResult] = useState<ScoringRevisionResult | null>(null);
  const [expandedVolumeKeys, setExpandedVolumeKeys] = useState<Set<string>>(() => new Set());
  const [expandedChapterKeys, setExpandedChapterKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedAssetKey('');
    setSelectedRunId('');
    setSelectedIssueIndexes([]);
    setRevisionResult(null);
    setExpandedVolumeKeys(new Set());
    setExpandedChapterKeys(new Set());
    setError('');
    if (!selectedProjectId) return;
    void Promise.all([loadProfiles(), loadAssets(selectedProjectId), loadRuns(selectedProjectId)]);
  }, [loadAssets, loadProfiles, loadRuns, selectedProjectId, setError]);

  useEffect(() => {
    setExpandedVolumeKeys(new Set());
    setExpandedChapterKeys(new Set());
  }, [targetFilter]);

  const filteredAssets = useMemo(
    () => assets.filter((asset) => targetFilter === 'all' || asset.targetType === targetFilter),
    [assets, targetFilter],
  );
  const assetSections = useMemo(() => buildAssetTreeSections(filteredAssets), [filteredAssets]);
  const selectedAsset = useMemo(() => {
    const fromState = filteredAssets.find((asset) => assetKey(asset) === selectedAssetKey);
    return fromState ?? filteredAssets.find((asset) => asset.isScoreable !== false) ?? filteredAssets[0] ?? null;
  }, [filteredAssets, selectedAssetKey]);

  useEffect(() => {
    if (selectedAsset && selectedAssetKey !== assetKey(selectedAsset)) {
      setSelectedAssetKey(assetKey(selectedAsset));
    }
  }, [selectedAsset, selectedAssetKey]);

  const selectedProfile = profiles.find((profile) => profile.key === profileKey) ?? profiles[0];
  const reportRuns = useMemo(() => {
    if (!selectedAsset) return runs;
    return runs.filter((run) => isRunForAsset(run, selectedAsset));
  }, [runs, selectedAsset]);
  const selectedRun = useMemo(
    () => reportRuns.find((run) => run.id === selectedRunId) ?? reportRuns[0] ?? null,
    [reportRuns, selectedRunId],
  );

  useEffect(() => {
    setSelectedIssueIndexes([]);
    setRevisionResult(null);
  }, [selectedRun?.id]);

  const refreshRunsForAsset = useCallback(async (asset: ScoringAssetOption) => {
    const filters = {
      targetType: asset.targetType,
      targetId: asset.targetId ?? undefined,
      draftId: asset.draftId ?? undefined,
    };
    const latest = await loadRuns(selectedProjectId, filters);
    return latest;
  }, [loadRuns, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || !selectedAsset) return;
    void loadComparison(selectedProjectId, {
      targetType: selectedAsset.targetType,
      targetId: selectedAsset.targetId,
      draftId: selectedAsset.draftId,
    });
    void loadTrends(selectedProjectId, { targetType: selectedAsset.targetType, profileKey });
  }, [loadComparison, loadTrends, profileKey, selectedAsset, selectedProjectId]);

  const handleSelectAsset = useCallback(async (asset: ScoringAssetOption) => {
    setSelectedAssetKey(assetKey(asset));
    setSelectedRunId('');
    setSelectedIssueIndexes([]);
    setRevisionResult(null);
    if (selectedProjectId) {
      await refreshRunsForAsset(asset);
    }
  }, [refreshRunsForAsset, selectedProjectId]);

  const handleCreateRun = useCallback(async () => {
    if (!selectedProjectId || !selectedAsset || selectedAsset.isScoreable === false) return;
    const run = await createRun(selectedProjectId, {
      targetType: selectedAsset.targetType,
      targetId: selectedAsset.targetId,
      targetRef: selectedAsset.targetRef,
      draftId: selectedAsset.draftId,
      draftVersion: selectedAsset.draftVersion,
      profileKey,
    });
    setSelectedRunId(run.id);
    setSelectedIssueIndexes([]);
    setRevisionResult(null);
    await Promise.all([loadAssets(selectedProjectId), refreshRunsForAsset(selectedAsset)]);
  }, [createRun, loadAssets, profileKey, refreshRunsForAsset, selectedAsset, selectedProjectId]);

  const handleCreateBatchRuns = useCallback(async () => {
    if (!selectedProjectId || !selectedAsset || selectedAsset.isScoreable === false || !profiles.length) return;
    const created = await createBatchRuns(selectedProjectId, {
      targetType: selectedAsset.targetType,
      targetId: selectedAsset.targetId,
      targetRef: selectedAsset.targetRef,
      draftId: selectedAsset.draftId,
      draftVersion: selectedAsset.draftVersion,
      profileKeys: profiles.map((profile) => profile.key),
    });
    setSelectedRunId(created[0]?.id ?? '');
    setSelectedIssueIndexes([]);
    setRevisionResult(null);
    await Promise.all([
      loadAssets(selectedProjectId),
      refreshRunsForAsset(selectedAsset),
      loadComparison(selectedProjectId, {
        targetType: selectedAsset.targetType,
        targetId: selectedAsset.targetId,
        draftId: selectedAsset.draftId,
      }),
      loadTrends(selectedProjectId, { targetType: selectedAsset.targetType, profileKey }),
    ]);
  }, [createBatchRuns, loadAssets, loadComparison, loadTrends, profileKey, profiles, refreshRunsForAsset, selectedAsset, selectedProjectId]);

  const handleCreateRevision = useCallback(async (payload: {
    entryPoint: 'report' | 'dimension' | 'issue' | 'priority';
    selectedIssueIndexes?: number[];
    selectedDimensions?: string[];
    selectedRevisionPriorities?: string[];
  }) => {
    if (!selectedProjectId || !selectedRun) return;
    const result = await createRevision(selectedProjectId, selectedRun.id, {
      scoringRunId: selectedRun.id,
      ...payload,
    });
    setRevisionResult(result);
  }, [createRevision, selectedProjectId, selectedRun]);

  const handleToggleVolume = useCallback((key: string) => {
    setExpandedVolumeKeys((current) => toggleSetValue(current, key));
  }, []);

  const handleToggleChapter = useCallback((key: string) => {
    setExpandedChapterKeys((current) => toggleSetValue(current, key));
  }, []);

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ minHeight: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 10px rgba(34,197,94,0.55)', flexShrink: 0 }} />
          <h1 className="text-lg font-bold text-heading truncate">AI 小说多维评分中心</h1>
          <span className="badge" style={{ background: 'rgba(34,197,94,0.12)', color: '#86efac', border: 'none' }}>Scoring Center</span>
        </div>
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <span className="text-xs font-medium truncate" style={{ color: 'var(--text-dim)', maxWidth: '18rem' }}>{selectedProject?.title ?? '未选择项目'}</span>
          <button className="btn-secondary" onClick={() => selectedProjectId && Promise.all([loadAssets(selectedProjectId), loadRuns(selectedProjectId)])} disabled={loading || !selectedProjectId} style={{ fontSize: '0.75rem', padding: '0.45rem 0.8rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex-1 min-h-0" style={{ overflow: 'hidden', padding: '1rem 1.25rem' }}>
        {!selectedProjectId ? (
          <div className="list-card-empty">请先选择项目</div>
        ) : (
          <div className="grid h-full gap-3" style={{ gridTemplateColumns: 'minmax(18rem, 22rem) minmax(0, 1fr)', minHeight: 0 }}>
            <aside className="panel flex flex-col" style={{ minHeight: 0, overflow: 'hidden', borderRadius: '0.65rem' }}>
              <div className="p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
                <div className="grid gap-3">
                  <label className="grid gap-1 text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
                    资产类型
                    <select className="input-field" value={targetFilter} onChange={(event) => setTargetFilter(event.target.value as ScoringTargetType | 'all')} style={{ fontSize: '0.78rem' }}>
                      <option value="all">全部可评分资产</option>
                      {TARGET_ORDER.map((type) => <option key={type} value={type}>{TARGET_LABELS[type]}</option>)}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
                    平台评分画像
                    <select className="input-field" value={profileKey} onChange={(event) => setProfileKey(event.target.value as PlatformProfileKey)} style={{ fontSize: '0.78rem' }}>
                      {profiles.map((profile) => <option key={profile.key} value={profile.key}>{profile.name} · {profile.key}</option>)}
                    </select>
                  </label>
                  {selectedProfile ? (
                    <div className="text-xs" style={{ color: 'var(--text-dim)', lineHeight: 1.6 }}>
                      <div style={{ color: 'var(--text-muted)' }}>{selectedProfile.description}</div>
                      <div>{selectedProfile.disclaimer}</div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '0.75rem' }}>
                {error ? <Notice tone="error">{error}</Notice> : null}
                {loading && !filteredAssets.length ? (
                  <div className="list-card-empty">评分资产加载中...</div>
                ) : filteredAssets.length === 0 ? (
                  <div className="list-card-empty">暂无可显示资产</div>
                ) : (
                  <AssetTree
                    sections={assetSections}
                    selectedAsset={selectedAsset}
                    expandedVolumeKeys={expandedVolumeKeys}
                    expandedChapterKeys={expandedChapterKeys}
                    onSelect={handleSelectAsset}
                    onToggleVolume={handleToggleVolume}
                    onToggleChapter={handleToggleChapter}
                  />
                )}
              </div>
            </aside>

            <section className="flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
              <div className="panel" style={{ borderRadius: '0.65rem', overflow: 'hidden', minHeight: 0 }}>
                <div className="flex flex-wrap items-start justify-between gap-3 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
                  <SelectedAssetSummary asset={selectedAsset} />
                  <div className="flex flex-wrap items-center gap-2">
                    {reportRuns.length ? (
                      <select className="input-field" value={selectedRun?.id ?? ''} onChange={(event) => setSelectedRunId(event.target.value)} style={{ width: '14rem', fontSize: '0.75rem', padding: '0.45rem 0.7rem' }}>
                        {reportRuns.map((run) => (
                          <option key={run.id} value={run.id}>{formatDate(run.createdAt)} · {run.platformProfile} · {run.overallScore.toFixed(1)}</option>
                        ))}
                      </select>
                    ) : null}
                    <button className="btn-primary" onClick={() => void handleCreateRun()} disabled={!selectedAsset || selectedAsset.isScoreable === false || formLoading} style={{ fontSize: '0.78rem', padding: '0.55rem 0.9rem' }}>
                      {formLoading ? '评分中...' : '发起评分'}
                    </button>
                    <button className="btn-secondary" onClick={() => void handleCreateBatchRuns()} disabled={!selectedAsset || selectedAsset.isScoreable === false || formLoading || profiles.length < 2} style={{ fontSize: '0.78rem', padding: '0.55rem 0.9rem' }}>
                      Score all profiles
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-h-0" style={{ overflowY: 'auto', paddingTop: '0.75rem' }}>
                {!selectedAsset ? (
                  <div className="list-card-empty">请选择评分资产</div>
                ) : selectedAsset.isScoreable === false ? (
                  <Notice tone="warn">{selectedAsset.unavailableReason ?? '当前资产缺少评分所需结构字段。'}</Notice>
                ) : !selectedRun ? (
                  <div className="list-card-empty">当前资产暂无评分报告</div>
                ) : (
                  <ReportView
                    run={selectedRun}
                    profileName={profiles.find((profile) => profile.key === selectedRun.platformProfile)?.name ?? String(selectedRun.platformProfile)}
                    formLoading={formLoading}
                    selectedIssueIndexes={selectedIssueIndexes}
                    revisionResult={revisionResult}
                    comparison={comparison}
                    trends={trends}
                    onToggleIssue={(index) => setSelectedIssueIndexes((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b)))}
                    onCreateRevision={handleCreateRevision}
                  />
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </article>
  );
}

function AssetTree({
  sections,
  selectedAsset,
  expandedVolumeKeys,
  expandedChapterKeys,
  onSelect,
  onToggleVolume,
  onToggleChapter,
}: {
  sections: AssetTreeSection[];
  selectedAsset: ScoringAssetOption | null;
  expandedVolumeKeys: Set<string>;
  expandedChapterKeys: Set<string>;
  onSelect: (asset: ScoringAssetOption) => void | Promise<void>;
  onToggleVolume: (key: string) => void;
  onToggleChapter: (key: string) => void;
}) {
  return (
    <div className="scoring-asset-tree">
      <div className="scoring-asset-tree__summary">
        <span>资产结构</span>
        <span>{sections.reduce((sum, section) => sum + section.count, 0)} 项</span>
      </div>
      {sections.map((section) => {
        if (section.kind === 'project') {
          return (
            <div key={section.key} className="scoring-asset-section">
              <div className="scoring-asset-section__header">
                <span>项目级</span>
                <span>{section.count}</span>
              </div>
              <div className="scoring-asset-section__body">
                {section.assets.map((asset) => (
                  <AssetTreeRow key={assetKey(asset)} asset={asset} selectedAsset={selectedAsset} onSelect={onSelect} />
                ))}
              </div>
            </div>
          );
        }

        if (section.kind === 'other') {
          return (
            <div key={section.key} className="scoring-asset-section">
              <div className="scoring-asset-section__header">
                <span>未归档资产</span>
                <span>{section.count}</span>
              </div>
              <div className="scoring-asset-section__body">
                {section.assets.map((asset) => (
                  <AssetTreeRow key={assetKey(asset)} asset={asset} selectedAsset={selectedAsset} onSelect={onSelect} />
                ))}
              </div>
            </div>
          );
        }

        const volumeOpen = expandedVolumeKeys.has(section.key) || sectionContainsAsset(section, selectedAsset);
        return (
          <div key={section.key} className="scoring-asset-section">
            <button
              type="button"
              className="scoring-asset-section__header"
              aria-expanded={volumeOpen}
              onClick={() => onToggleVolume(section.key)}
            >
              <span className="scoring-asset-section__title">
                <span className="scoring-asset-toggle">{volumeOpen ? '-' : '+'}</span>
                {section.volumeNo ? `第 ${section.volumeNo} 卷` : '未分卷'}
              </span>
              <span>{section.count}</span>
            </button>
            {volumeOpen ? (
              <div className="scoring-asset-section__body">
                {section.volumeAssets.map((asset) => (
                  <AssetTreeRow key={assetKey(asset)} asset={asset} selectedAsset={selectedAsset} onSelect={onSelect} />
                ))}
                {section.chapters.map((chapter) => {
                  const chapterOpen = expandedChapterKeys.has(chapter.key) || chapterContainsAsset(chapter, selectedAsset);
                  return (
                    <div key={chapter.key} className="scoring-chapter-group">
                      <button
                        type="button"
                        className="scoring-chapter-group__header"
                        aria-expanded={chapterOpen}
                        onClick={() => onToggleChapter(chapter.key)}
                      >
                        <span className="scoring-chapter-group__no">
                          <span className="scoring-asset-toggle">{chapterOpen ? '-' : '+'}</span>
                          {chapter.chapterNo ? `第 ${chapter.chapterNo} 章` : '未编号章节'}
                        </span>
                        {chapter.title ? <span className="scoring-chapter-group__title">{chapter.title}</span> : null}
                        <span className="scoring-chapter-group__count">{chapter.assets.length}</span>
                      </button>
                      {chapterOpen ? (
                        <div className="scoring-chapter-group__items">
                          {chapter.assets.map((asset) => (
                            <AssetTreeRow key={assetKey(asset)} asset={asset} selectedAsset={selectedAsset} onSelect={onSelect} nested />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {section.looseAssets.map((asset) => (
                  <AssetTreeRow key={assetKey(asset)} asset={asset} selectedAsset={selectedAsset} onSelect={onSelect} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AssetTreeRow({
  asset,
  selectedAsset,
  onSelect,
  nested = false,
}: {
  asset: ScoringAssetOption;
  selectedAsset: ScoringAssetOption | null;
  onSelect: (asset: ScoringAssetOption) => void | Promise<void>;
  nested?: boolean;
}) {
  const selected = selectedAsset ? assetKey(asset) === assetKey(selectedAsset) : false;
  const primaryLabel = nested ? nestedAssetLabel(asset) : asset.title;
  const secondaryLabel = nested && asset.title !== primaryLabel ? asset.title : '';

  return (
    <button
      type="button"
      onClick={() => void onSelect(asset)}
      className={`scoring-asset-row${selected ? ' is-selected' : ''}${asset.isScoreable === false ? ' is-unavailable' : ''}${nested ? ' is-nested' : ''}`}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="scoring-asset-row__kind">{TARGET_LABELS[asset.targetType]}</span>
      <span className="scoring-asset-row__content">
        <span className="scoring-asset-row__title">{primaryLabel}</span>
        {secondaryLabel ? <span className="scoring-asset-row__subtitle">{secondaryLabel}</span> : null}
        <span className="scoring-asset-row__meta">
          {asset.volumeNo ? <TinyMeta>VOL.{asset.volumeNo}</TinyMeta> : null}
          {asset.chapterNo ? <TinyMeta>CH.{asset.chapterNo}</TinyMeta> : null}
          {asset.draftVersion ? <TinyMeta>DRAFT V{asset.draftVersion}</TinyMeta> : null}
          <TinyMeta>{asset.source}</TinyMeta>
        </span>
        <AssetStatusLine asset={asset} />
      </span>
    </button>
  );
}

function AssetStatusLine({ asset }: { asset: ScoringAssetOption }) {
  if (asset.latestRun) {
    return (
      <span className="scoring-asset-row__status" style={{ color: scoreColor(asset.latestRun.overallScore) }}>
        最新评分 {asset.latestRun.overallScore.toFixed(1)} · {asset.latestRun.verdict}
      </span>
    );
  }
  if (asset.unavailableReason) {
    return <span className="scoring-asset-row__status" style={{ color: '#fbbf24' }}>{asset.unavailableReason}</span>;
  }
  return null;
}

function SelectedAssetSummary({ asset }: { asset: ScoringAssetOption | null }) {
  if (!asset) {
    return <div className="text-sm" style={{ color: 'var(--text-dim)' }}>未选择资产</div>;
  }
  return (
    <div style={{ minWidth: 0 }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge" style={{ borderColor: 'rgba(34,197,94,0.28)', color: '#86efac', background: 'rgba(34,197,94,0.08)' }}>{TARGET_LABELS[asset.targetType]}</span>
        <h2 className="text-base font-bold text-heading truncate" style={{ maxWidth: '38rem' }}>{asset.title}</h2>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {asset.volumeNo ? <MetaLine label="卷" value={String(asset.volumeNo)} /> : null}
        {asset.chapterNo ? <MetaLine label="章" value={String(asset.chapterNo)} /> : null}
        {asset.draftVersion ? <MetaLine label="草稿" value={`v${asset.draftVersion}`} /> : null}
        <MetaLine label="来源" value={asset.source} />
        <MetaLine label="更新" value={formatDate(asset.updatedAt)} />
      </div>
    </div>
  );
}

function ReportView({
  run,
  profileName,
  formLoading,
  selectedIssueIndexes,
  revisionResult,
  comparison,
  trends,
  onToggleIssue,
  onCreateRevision,
}: {
  run: ScoringRun;
  profileName: string;
  formLoading: boolean;
  selectedIssueIndexes: number[];
  revisionResult: ScoringRevisionResult | null;
  comparison: ScoringComparison | null;
  trends: ScoringTrends | null;
  onToggleIssue: (index: number) => void;
  onCreateRevision: (payload: {
    entryPoint: 'report' | 'dimension' | 'issue' | 'priority';
    selectedIssueIndexes?: number[];
    selectedDimensions?: string[];
    selectedRevisionPriorities?: string[];
  }) => void | Promise<void>;
}) {
  const dimensions = safeArray<ScoringDimensionScore>(run.dimensions);
  const issues = safeArray<ScoringIssue>(run.issues);
  const priorities = safeStringArray(run.revisionPriorities);
  const hasJsonFallback = !Array.isArray(run.dimensions) || !Array.isArray(run.issues) || !Array.isArray(run.revisionPriorities);

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <section className="panel p-4" style={{ borderRadius: '0.65rem' }}>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(10rem, 13rem) minmax(0, 1fr)' }}>
          <div className="stat-card" style={{ borderRadius: '0.5rem' }}>
            <div className="stat-card__label">Overall</div>
            <div className="stat-card__value" style={{ color: scoreColor(run.overallScore), fontVariantNumeric: 'tabular-nums' }}>{run.overallScore.toFixed(1)}</div>
            <span className="badge" style={verdictStyle(run.verdict)}>{run.verdict}</span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="flex flex-wrap gap-2 mb-2">
              <TinyMeta>{profileName}</TinyMeta>
              <TinyMeta>{run.rubricVersion}</TinyMeta>
              <TinyMeta>{formatDate(run.createdAt)}</TinyMeta>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-main)', lineHeight: 1.7 }}>{run.summary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className="btn-secondary" type="button" disabled={formLoading} onClick={() => void onCreateRevision({ entryPoint: 'report' })} style={{ fontSize: '0.72rem', padding: '0.45rem 0.75rem' }}>
                Rewrite from report
              </button>
              {revisionResult ? <TinyMeta>Agent task {revisionResult.agentRunId.slice(0, 8)} {'->'} {revisionResult.mapping.agentTarget}</TinyMeta> : null}
            </div>
            {revisionResult ? <RevisionBoundary result={revisionResult} /> : null}
          </div>
        </div>
      </section>

      <ComparisonPanel comparison={comparison} />
      <TrendPanel trends={trends} />

      <section className="panel p-4" style={{ borderRadius: '0.65rem' }}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-heading">维度评分</h3>
          <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{dimensions.length} dimensions</span>
        </div>
        {dimensions.length ? (
          <div className="space-y-2">
            {dimensions.map((dimension) => (
              <DimensionRow
                key={dimension.key}
                dimension={dimension}
                formLoading={formLoading}
                onCreateRevision={() => onCreateRevision({ entryPoint: 'dimension', selectedDimensions: [dimension.key] })}
              />
            ))}
          </div>
        ) : (
          <JsonFallback label="dimensions JSON fallback" value={run.dimensions} />
        )}
      </section>

      <section className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(16rem, 0.7fr)' }}>
        <div className="panel p-4" style={{ borderRadius: '0.65rem' }}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-heading">Issues</h3>
            <div className="flex items-center gap-2">
              {selectedIssueIndexes.length ? (
                <button className="btn-secondary" type="button" disabled={formLoading} onClick={() => void onCreateRevision({ entryPoint: 'issue', selectedIssueIndexes })} style={{ fontSize: '0.68rem', padding: '0.35rem 0.65rem' }}>
                  Rewrite selected issues
                </button>
              ) : null}
              <span className="text-xs" style={{ color: issues.length ? '#fbbf24' : 'var(--text-dim)' }}>{issues.length}</span>
            </div>
          </div>
          {issues.length ? (
            <div className="space-y-2">
              {issues.map((issue, index) => (
                <IssueCard
                  key={`${issue.dimensionKey}-${index}`}
                  issue={issue}
                  index={index}
                  checked={selectedIssueIndexes.includes(index)}
                  formLoading={formLoading}
                  onToggle={() => onToggleIssue(index)}
                  onCreateRevision={() => onCreateRevision({ entryPoint: 'issue', selectedIssueIndexes: [index] })}
                />
              ))}
            </div>
          ) : Array.isArray(run.issues) ? (
            <div className="text-sm" style={{ color: 'var(--text-dim)' }}>未记录阻断问题</div>
          ) : (
            <JsonFallback label="issues JSON fallback" value={run.issues} />
          )}
        </div>

        <div className="panel p-4" style={{ borderRadius: '0.65rem' }}>
          <h3 className="text-sm font-bold text-heading mb-3">Revision Priorities</h3>
          {priorities.length ? (
            <ol className="space-y-2" style={{ paddingLeft: '1.1rem' }}>
              {priorities.map((priority, index) => (
                <li key={`${priority}-${index}`} className="text-sm" style={{ color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  {priority}
                  <button className="btn-secondary ml-2" type="button" disabled={formLoading} onClick={() => void onCreateRevision({ entryPoint: 'priority', selectedRevisionPriorities: [priority] })} style={{ fontSize: '0.66rem', padding: '0.25rem 0.5rem' }}>
                    Rewrite
                  </button>
                </li>
              ))}
            </ol>
          ) : Array.isArray(run.revisionPriorities) ? (
            <div className="text-sm" style={{ color: 'var(--text-dim)' }}>暂无修订优先级</div>
          ) : (
            <JsonFallback label="revisionPriorities JSON fallback" value={run.revisionPriorities} />
          )}
        </div>
      </section>

      {hasJsonFallback ? <JsonFallback label="raw report JSON fallback" value={run} /> : null}
    </div>
  );
}

function ComparisonPanel({ comparison }: { comparison: ScoringComparison | null }) {
  if (!comparison || !comparison.profiles.length) {
    return (
      <section className="panel p-4" style={{ borderRadius: '0.65rem' }}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-heading">Platform comparison</h3>
          <span className="text-xs" style={{ color: 'var(--text-dim)' }}>Project-internal scoring profiles, not official standards.</span>
        </div>
        <div className="mt-3 text-sm" style={{ color: 'var(--text-dim)' }}>No multi-profile comparison reports yet.</div>
      </section>
    );
  }
  const maxScore = Math.max(...comparison.profiles.map((profile) => profile.overallScore), 100);
  return (
    <section className="panel p-4" style={{ borderRadius: '0.65rem' }}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-bold text-heading">Platform comparison</h3>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>Project-internal scoring profiles, not official standards.</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
        {comparison.profiles.map((profile) => (
          <div key={profile.id} className="list-card" style={{ padding: '0.75rem', borderRadius: '0.55rem' }}>
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm text-heading">{profile.platformProfile}</strong>
              <span className="text-sm" style={{ color: scoreColor(profile.overallScore), fontVariantNumeric: 'tabular-nums' }}>{profile.overallScore.toFixed(1)}</span>
            </div>
            <div className="mt-2" style={{ height: '0.4rem', borderRadius: 999, background: 'var(--bg-hover-subtle)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(0, Math.min(100, (profile.overallScore / maxScore) * 100))}%`, height: '100%', background: scoreColor(profile.overallScore) }} />
            </div>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>{profile.summary}</p>
          </div>
        ))}
      </div>
      {comparison.keyDimensionDifferences.length ? (
        <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))' }}>
          {comparison.keyDimensionDifferences.slice(0, 4).map((item) => (
            <div key={item.dimensionKey} className="text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text-main)' }}>{item.label}</strong>: spread {item.spread.toFixed(1)}; high {item.highest?.platformProfile ?? '-'} {item.highest?.score ?? '-'} / low {item.lowest?.platformProfile ?? '-'} {item.lowest?.score ?? '-'}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TrendPanel({ trends }: { trends: ScoringTrends | null }) {
  const points = trends?.points ?? [];
  if (!points.length) {
    return (
      <section className="panel p-4" style={{ borderRadius: '0.65rem' }}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-heading">Chapter trend</h3>
          <span className="text-xs" style={{ color: 'var(--text-dim)' }}>Latest saved scores by chapter</span>
        </div>
        <div className="mt-3 text-sm" style={{ color: 'var(--text-dim)' }}>No chapter trend points yet.</div>
      </section>
    );
  }
  return (
    <section className="panel p-4" style={{ borderRadius: '0.65rem' }}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-bold text-heading">Chapter trend</h3>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{points.length} points</span>
      </div>
      <div className="flex items-end gap-2" style={{ minHeight: '5.5rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
        {points.slice(0, 40).map((point) => (
          <div key={point.scoringRunId} title={`${point.platformProfile} ${point.overallScore}`} style={{ width: '1.65rem', height: '5rem', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', flex: '0 0 1.65rem' }}>
            <div style={{ height: `${Math.max(8, Math.min(88, point.overallScore))}%`, minHeight: '0.5rem', borderRadius: '0.35rem 0.35rem 0.15rem 0.15rem', background: scoreColor(point.overallScore) }} />
            <div className="mt-1 text-center" style={{ color: 'var(--text-dim)', fontSize: '0.62rem', fontVariantNumeric: 'tabular-nums' }}>{point.chapterNo ?? '-'}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DimensionRow({ dimension, formLoading, onCreateRevision }: { dimension: ScoringDimensionScore; formLoading: boolean; onCreateRevision: () => void | Promise<void> }) {
  const width = Math.max(0, Math.min(100, dimension.score));
  return (
    <div className="list-card" style={{ padding: '0.75rem', borderRadius: '0.55rem' }}>
      <div className="flex items-start justify-between gap-3">
        <div style={{ minWidth: 0 }}>
          <strong className="text-sm text-heading">{dimension.label || dimension.key}</strong>
          <div className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>{dimension.key} · weight {dimension.weight} · {dimension.confidence}</div>
        </div>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <button className="btn-secondary" type="button" disabled={formLoading} onClick={() => void onCreateRevision()} style={{ fontSize: '0.66rem', padding: '0.3rem 0.55rem' }}>
            Rewrite dimension
          </button>
          <strong className="text-sm" style={{ color: scoreColor(dimension.score), fontVariantNumeric: 'tabular-nums' }}>{dimension.score.toFixed(1)}</strong>
        </div>
      </div>
      <div className="mt-2" style={{ height: '0.45rem', borderRadius: 999, background: 'var(--bg-hover-subtle)', overflow: 'hidden' }}>
        <div style={{ width: `${width}%`, height: '100%', borderRadius: 999, background: scoreColor(dimension.score) }} />
      </div>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
        <ScoreText label="evidence" value={dimension.evidence} />
        <ScoreText label="reason" value={dimension.reason} />
        <ScoreText label="suggestion" value={dimension.suggestion} />
      </div>
    </div>
  );
}

function IssueCard({
  issue,
  index,
  checked,
  formLoading,
  onToggle,
  onCreateRevision,
}: {
  issue: ScoringIssue;
  index: number;
  checked: boolean;
  formLoading: boolean;
  onToggle: () => void;
  onCreateRevision: () => void | Promise<void>;
}) {
  return (
    <div className="list-card" style={{ padding: '0.75rem', borderRadius: '0.55rem' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex flex-wrap items-center gap-2" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={checked} onChange={onToggle} />
          <span className="badge" style={issueStyle(issue.severity)}>{issue.severity}</span>
          <strong className="text-sm" style={{ color: 'var(--text-main)' }}>{issue.dimensionKey}</strong>
          <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{issue.path}</span>
        </label>
        <button className="btn-secondary" type="button" disabled={formLoading} onClick={() => void onCreateRevision()} style={{ fontSize: '0.66rem', padding: '0.3rem 0.55rem' }}>
          Rewrite issue #{index + 1}
        </button>
      </div>
      <ScoreText label="evidence" value={issue.evidence} />
      <ScoreText label="reason" value={issue.reason} />
      <ScoreText label="suggestion" value={issue.suggestion} />
    </div>
  );
}

function RevisionBoundary({ result }: { result: ScoringRevisionResult }) {
  return (
    <div className="mt-3 text-xs" style={{ color: 'var(--text-dim)', lineHeight: 1.6 }}>
      Agent preview entry created. Direct asset persist: {result.approvalBoundary.directlyPersistsAssets ? 'yes' : 'no'}.
      Approval flow required: {result.approvalBoundary.requiresAgentPreviewValidationApprovalPersistFlow ? 'yes' : 'no'}.
    </div>
  );
}

function ScoreText({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.55, minWidth: 0, overflowWrap: 'anywhere' }}>
      <span style={{ color: 'var(--text-dim)', fontWeight: 700 }}>{label}: </span>{value || '-'}
    </div>
  );
}

function JsonFallback({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="list-card" style={{ padding: '0.75rem', borderRadius: '0.55rem' }} open>
      <summary className="text-sm font-bold" style={{ color: '#fbbf24', cursor: 'pointer' }}>{label}</summary>
      <pre className="mt-2 text-xs" style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{compactJson(value)}</pre>
    </details>
  );
}

function Notice({ tone, children }: { tone: 'error' | 'warn'; children: React.ReactNode }) {
  return (
    <div className="mb-3 text-sm" style={{
      color: tone === 'error' ? 'var(--status-err)' : '#fbbf24',
      background: tone === 'error' ? 'var(--status-err-bg)' : 'rgba(245,158,11,0.08)',
      borderRadius: '0.55rem',
      padding: '0.75rem 1rem',
      border: `1px solid ${tone === 'error' ? 'rgba(244,63,94,0.25)' : 'rgba(245,158,11,0.24)'}`,
    }}>
      {children}
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value?: string | null }) {
  return (
    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}: </span>{value || '-'}
    </span>
  );
}

function TinyMeta({ children }: { children: React.ReactNode }) {
  return <span className="badge" style={{ fontSize: '0.62rem', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{children}</span>;
}

function toggleSetValue(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function sectionContainsAsset(section: AssetTreeSection, asset: ScoringAssetOption | null) {
  if (!asset) return false;
  if (section.kind === 'project' || section.kind === 'other') {
    return section.assets.some((item) => assetKey(item) === assetKey(asset));
  }
  return section.volumeAssets.some((item) => assetKey(item) === assetKey(asset))
    || section.looseAssets.some((item) => assetKey(item) === assetKey(asset))
    || section.chapters.some((chapter) => chapterContainsAsset(chapter, asset));
}

function chapterContainsAsset(chapter: ChapterAssetGroup, asset: ScoringAssetOption | null) {
  if (!asset) return false;
  return chapter.assets.some((item) => assetKey(item) === assetKey(asset));
}

function buildAssetTreeSections(assets: ScoringAssetOption[]): AssetTreeSection[] {
  const projectAssets: ScoringAssetOption[] = [];
  const volumeSections = new Map<string, MutableVolumeSection>();
  const otherAssets: ScoringAssetOption[] = [];

  for (const asset of [...assets].sort(compareAssets)) {
    if (asset.targetType === 'project_outline') {
      projectAssets.push(asset);
      continue;
    }

    if (asset.targetType === 'volume_outline' || asset.volumeNo != null || asset.chapterNo != null) {
      const volumeKey = `volume:${asset.volumeNo ?? asset.targetId ?? 'unknown'}`;
      const volume = ensureVolumeSection(volumeSections, volumeKey, asset.volumeNo ?? null);

      if (asset.targetType === 'volume_outline') {
        volume.volumeAssets.push(asset);
        continue;
      }

      if (asset.chapterNo != null || CHAPTER_TARGETS.has(asset.targetType)) {
        const chapterKey = `chapter:${asset.volumeNo ?? 'unknown'}:${asset.chapterNo ?? 'unknown'}:${asset.targetId ?? 'unknown'}`;
        const chapter = ensureChapterGroup(volume, chapterKey, asset);
        chapter.assets.push(asset);
        chapter.assets.sort(compareAssets);
        continue;
      }

      volume.looseAssets.push(asset);
      continue;
    }

    otherAssets.push(asset);
  }

  const sections: AssetTreeSection[] = [];
  if (projectAssets.length) {
    sections.push({ kind: 'project', key: 'project-assets', assets: projectAssets.sort(compareAssets), count: projectAssets.length });
  }

  [...volumeSections.values()]
    .sort((left, right) => compareNullableNumbers(left.volumeNo, right.volumeNo) || left.key.localeCompare(right.key))
    .forEach((volume) => {
      const chapters = [...volume.chapters.values()]
        .map((chapter) => ({ ...chapter, assets: [...chapter.assets].sort(compareAssets) }))
        .sort((left, right) => compareNullableNumbers(left.chapterNo, right.chapterNo) || left.key.localeCompare(right.key));
      const volumeAssets = [...volume.volumeAssets].sort(compareAssets);
      const looseAssets = [...volume.looseAssets].sort(compareAssets);
      sections.push({
        kind: 'volume',
        key: volume.key,
        volumeNo: volume.volumeNo,
        volumeAssets,
        chapters,
        looseAssets,
        count: volumeAssets.length + looseAssets.length + chapters.reduce((sum, chapter) => sum + chapter.assets.length, 0),
      });
    });

  if (otherAssets.length) {
    sections.push({ kind: 'other', key: 'other-assets', assets: otherAssets.sort(compareAssets), count: otherAssets.length });
  }

  return sections;
}

function ensureVolumeSection(sections: Map<string, MutableVolumeSection>, key: string, volumeNo: number | null) {
  const existing = sections.get(key);
  if (existing) return existing;
  const created: MutableVolumeSection = {
    key,
    volumeNo,
    volumeAssets: [],
    chapters: new Map<string, ChapterAssetGroup>(),
    looseAssets: [],
  };
  sections.set(key, created);
  return created;
}

function ensureChapterGroup(volume: MutableVolumeSection, key: string, asset: ScoringAssetOption) {
  const existing = volume.chapters.get(key);
  const title = chapterTitleFromAsset(asset);
  if (existing) {
    if ((!existing.title || chapterTitlePriority(asset.targetType) < chapterTitlePriority(existing.assets[0]?.targetType)) && title) {
      existing.title = title;
    }
    return existing;
  }
  const created: ChapterAssetGroup = {
    key,
    volumeNo: asset.volumeNo ?? volume.volumeNo,
    chapterNo: asset.chapterNo ?? null,
    title,
    assets: [],
  };
  volume.chapters.set(key, created);
  return created;
}

function chapterTitleFromAsset(asset: ScoringAssetOption) {
  if (asset.targetType === 'chapter_draft' && asset.draftVersion) {
    const suffix = ` draft v${asset.draftVersion}`;
    if (asset.title.toLowerCase().endsWith(suffix)) {
      return asset.title.slice(0, -suffix.length).trim() || asset.title;
    }
  }
  return asset.title;
}

function nestedAssetLabel(asset: ScoringAssetOption) {
  if (asset.targetType === 'chapter_draft') return asset.draftVersion ? `正文版本 v${asset.draftVersion}` : '章节正文';
  return TARGET_LABELS[asset.targetType];
}

function compareAssets(left: ScoringAssetOption, right: ScoringAssetOption) {
  const typeDiff = TARGET_ORDER.indexOf(left.targetType) - TARGET_ORDER.indexOf(right.targetType);
  if (typeDiff) return typeDiff;
  const volumeDiff = compareNullableNumbers(left.volumeNo ?? null, right.volumeNo ?? null);
  if (volumeDiff) return volumeDiff;
  const chapterDiff = compareNullableNumbers(left.chapterNo ?? null, right.chapterNo ?? null);
  if (chapterDiff) return chapterDiff;
  if (left.targetType === 'chapter_draft' && right.targetType === 'chapter_draft') {
    const draftDiff = (right.draftVersion ?? 0) - (left.draftVersion ?? 0);
    if (draftDiff) return draftDiff;
  }
  return assetKey(left).localeCompare(assetKey(right));
}

function compareNullableNumbers(left: number | null, right: number | null) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left - right;
}

function chapterTitlePriority(targetType?: ScoringTargetType) {
  if (targetType === 'chapter_outline') return 0;
  if (targetType === 'chapter_craft_brief') return 1;
  if (targetType === 'chapter_draft') return 2;
  return 3;
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => Boolean(item && typeof item === 'object')) : [];
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function isRunForAsset(run: ScoringRun, asset: ScoringAssetOption) {
  if (run.targetType !== asset.targetType) return false;
  if ((run.targetId ?? null) !== (asset.targetId ?? null)) return false;
  if (asset.draftId && (run.draftId ?? null) !== asset.draftId) return false;
  return true;
}

function assetKey(asset: ScoringAssetOption) {
  return `${asset.targetType}:${asset.targetId ?? ''}:${asset.draftId ?? ''}:${asset.draftVersion ?? ''}`;
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function scoreColor(value: number) {
  if (value >= 80) return '#34d399';
  if (value >= 60) return '#fbbf24';
  return '#fb7185';
}

function verdictStyle(verdict: string) {
  if (verdict === 'pass') return { borderColor: 'rgba(16,185,129,0.4)', background: 'rgba(16,185,129,0.1)', color: '#34d399' };
  if (verdict === 'warn') return { borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.1)', color: '#fbbf24' };
  if (verdict === 'fail') return { borderColor: 'rgba(244,63,94,0.4)', background: 'var(--status-err-bg)', color: '#fb7185' };
  return { borderColor: 'var(--border-dim)', background: 'var(--bg-overlay)', color: 'var(--text-muted)' };
}

function issueStyle(severity: string) {
  if (severity === 'blocking') return verdictStyle('fail');
  if (severity === 'warning') return verdictStyle('warn');
  return verdictStyle('pass');
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
