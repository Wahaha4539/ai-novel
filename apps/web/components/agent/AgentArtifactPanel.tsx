'use client';

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
}

/** 产物预览面板：搜索、去重、按类型渲染业务化摘要 */
export function AgentArtifactPanel({ run, query, onQueryChange }: AgentArtifactPanelProps) {
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
          className="px-3 py-2 text-xs outline-none"
          style={{ width: 160, borderRadius: '0.7rem', border: '1px solid var(--border-dim)', background: 'rgba(0,0,0,0.2)', color: 'var(--text-main)' }}
        />
      </div>
      {filteredArtifacts.length ? (
        <div className="space-y-3">
          {filteredArtifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifactType={artifact.artifactType} title={artifact.title} content={artifact.content} />
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

function ArtifactCard({ artifactType, title, content }: { artifactType?: string; title?: string; content?: unknown }) {
  return (
    <details className="p-3" style={{ borderRadius: '0.9rem', border: '1px solid var(--border-dim)', background: 'rgba(0,0,0,0.18)' }}>
      <summary className="cursor-pointer text-sm" style={{ color: 'var(--text-main)' }}>
        {title ?? artifactType ?? 'Artifact'}
        <span className="ml-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>点击展开/折叠原始 JSON</span>
      </summary>
      <div className="mt-3">
        <TypedArtifactPreview artifactType={artifactType} content={content} />
        <details className="mt-3">
          <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-dim)' }}>原始 JSON</summary>
          <pre className="mt-3 text-xs whitespace-pre-wrap overflow-auto max-h-72" style={{ color: 'var(--text-dim)', borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>{safeJson(content)}</pre>
        </details>
      </div>
    </details>
  );
}

/** 按 AgentArtifact 类型提供业务化摘要，避免用户只能阅读大段 JSON */
function TypedArtifactPreview({ artifactType, content }: { artifactType?: string; content?: unknown }) {
  if (artifactType === 'outline_preview') return <OutlinePreviewSummary content={content} />;
  if (artifactType === 'outline_validation_report' || artifactType === 'import_validation_report' || artifactType === 'fact_validation_report') return <ValidationSummary content={content} />;
  if (artifactType === 'project_profile_preview') return <ProjectProfileSummary content={content} />;
  if (artifactType === 'characters_preview') return <ArraySummary content={content} label="角色" primaryKey="name" secondaryKey="roleType" />;
  if (artifactType === 'lorebook_preview') return <ArraySummary content={content} label="设定" primaryKey="title" secondaryKey="entryType" />;
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

/** 展示写入前 diff 摘要，帮助用户在审批前理解会新增、更新或跳过哪些资产 */
function WritePreviewSummary({ content }: { content: unknown }) {
  const preview = asRecord(content);
  const summary = asRecord(preview?.summary);
  if (!preview || !summary) return null;
  const chapterCreate = numberValue(summary.chapterCreateCount, numberValue(summary.createCount));
  const chapterUpdate = numberValue(summary.chapterUpdateCount, numberValue(summary.updateCount));
  const chapterSkip = numberValue(summary.chapterSkipCount, numberValue(summary.skipCount));
  const chapters = asArray(preview.chapters);
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
      </div>
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
