'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectSummary } from '../types/dashboard';
import {
  PlatformProfileKey,
  ScoringAssetOption,
  ScoringDimensionScore,
  ScoringIssue,
  ScoringRun,
  ScoringTargetType,
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

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function ScoringCenterPanel({ selectedProject, selectedProjectId }: Props) {
  const { profiles, assets, runs, loading, formLoading, error, setError, loadProfiles, loadAssets, loadRuns, createRun } = useScoringActions();
  const [targetFilter, setTargetFilter] = useState<ScoringTargetType | 'all'>('all');
  const [selectedAssetKey, setSelectedAssetKey] = useState('');
  const [profileKey, setProfileKey] = useState<PlatformProfileKey>('generic_longform');
  const [selectedRunId, setSelectedRunId] = useState('');

  useEffect(() => {
    setSelectedAssetKey('');
    setSelectedRunId('');
    setError('');
    if (!selectedProjectId) return;
    void Promise.all([loadProfiles(), loadAssets(selectedProjectId), loadRuns(selectedProjectId)]);
  }, [loadAssets, loadProfiles, loadRuns, selectedProjectId, setError]);

  const filteredAssets = useMemo(
    () => assets.filter((asset) => targetFilter === 'all' || asset.targetType === targetFilter),
    [assets, targetFilter],
  );
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

  const refreshRunsForAsset = useCallback(async (asset: ScoringAssetOption) => {
    const filters = {
      targetType: asset.targetType,
      targetId: asset.targetId ?? undefined,
      draftId: asset.draftId ?? undefined,
    };
    const latest = await loadRuns(selectedProjectId, filters);
    return latest;
  }, [loadRuns, selectedProjectId]);

  const handleSelectAsset = useCallback(async (asset: ScoringAssetOption) => {
    setSelectedAssetKey(assetKey(asset));
    setSelectedRunId('');
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
    await Promise.all([loadAssets(selectedProjectId), refreshRunsForAsset(selectedAsset)]);
  }, [createRun, loadAssets, profileKey, refreshRunsForAsset, selectedAsset, selectedProjectId]);

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
                  <div className="space-y-2">
                    {filteredAssets.map((asset) => (
                      <button
                        key={assetKey(asset)}
                        type="button"
                        onClick={() => void handleSelectAsset(asset)}
                        className="list-card w-full"
                        style={{
                          padding: '0.8rem',
                          textAlign: 'left',
                          borderRadius: '0.55rem',
                          borderColor: selectedAsset && assetKey(asset) === assetKey(selectedAsset) ? 'rgba(34,197,94,0.45)' : 'var(--border-dim)',
                          background: selectedAsset && assetKey(asset) === assetKey(selectedAsset) ? 'rgba(34,197,94,0.08)' : 'var(--bg-card)',
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{asset.title}</strong>
                          <span className="badge" style={{ fontSize: '0.62rem', flexShrink: 0 }}>{TARGET_LABELS[asset.targetType]}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {asset.volumeNo ? <TinyMeta>Vol.{asset.volumeNo}</TinyMeta> : null}
                          {asset.chapterNo ? <TinyMeta>Ch.{asset.chapterNo}</TinyMeta> : null}
                          {asset.draftVersion ? <TinyMeta>Draft v{asset.draftVersion}</TinyMeta> : null}
                          <TinyMeta>{asset.source}</TinyMeta>
                        </div>
                        {asset.latestRun ? (
                          <div className="mt-2 text-xs" style={{ color: scoreColor(asset.latestRun.overallScore) }}>
                            最新评分 {asset.latestRun.overallScore.toFixed(1)} · {asset.latestRun.verdict}
                          </div>
                        ) : asset.unavailableReason ? (
                          <div className="mt-2 text-xs" style={{ color: '#fbbf24' }}>{asset.unavailableReason}</div>
                        ) : null}
                      </button>
                    ))}
                  </div>
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
                  <ReportView run={selectedRun} profileName={profiles.find((profile) => profile.key === selectedRun.platformProfile)?.name ?? String(selectedRun.platformProfile)} />
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </article>
  );
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

function ReportView({ run, profileName }: { run: ScoringRun; profileName: string }) {
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
          </div>
        </div>
      </section>

      <section className="panel p-4" style={{ borderRadius: '0.65rem' }}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-heading">维度评分</h3>
          <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{dimensions.length} dimensions</span>
        </div>
        {dimensions.length ? (
          <div className="space-y-2">
            {dimensions.map((dimension) => <DimensionRow key={dimension.key} dimension={dimension} />)}
          </div>
        ) : (
          <JsonFallback label="dimensions JSON fallback" value={run.dimensions} />
        )}
      </section>

      <section className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(16rem, 0.7fr)' }}>
        <div className="panel p-4" style={{ borderRadius: '0.65rem' }}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-heading">Issues</h3>
            <span className="text-xs" style={{ color: issues.length ? '#fbbf24' : 'var(--text-dim)' }}>{issues.length}</span>
          </div>
          {issues.length ? (
            <div className="space-y-2">
              {issues.map((issue, index) => <IssueCard key={`${issue.dimensionKey}-${index}`} issue={issue} />)}
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
                <li key={`${priority}-${index}`} className="text-sm" style={{ color: 'var(--text-muted)', lineHeight: 1.6 }}>{priority}</li>
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

function DimensionRow({ dimension }: { dimension: ScoringDimensionScore }) {
  const width = Math.max(0, Math.min(100, dimension.score));
  return (
    <div className="list-card" style={{ padding: '0.75rem', borderRadius: '0.55rem' }}>
      <div className="flex items-start justify-between gap-3">
        <div style={{ minWidth: 0 }}>
          <strong className="text-sm text-heading">{dimension.label || dimension.key}</strong>
          <div className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>{dimension.key} · weight {dimension.weight} · {dimension.confidence}</div>
        </div>
        <strong className="text-sm" style={{ color: scoreColor(dimension.score), fontVariantNumeric: 'tabular-nums' }}>{dimension.score.toFixed(1)}</strong>
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

function IssueCard({ issue }: { issue: ScoringIssue }) {
  return (
    <div className="list-card" style={{ padding: '0.75rem', borderRadius: '0.55rem' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge" style={issueStyle(issue.severity)}>{issue.severity}</span>
        <strong className="text-sm" style={{ color: 'var(--text-main)' }}>{issue.dimensionKey}</strong>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{issue.path}</span>
      </div>
      <ScoreText label="evidence" value={issue.evidence} />
      <ScoreText label="reason" value={issue.reason} />
      <ScoreText label="suggestion" value={issue.suggestion} />
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
