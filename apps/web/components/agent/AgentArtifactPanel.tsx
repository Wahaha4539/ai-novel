'use client';

import { useMemo, useState } from 'react';
import { AgentRun } from '../../hooks/useAgentRun';
import { EmptyText, Metric, asArray, asRecord, numberValue, safeJson, textValue } from './AgentSharedWidgets';

// ────────────────────────────────────────────
// 产物去重与过滤
// ────────────────────────────────────────────

/** 按类型+标题保留最新产物，避免 Plan/Act 或多次 replan 后重复卡片淹没用户 */
function dedupeArtifacts(artifacts: NonNullable<AgentRun['artifacts']>) {
  const seen = new Set<string>();
  return [...artifacts].reverse().filter((artifact) => {
    const key = `${artifact.artifactType ?? ''}:${artifact.title ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
}

function filterArtifacts(artifacts: NonNullable<AgentRun['artifacts']>, query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return artifacts;
  return artifacts.filter((artifact) => `${artifact.artifactType ?? ''}\n${artifact.title ?? ''}\n${safeJson(artifact.content)}`.toLowerCase().includes(keyword));
}

// ────────────────────────────────────────────
// ArtifactPanel 主体
// ────────────────────────────────────────────

interface AgentArtifactPanelProps {
  run: AgentRun | null;
  query: string;
  onQueryChange: (value: string) => void;
  onRequestWorldbuildingPersistSelection?: (titles: string[]) => void | Promise<void>;
  actionDisabled?: boolean;
}

/** 产物预览面板：搜索、去重、按类型渲染业务化摘要 */
export function AgentArtifactPanel({ run, query, onQueryChange, onRequestWorldbuildingPersistSelection, actionDisabled }: AgentArtifactPanelProps) {
  const artifacts = dedupeArtifacts(run?.artifacts ?? []);
  const filteredArtifacts = filterArtifacts(artifacts, query);

  return (
    <section className="agent-panel-section">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>产物预览</h2>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索产物/JSON…"
          className="agent-artifact-search"
        />
      </div>
      {filteredArtifacts.length ? (
        <div className="space-y-3">
          {filteredArtifacts.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifactType={artifact.artifactType}
              title={artifact.title}
              content={artifact.content}
              onRequestWorldbuildingPersistSelection={onRequestWorldbuildingPersistSelection}
              actionDisabled={actionDisabled}
            />
          ))}
        </div>
      ) : (
        <EmptyText text={artifacts.length ? '没有匹配的产物。' : '计划产物和预览会在这里展开。'} />
      )}
    </section>
  );
}

// ────────────────────────────────────────────
// ArtifactCard + TypedArtifactPreview
// ────────────────────────────────────────────

/** 产物类型的 emoji 映射，提升视觉扫描效率 */
function typeEmoji(type?: string): string {
  if (!type) return '📦';
  if (type.includes('outline')) return '📑';
  if (type.includes('plot')) return '🧭';
  if (type.includes('chapter')) return '📝';
  if (type.includes('character')) return '👤';
  if (type.includes('validation') || type.includes('quality')) return '🔍';
  if (type.includes('fact')) return '🧩';
  if (type.includes('memory')) return '🧠';
  if (type.includes('worldbuilding')) return '🌐';
  if (type.includes('profile') || type.includes('project')) return '📋';
  if (type.includes('lorebook')) return '📚';
  if (type.includes('repair')) return '🔧';
  if (type.includes('polish')) return '✨';
  return '📦';
}

function ArtifactCard({
  artifactType,
  title,
  content,
  onRequestWorldbuildingPersistSelection,
  actionDisabled,
}: {
  artifactType?: string;
  title?: string;
  content?: unknown;
  onRequestWorldbuildingPersistSelection?: (titles: string[]) => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  return (
    <details className="agent-artifact-card">
      <summary className="agent-artifact-card__summary">
        <span className="agent-artifact-card__icon" aria-hidden="true">{typeEmoji(artifactType)}</span>
        <span className="agent-artifact-card__title">{title ?? artifactType ?? 'Artifact'}</span>
        {artifactType && <span className="agent-artifact-card__type">{artifactType}</span>}
        <span className="agent-artifact-card__arrow" aria-hidden="true">▸</span>
      </summary>
      <div className="agent-artifact-card__body">
        <TypedArtifactPreview
          artifactType={artifactType}
          content={content}
          onRequestWorldbuildingPersistSelection={onRequestWorldbuildingPersistSelection}
          actionDisabled={actionDisabled}
        />
        <details className="agent-artifact-card__json-toggle">
          <summary className="cursor-pointer text-xs" style={{ color: 'var(--agent-text-label)' }}>📄 原始 JSON</summary>
          <pre className="agent-artifact-card__json">{safeJson(content)}</pre>
        </details>
      </div>
    </details>
  );
}

/** 按 AgentArtifact 类型提供业务化摘要，避免用户只能阅读大段 JSON */
function TypedArtifactPreview({
  artifactType,
  content,
  onRequestWorldbuildingPersistSelection,
  actionDisabled,
}: {
  artifactType?: string;
  content?: unknown;
  onRequestWorldbuildingPersistSelection?: (titles: string[]) => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  if (artifactType === 'outline_preview') return <OutlinePreviewSummary content={content} />;
  if (artifactType === 'outline_validation_report' || artifactType === 'import_validation_report' || artifactType === 'fact_validation_report' || artifactType === 'worldbuilding_validation_report') return <ValidationSummary content={content} />;
  if (artifactType === 'project_profile_preview') return <ProjectProfileSummary content={content} />;
  if (artifactType === 'characters_preview') return <ArraySummary content={content} label="角色" primaryKey="name" secondaryKey="roleType" />;
  if (artifactType === 'lorebook_preview') return <ArraySummary content={content} label="设定" primaryKey="title" secondaryKey="entryType" />;
  if (artifactType === 'worldbuilding_preview') return <WorldbuildingPreviewSummary content={content} onRequestPersistSelection={onRequestWorldbuildingPersistSelection} actionDisabled={actionDisabled} />;
  if (artifactType === 'worldbuilding_persist_result') return <WorldbuildingPersistSummary content={content} />;
  if (artifactType === 'character_consistency_report') return <CharacterConsistencySummary content={content} />;
  if (artifactType === 'plot_consistency_report') return <PlotConsistencySummary content={content} />;
  if (artifactType === 'task_context_preview') return <TaskContextSummary content={content} />;
  if (artifactType === 'outline_persist_result' || artifactType === 'import_persist_result') return <PersistSummary content={content} />;
  if (artifactType === 'chapter_draft_result') return <ChapterDraftSummary content={content} />;
  if (artifactType === 'chapter_generation_quality_report') return <GenerationQualitySummary content={content} />;
  if (artifactType === 'chapter_polish_result') return <ChapterPolishSummary content={content} />;
  if (artifactType === 'chapter_context_preview') return <ChapterContextSummary content={content} />;
  if (artifactType === 'fact_extraction_report') return <FactExtractionSummary content={content} />;
  if (artifactType === 'auto_repair_report') return <AutoRepairSummary content={content} />;
  if (artifactType === 'memory_rebuild_report') return <PersistSummary content={content} />;
  if (artifactType === 'memory_review_report') return <MemoryReviewSummary content={content} />;
  return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无专用视图，已保留原始 JSON。</div>;
}

// ── 以下为各类型产物摘要组件 ──

function OutlinePreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const volume = asRecord(data?.volume);
  const chapters = asArray(data?.chapters);
  const totalExpectedWordCount = chapters.reduce<number>((sum, item) => sum + numberValue(asRecord(item)?.expectedWordCount), 0);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="卷" value={textValue(volume?.title, '未命名卷')} />
        <Metric label="章节数" value={chapters.length} />
        <Metric label="总目标字数" value={totalExpectedWordCount} />
      </div>
      <div className="space-y-2">
        {chapters.slice(0, 5).map((item, index) => {
          const chapter = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>{numberValue(chapter?.chapterNo, index + 1)}. {textValue(chapter?.title, '未命名章节')}</b> — {textValue(chapter?.objective ?? chapter?.outline, '暂无目标')}</div>;
        })}
      </div>
    </div>
  );
}

function ValidationSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const issues = asArray(data?.issues);
  const hasError = issues.some((item) => asRecord(item)?.severity === 'error');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="状态" value={data?.valid === false ? '需复核' : '可继续'} tone={hasError ? 'danger' : issues.length ? 'warn' : 'ok'} />
        <Metric label="问题数" value={numberValue(data?.issueCount, issues.length)} />
        <Metric label="来源风险" value={asArray(data?.sourceRisks).length} />
      </div>
      <WritePreviewSummary content={data?.writePreview} />
      <WorldbuildingValidationComparison content={data} />
      <div className="space-y-2">
        {issues.slice(0, 5).map((item, index) => {
          const issue = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: issue?.severity === 'error' ? '#fb7185' : '#fbbf24' }}>[{textValue(issue?.severity)}] {textValue(issue?.message)}</div>;
        })}
        {!issues.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>未发现阻断性问题。</div>}
      </div>
    </div>
  );
}

/** 世界观校验视图补充条目级对比和 locked facts 说明，避免用户只看到 create/skip 的技术状态。 */
function WorldbuildingValidationComparison({ content }: { content: unknown }) {
  const data = asRecord(content);
  const writePreview = asRecord(data?.writePreview);
  const entries = asArray(writePreview?.entries);
  const relatedLockedFacts = asArray(data?.relatedLockedFacts);
  if (!entries.length && !relatedLockedFacts.length) return null;

  return (
    <div className="space-y-2" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="将新增" value={entries.filter((item) => asRecord(item)?.action === 'create').length} tone="ok" />
        <Metric label="将跳过" value={entries.filter((item) => asRecord(item)?.action === 'skip_duplicate').length} tone={entries.some((item) => asRecord(item)?.action === 'skip_duplicate') ? 'warn' : undefined} />
        <Metric label="相关 locked facts" value={relatedLockedFacts.length} tone={relatedLockedFacts.length ? 'warn' : 'ok'} />
      </div>
      <div className="space-y-1">
        {entries.slice(0, 8).map((item, index) => {
          const entry = asRecord(item);
          const action = textValue(entry?.action, 'unknown');
          const isSkip = action === 'skip_duplicate';
          return <div key={index} className="text-xs leading-5" style={{ color: isSkip ? '#fbbf24' : '#86efac' }}>{isSkip ? '跳过' : '新增'}：{textValue(entry?.title, '未命名设定')} · {textValue(entry?.entryType, 'setting')}{isSkip ? ` · 原状态 ${textValue(entry?.existingStatus, 'existing')}` : ''}</div>;
        })}
        {relatedLockedFacts.slice(0, 4).map((item, index) => {
          const fact = asRecord(item);
          return <div key={`locked-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>locked fact：{textValue(fact?.title, '未命名')} — {textValue(fact?.excerpt, '暂无摘要')}</div>;
        })}
      </div>
    </div>
  );
}

/** 展示写入前 diff 摘要，帮助用户在审批前理解会新增、更新或跳过哪些资产 */
function WritePreviewSummary({ content }: { content: unknown }) {
  const preview = asRecord(content);
  const summary = asRecord(preview?.summary);
  if (!preview || !summary) return null;
  const chapterCreate = numberValue(summary.chapterCreateCount, numberValue(summary.createCount));
  const chapterUpdate = numberValue(summary.chapterUpdateCount, numberValue(summary.updateCount));
  const chapterSkip = numberValue(summary.chapterSkipCount, numberValue(summary.skipCount, numberValue(summary.skipDuplicateCount)));
  const chapters = asArray(preview.chapters);
  const entries = asArray(preview.entries);
  const volume = asRecord(preview.volume);
  return (
    <div className="space-y-2" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="将创建" value={chapterCreate + numberValue(summary.characterCreateCount) + numberValue(summary.lorebookCreateCount) + numberValue(summary.volumeCreateCount)} tone="ok" />
        <Metric label="将更新" value={chapterUpdate + numberValue(summary.volumeUpdateCount) + (volume?.action === 'update' ? 1 : 0)} tone={chapterUpdate ? 'warn' : undefined} />
        <Metric label="将跳过" value={chapterSkip + numberValue(summary.characterSkipCount) + numberValue(summary.lorebookSkipCount)} tone={chapterSkip ? 'warn' : undefined} />
      </div>
      <div className="space-y-1">
        {chapters.slice(0, 4).map((item, index) => {
          const chapter = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: chapter?.action === 'skip_existing_content' ? '#fbbf24' : 'var(--text-muted)' }}>第 {numberValue(chapter?.chapterNo, index + 1)} 章：{textValue(chapter?.title, '未命名')} · {textValue(chapter?.action, 'unknown')}</div>;
        })}
        {entries.slice(0, 6).map((item, index) => {
          const entry = asRecord(item);
          return <div key={`entry-${index}`} className="text-xs leading-5" style={{ color: entry?.action === 'skip_duplicate' ? '#fbbf24' : 'var(--text-muted)' }}>设定：{textValue(entry?.title, '未命名')} · {textValue(entry?.action, 'unknown')}</div>;
        })}
      </div>
    </div>
  );
}

function WorldbuildingPreviewSummary({
  content,
  onRequestPersistSelection,
  actionDisabled,
}: {
  content: unknown;
  onRequestPersistSelection?: (titles: string[]) => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  const data = asRecord(content);
  const entries = asArray(data?.entries);
  const risks = asArray(data?.risks);
  const writePlan = asRecord(data?.writePlan);
  const selectableEntries = useMemo(() => entries.map((item, index) => {
    const entry = asRecord(item);
    return {
      key: `${textValue(entry?.title, `设定${index + 1}`)}:${index}`,
      title: textValue(entry?.title, `设定${index + 1}`).trim(),
      entryType: textValue(entry?.entryType, 'setting'),
      summary: textValue(entry?.summary ?? entry?.impactAnalysis, '暂无摘要'),
    };
  }).filter((entry) => entry.title.length > 0), [entries]);
  const [selectedTitles, setSelectedTitles] = useState<string[]>(() => selectableEntries.map((entry) => entry.title));
  const [submitting, setSubmitting] = useState(false);
  const selectedTitleSet = new Set(selectedTitles);
  const allSelected = selectableEntries.length > 0 && selectableEntries.every((entry) => selectedTitleSet.has(entry.title));

  /** 勾选状态只传标题，不暴露内部 ID；后端 persist_worldbuilding 会再次校验标题必须来自预览。 */
  const toggleTitle = (title: string) => {
    setSelectedTitles((current) => (current.includes(title) ? current.filter((item) => item !== title) : [...current, title]));
  };

  const handleSubmitSelection = async () => {
    if (!onRequestPersistSelection || !selectedTitles.length) return;
    setSubmitting(true);
    try {
      await onRequestPersistSelection(selectedTitles);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="候选设定" value={entries.length} />
        <Metric label="写入模式" value={textValue(writePlan?.mode, 'preview_only')} />
        <Metric label="写入前审批" value={writePlan?.requiresApprovalBeforePersist === false ? '否' : '是'} tone={writePlan?.requiresApprovalBeforePersist === false ? 'danger' : 'warn'} />
      </div>
      <div className="space-y-2">
        {selectableEntries.slice(0, 8).map((entry) => (
          <label key={entry.key} className="flex cursor-pointer items-start gap-2 rounded-lg border px-2 py-2 text-xs leading-5" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)', background: selectedTitleSet.has(entry.title) ? 'rgba(20,184,166,0.10)' : 'rgba(15,23,42,0.24)' }}>
            <input
              type="checkbox"
              checked={selectedTitleSet.has(entry.title)}
              onChange={() => toggleTitle(entry.title)}
              className="mt-1"
              aria-label={`选择写入 ${entry.title}`}
            />
            <span>
              <b style={{ color: 'var(--text-main)' }}>{entry.title}</b> · {entry.entryType} — {entry.summary}
            </span>
          </label>
        ))}
        {!entries.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无世界观候选条目。</div>}
      </div>
      {selectableEntries.length > 0 && (
        <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: 'rgba(20,184,166,0.28)', background: 'rgba(20,184,166,0.08)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
              已选择 {selectedTitles.length}/{selectableEntries.length} 个条目。点击按钮会把标题作为 <code>selectedTitles</code> 写回重新规划，仍需再次审批后才会持久化。
            </div>
            <div className="flex gap-2">
              <button type="button" className="agent-new-session-btn" onClick={() => setSelectedTitles(allSelected ? [] : selectableEntries.map((entry) => entry.title))} disabled={actionDisabled || submitting}>
                {allSelected ? '清空选择' : '全选'}
              </button>
              <button type="button" className="agent-new-session-btn" onClick={handleSubmitSelection} disabled={!onRequestPersistSelection || actionDisabled || submitting || selectedTitles.length === 0} title={onRequestPersistSelection ? '基于当前选择重新规划写入步骤' : '当前入口尚未接入选择写入'}>
                {submitting ? '提交中…' : '按选择写入'}
              </button>
            </div>
          </div>
          {!selectedTitles.length && <div className="text-xs" style={{ color: '#fbbf24' }}>请至少选择 1 个条目；如果本次不写入，请不要执行持久化步骤。</div>}
        </div>
      )}
      <div className="space-y-1">{risks.slice(0, 4).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {textValue(item)}</div>)}</div>
    </div>
  );
}

function WorldbuildingPersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const createdEntries = asArray(data?.createdEntries);
  const skippedTitles = asArray(data?.skippedTitles);
  const skippedUnselectedTitles = asArray(data?.skippedUnselectedTitles);
  const perEntryAudit = asArray(data?.perEntryAudit);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="新增设定" value={numberValue(data?.createdCount, createdEntries.length)} tone="ok" />
        <Metric label="跳过同名" value={numberValue(data?.skippedDuplicateCount, skippedTitles.length)} tone={skippedTitles.length ? 'warn' : undefined} />
        <Metric label="未选择跳过" value={numberValue(data?.skippedUnselectedCount, skippedUnselectedTitles.length)} tone={skippedUnselectedTitles.length ? 'warn' : undefined} />
        <Metric label="写入策略" value="只新增不覆盖" tone="ok" />
      </div>
      <div className="space-y-1">
        {createdEntries.slice(0, 5).map((item, index) => {
          const entry = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: '#86efac' }}>＋ {textValue(entry?.title, '未命名设定')} · {textValue(entry?.entryType, 'setting')}</div>;
        })}
        {skippedTitles.slice(0, 5).map((item, index) => <div key={`skip-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>跳过同名：{textValue(item)}</div>)}
        {skippedUnselectedTitles.slice(0, 5).map((item, index) => <div key={`skip-unselected-${index}`} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>未选择跳过：{textValue(item)}</div>)}
      </div>
      <div className="space-y-1" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
        {perEntryAudit.slice(0, 8).map((item, index) => {
          const audit = asRecord(item);
          const action = textValue(audit?.action, 'unknown');
          const color = action === 'created' ? '#86efac' : action === 'skipped_duplicate' ? '#fbbf24' : 'var(--text-muted)';
          return <div key={index} className="text-xs leading-5" style={{ color }}>{textValue(audit?.title, '未命名设定')} · {action} · {textValue(audit?.reason, '暂无原因')}</div>;
        })}
        {!perEntryAudit.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无条目级审计明细。</div>}
      </div>
    </div>
  );
}

function CharacterConsistencySummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const character = asRecord(data?.character);
  const verdict = asRecord(data?.verdict);
  const deviations = asArray(data?.deviations);
  const status = textValue(verdict?.status, 'unknown');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="角色" value={textValue(character?.name ?? character?.id, '未命名角色')} />
        <Metric label="结论" value={status} tone={status === 'likely_break' ? 'danger' : status === 'minor_drift' ? 'warn' : 'ok'} />
        <Metric label="偏差数" value={deviations.length} tone={deviations.length ? 'warn' : 'ok'} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(verdict?.summary, '暂无结论摘要')}</div>
      <LlmEvidenceSummaryNotice content={data?.llmEvidenceSummary} />
      <div className="space-y-1">
        {deviations.slice(0, 5).map((item, index) => {
          const deviation = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: deviation?.severity === 'error' ? '#fb7185' : deviation?.severity === 'warning' ? '#fbbf24' : 'var(--text-muted)' }}>[{textValue(deviation?.dimension, 'general')}] {textValue(deviation?.message, '暂无说明')}</div>;
        })}
      </div>
    </div>
  );
}

function PlotConsistencySummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const scope = asRecord(data?.scope);
  const verdict = asRecord(data?.verdict);
  const evidence = asRecord(data?.evidence);
  const deviations = asArray(data?.deviations);
  const status = textValue(verdict?.status, 'unknown');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="结论" value={status} tone={status === 'likely_conflict' ? 'danger' : status === 'needs_review' ? 'warn' : 'ok'} />
        <Metric label="章节" value={numberValue(scope?.chapterCount)} />
        <Metric label="剧情事件" value={numberValue(scope?.plotEventCount)} />
        <Metric label="关系边" value={numberValue(scope?.relationshipEdgeCount)} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(verdict?.summary, '暂无剧情一致性结论')}</div>
      <LlmEvidenceSummaryNotice content={data?.llmEvidenceSummary} />
      <div className="grid gap-2 md:grid-cols-2">
        <Metric label="大纲证据" value={asArray(evidence?.outlineEvidence).length} />
        <Metric label="事件线证据" value={asArray(evidence?.eventTimeline).length} />
        <Metric label="伏笔证据" value={asArray(evidence?.foreshadowEvidence).length} />
        <Metric label="动机证据" value={asArray(evidence?.motivationEvidence).length} />
      </div>
      {/* 剧情检查报告优先展示偏差维度和建议，帮助用户快速定位是时间线、伏笔还是动机问题。 */}
      <div className="space-y-1">
        {deviations.slice(0, 6).map((item, index) => {
          const deviation = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: deviation?.severity === 'error' ? '#fb7185' : deviation?.severity === 'warning' ? '#fbbf24' : 'var(--text-muted)' }}>[{textValue(deviation?.dimension, 'context')}] {textValue(deviation?.message, '暂无说明')}</div>;
        })}
        {!deviations.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂未发现明显剧情矛盾。</div>}
      </div>
    </div>
  );
}

/**
 * LLM 证据摘要是默认关闭的只读实验元数据，只辅助阅读。
 * 前端必须明确展示 fallback 状态，且不把摘要作为审批、写入或确定性结论依据。
 */
function LlmEvidenceSummaryNotice({ content }: { content: unknown }) {
  const summary = asRecord(content);
  if (!summary || !Object.keys(summary).length) return null;
  const status = textValue(summary.status, 'unknown');
  const fallbackUsed = summary.fallbackUsed === true || status === 'fallback';
  const keyFindings = asArray(summary.keyFindings).map((item) => textValue(item)).filter(Boolean);
  return (
    <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: fallbackUsed ? 'rgba(251,191,36,0.34)' : 'rgba(20,184,166,0.30)', background: fallbackUsed ? 'rgba(251,191,36,0.08)' : 'rgba(20,184,166,0.08)' }}>
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="实验摘要" value={fallbackUsed ? '已降级' : '可用'} tone={fallbackUsed ? 'warn' : 'ok'} />
        <Metric label="状态" value={status} tone={fallbackUsed ? 'warn' : 'ok'} />
        <Metric label="模型" value={textValue(summary.model, fallbackUsed ? '未调用' : '未记录')} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
        {fallbackUsed ? `LLM 摘要降级：${textValue(summary.error, '未启用或不可用')}` : textValue(summary.summary, '暂无实验摘要内容')}
      </div>
      {!fallbackUsed && keyFindings.length > 0 && (
        <div className="space-y-1">
          {keyFindings.slice(0, 4).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>实验发现：{item}</div>)}
        </div>
      )}
      <div className="text-xs" style={{ color: 'var(--text-dim)' }}>仅作辅助阅读；审批、写入和诊断结论仍以确定性报告为准。</div>
    </div>
  );
}

function TaskContextSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const diagnostics = asRecord(data?.diagnostics);
  const chapters = asArray(data?.chapters);
  const characters = asArray(data?.characters);
  const worldFacts = asArray(data?.worldFacts);
  const memoryChunks = asArray(data?.memoryChunks);
  const plotEvents = asArray(data?.plotEvents);
  const relationshipGraph = asArray(data?.relationshipGraph);
  const constraints = asArray(data?.constraints);
  const missingContext = asArray(diagnostics?.missingContext);
  const dimensions = asArray(diagnostics?.retrievalDimensions).map((item) => textValue(item)).filter(Boolean);
  const fullDraftIncluded = diagnostics?.fullDraftIncluded === true;
  const chapterRange = textValue(diagnostics?.chapterRange, '');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="章节" value={chapters.length} />
        <Metric label="角色" value={characters.length} />
        <Metric label="世界事实" value={worldFacts.length} />
        <Metric label="记忆片段" value={memoryChunks.length} />
        <Metric label="剧情事件" value={plotEvents.length} tone={plotEvents.length ? 'ok' : undefined} />
        <Metric label="关系边" value={relationshipGraph.length} tone={relationshipGraph.length ? 'ok' : undefined} />
        <Metric label="完整草稿" value={fullDraftIncluded ? '已召回' : '未召回'} tone={fullDraftIncluded ? 'warn' : 'ok'} />
        <Metric label="缺失上下文" value={missingContext.length} tone={missingContext.length ? 'warn' : 'ok'} />
      </div>
      {/* 将 collect_task_context 的检索维度显式暴露给用户/调试者，便于判断是否真的使用了剧情事件、关系图或完整草稿等 Warm/Cold Context。 */}
      <div className="flex flex-wrap gap-2">
        {dimensions.map((dimension, index) => <span key={`${dimension}-${index}`} className="px-2 py-1 text-xs" style={{ borderRadius: '999px', border: '1px solid rgba(20,184,166,0.28)', color: '#5eead4', background: 'rgba(20,184,166,0.08)' }}>{dimension}</span>)}
        {!dimensions.length && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无检索维度诊断。</span>}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {chapterRange && <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>章节范围：{chapterRange}</div>}
        {missingContext.slice(0, 4).map((item, index) => <div key={`missing-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>缺失：{textValue(item)}</div>)}
        {constraints.slice(0, 4).map((item, index) => <div key={`constraint-${index}`} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>约束：{textValue(item)}</div>)}
      </div>
      <RelationshipGraphSummary graph={relationshipGraph} />
    </div>
  );
}

/** 将关系图边转换成人类可读证据列表，突出关系类型、强度、来源和冲突边。 */
function RelationshipGraphSummary({ graph }: { graph: unknown[] }) {
  if (!graph.length) return <div className="rounded-xl border p-3 text-xs" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)' }}>暂无关系图证据；当前上下文没有召回可形成关系边的剧情事件或角色状态。</div>;

  return (
    <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.20)' }}>
      <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>关系图证据</div>
      {graph.slice(0, 8).map((item, index) => {
        const edge = asRecord(item);
        const target = textValue(edge?.target, '状态证据');
        const relationType = textValue(edge?.relationType, 'unknown');
        const weight = numberValue(edge?.weight);
        const sources = asArray(edge?.evidenceSources).map((source) => asRecord(source)).map((source) => `${textValue(source?.sourceType, 'source')}${source?.chapterNo ? `@第${numberValue(source.chapterNo)}章` : ''}`).join('、');
        const timeRange = asRecord(edge?.timeRange);
        const timeLabel = timeRange?.fromChapterNo ? `第 ${numberValue(timeRange.fromChapterNo)} 章` : '未知时间';
        const conflict = edge?.conflict === true;
        return (
          <div key={index} className="text-xs leading-5" style={{ color: conflict ? '#fbbf24' : 'var(--text-muted)' }}>
            <b style={{ color: 'var(--text-main)' }}>{textValue(edge?.source, '未知角色')} → {target}</b> · {relationType} · 强度 {weight.toFixed(2)} · {timeLabel} · 来源 {sources || textValue(edge?.sourceType, 'unknown')}
            <div style={{ color: 'var(--text-dim)' }}>{textValue(edge?.evidence, '暂无证据摘录')}</div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectProfileSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="space-y-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}><Metric label="标题" value={textValue(data?.title, '未命名项目')} /><div>{textValue(data?.logline ?? data?.synopsis ?? data?.outline, '暂无简介')}</div></div>;
}

function ArraySummary({ content, label, primaryKey, secondaryKey }: { content: unknown; label: string; primaryKey: string; secondaryKey: string }) {
  const items = asArray(content);
  return (
    <div className="space-y-3">
      <Metric label={`${label}数量`} value={items.length} />
      <div className="flex flex-wrap gap-2">
        {items.slice(0, 12).map((item, index) => {
          const record = asRecord(item);
          return <span key={index} className="px-2 py-1 text-xs" style={{ borderRadius: '999px', border: '1px solid var(--border-dim)', color: 'var(--text-muted)' }}>{textValue(record?.[primaryKey], `${label}${index + 1}`)}{record?.[secondaryKey] ? ` · ${textValue(record[secondaryKey])}` : ''}</span>;
        })}
      </div>
    </div>
  );
}

function PersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content) ?? {};
  const entries = Object.entries(data).filter(([, value]) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean').slice(0, 8);
  return <div className="grid gap-2 md:grid-cols-3">{entries.length ? entries.map(([key, value]) => <Metric key={key} label={key} value={String(value)} />) : <Metric label="结果" value="已完成" tone="ok" />}</div>;
}

function ChapterDraftSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="grid gap-2 md:grid-cols-3"><Metric label="Draft ID" value={textValue(data?.draftId)} /><Metric label="章节" value={textValue(data?.chapterId)} /><Metric label="字数" value={numberValue(data?.actualWordCount)} /></div>;
}

function GenerationQualitySummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const preflight = asRecord(data?.preflight);
  const qualityGate = asRecord(data?.qualityGate);
  const retrieval = asRecord(data?.retrievalDiagnostics);
  const warnings = [...asArray(preflight?.warnings), ...asArray(qualityGate?.warnings), ...asArray(retrieval?.warnings)];
  const blockers = [...asArray(preflight?.blockers), ...asArray(qualityGate?.blockers)];
  const blocked = preflight?.valid === false || qualityGate?.blocked === true || retrieval?.qualityStatus === 'blocked';
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="Preflight" value={preflight?.valid === false ? '未通过' : '通过'} tone={preflight?.valid === false ? 'danger' : warnings.length ? 'warn' : 'ok'} />
        <Metric label="生成后门禁" value={qualityGate?.blocked === true ? '阻断' : qualityGate ? '通过' : '未记录'} tone={qualityGate?.blocked === true ? 'danger' : warnings.length ? 'warn' : 'ok'} />
        <Metric label="召回方式" value={textValue(retrieval?.searchMethod, '未知')} tone={retrieval?.searchMethod === 'keyword_fallback' ? 'warn' : 'ok'} />
        <Metric label="质量分" value={numberValue(qualityGate?.score, numberValue(retrieval?.qualityScore) * 100).toFixed(0)} tone={blocked ? 'danger' : warnings.length ? 'warn' : 'ok'} />
      </div>
      <div className="space-y-1">
        {blockers.slice(0, 4).map((item, index) => <div key={`blocker-${index}`} className="text-xs leading-5" style={{ color: '#fb7185' }}>✖ {textValue(item)}</div>)}
        {warnings.slice(0, 5).map((item, index) => <div key={`warning-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {textValue(item)}</div>)}
        {!warnings.length && !blockers.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>生成前检查、生成后门禁与召回质量均正常。</div>}
      </div>
    </div>
  );
}

function ChapterPolishSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="grid gap-2 md:grid-cols-3"><Metric label="Draft ID" value={textValue(data?.draftId)} /><Metric label="原字数" value={numberValue(data?.originalWordCount)} /><Metric label="润色字数" value={numberValue(data?.polishedWordCount)} /></div>;
}

function ChapterContextSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const chapter = asRecord(data?.chapter);
  const writePreview = asRecord(data?.writePreview);
  const draft = asRecord(writePreview?.draft);
  const facts = asRecord(writePreview?.facts);
  const memory = asRecord(writePreview?.memory);
  const validation = asRecord(writePreview?.validation);
  const hints = asArray(writePreview?.approvalRiskHints);
  const currentVersionNo = numberValue(draft?.currentVersionNo);
  const currentExcerpt = textValue(draft?.currentExcerpt, '');
  const autoFactCount = numberValue(facts?.existingAutoEventCount) + numberValue(facts?.existingAutoCharacterStateCount) + numberValue(facts?.existingAutoForeshadowCount);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="章节" value={`${numberValue(chapter?.chapterNo)} · ${textValue(chapter?.title, '未命名')}`} />
        <Metric label="角色" value={asArray(data?.characters).length} />
        <Metric label="记忆片段" value={asArray(data?.memoryChunks).length} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(chapter?.objective ?? chapter?.outline, '暂无章节目标')}</div>
      {writePreview && (
        <div className="space-y-2" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
          <div className="grid gap-2 md:grid-cols-4">
            <Metric label="草稿动作" value={textValue(draft?.action, 'unknown')} tone={draft?.action === 'create_new_version' ? 'warn' : 'ok'} />
            <Metric label="当前版本" value={currentVersionNo ? `v${currentVersionNo}` : '无'} />
            <Metric label="自动事实" value={autoFactCount} tone={autoFactCount ? 'warn' : undefined} />
            <Metric label="自动记忆" value={numberValue(memory?.existingAutoMemoryCount)} tone={numberValue(memory?.existingAutoMemoryCount) ? 'warn' : undefined} />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <Metric label="Open 校验问题" value={numberValue(validation?.openIssueCount)} tone={numberValue(validation?.openErrorCount) ? 'danger' : numberValue(validation?.openIssueCount) ? 'warn' : 'ok'} />
            <Metric label="当前草稿字数" value={numberValue(draft?.currentWordCount)} />
          </div>
          <div className="space-y-1">{hints.slice(0, 5).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {textValue(item)}</div>)}</div>
          {currentExcerpt ? <div className="text-xs leading-5" style={{ color: 'var(--text-dim)' }}>当前草稿摘录：{currentExcerpt}</div> : null}
        </div>
      )}
    </div>
  );
}

function FactExtractionSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const events = asArray(data?.events);
  const states = asArray(data?.characterStates);
  const foreshadows = asArray(data?.foreshadows);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="剧情事件" value={numberValue(data?.createdEvents, events.length)} />
        <Metric label="角色状态" value={numberValue(data?.createdCharacterStates, states.length)} />
        <Metric label="伏笔" value={numberValue(data?.createdForeshadows, foreshadows.length)} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(data?.summary, '暂无章节摘要')}</div>
      <div className="space-y-1">
        {events.slice(0, 3).map((item, index) => {
          const event = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>{textValue(event?.title, `事件${index + 1}`)}</b> — {textValue(event?.description, '暂无描述')}</div>;
        })}
      </div>
    </div>
  );
}

function AutoRepairSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const skipped = data?.skipped === true;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="状态" value={skipped ? '已跳过' : '已修复'} tone={skipped ? 'warn' : 'ok'} />
        <Metric label="修复问题" value={numberValue(data?.repairedIssueCount)} />
        <Metric label="修复后字数" value={numberValue(data?.repairedWordCount)} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{skipped ? `原因：${textValue(data?.reason, '无可修复问题')}` : textValue(data?.summary, '已创建修复草稿')}</div>
    </div>
  );
}

function MemoryReviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const decisions = asArray(data?.decisions);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="已复核" value={numberValue(data?.reviewedCount)} />
        <Metric label="确认" value={numberValue(data?.confirmedCount)} tone="ok" />
        <Metric label="拒绝" value={numberValue(data?.rejectedCount)} tone={numberValue(data?.rejectedCount) ? 'warn' : undefined} />
        <Metric label="跳过" value={numberValue(data?.skippedCount)} />
      </div>
      <div className="space-y-1">
        {decisions.slice(0, 4).map((item, index) => {
          const decision = asRecord(item);
          const action = textValue(decision?.action, 'unknown');
          return <div key={index} className="text-xs leading-5" style={{ color: action === 'confirm' ? '#86efac' : '#fbbf24' }}>[{action}] {textValue(decision?.reason, '暂无理由')}</div>;
        })}
        {!decisions.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无待复核记忆。</div>}
      </div>
    </div>
  );
}
