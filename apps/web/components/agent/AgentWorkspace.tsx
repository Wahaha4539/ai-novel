'use client';

import { useEffect, useMemo, useState } from 'react';
import { AgentPlanPayload, AgentRun, AgentRunListItem, AgentRunStepRecord, useAgentRun } from '../../hooks/useAgentRun';
import { AgentApprovalDialog } from './AgentApprovalDialog';
import { AgentInputBox } from './AgentInputBox';

interface AgentWorkspaceProps {
  projectId: string;
  selectedChapterId?: string;
  onRefresh?: () => void | Promise<void>;
}

function latestPlan(run: AgentRun | null): AgentPlanPayload | undefined {
  return [...(run?.plans ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]?.plan;
}

function planVersionLabel(plan: { version?: number; createdAt?: string }) {
  return `v${plan.version ?? 1}${plan.createdAt ? ` · ${formatDate(plan.createdAt)}` : ''}`;
}

function safeJson(value: unknown) {
  if (value === undefined || value === null) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Agent Workspace 提供自然语言创作任务入口，并串联后端 Plan/Approval/Act 全流程。 */
export function AgentWorkspace({ projectId, selectedChapterId, onRefresh }: AgentWorkspaceProps) {
  const { currentRun, runHistory, loading, error, actionMessage, createPlan, act, retry, replan, refresh, cancel, listByProject } = useAgentRun();
  const [goal, setGoal] = useState('');
  const [approvedStepNos, setApprovedStepNos] = useState<number[]>([]);
  const [artifactQuery, setArtifactQuery] = useState('');
  const plan = latestPlan(currentRun);
  const approvalStepNos = useMemo(() => plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [], [plan]);
  const canAct = !!currentRun && (currentRun.status === 'waiting_approval' || currentRun.status === 'waiting_review');
  const canRetry = !!currentRun && (currentRun.status === 'failed' || currentRun.status === 'waiting_review');
  const canReplan = !!currentRun && currentRun.status !== 'acting' && currentRun.status !== 'running';

  useEffect(() => {
    // 项目切换时拉取最近 AgentRun，让工作台具备“从历史恢复上下文”的入口。
    void listByProject(projectId);
  }, [listByProject, projectId]);

  useEffect(() => {
    // 默认勾选计划要求审批的步骤，用户仍可按步骤取消，支持更细粒度审批。
    setApprovedStepNos(approvalStepNos);
  }, [approvalStepNos]);

  const handleSubmit = async () => {
    if (!goal.trim() || loading) return;
    await createPlan(projectId, goal.trim(), selectedChapterId);
  };

  const handleAct = async () => {
    if (!currentRun) return;
    await act(currentRun.id, approvalStepNos.length ? approvedStepNos : undefined);
    await onRefresh?.();
  };

  const handleRetry = async () => {
    if (!currentRun) return;
    await retry(currentRun.id, approvalStepNos.length ? approvedStepNos : undefined);
    await onRefresh?.();
  };

  const handleReplan = async () => {
    if (!currentRun) return;
    await replan(currentRun.id, goal.trim() || undefined);
    await listByProject(projectId);
  };

  return (
    <div className="h-full overflow-hidden" style={{ background: 'radial-gradient(circle at 20% 0%, rgba(6,182,212,0.13), transparent 32%), radial-gradient(circle at 90% 10%, rgba(245,158,11,0.10), transparent 26%), var(--bg-primary)' }}>
      <div className="h-full overflow-y-auto px-8 py-7">
        <header className="mb-7 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="panel p-6" style={{ borderColor: 'rgba(6,182,212,0.22)', background: 'linear-gradient(135deg, rgba(5,10,18,0.78), rgba(15,23,42,0.48))' }}>
            <div className="text-xs font-bold mb-3" style={{ color: '#67e8f9', letterSpacing: '0.24em', textTransform: 'uppercase' }}>AGENT OPS CONSOLE</div>
            <h1 className="text-3xl font-black mb-3" style={{ color: 'var(--text-main)' }}>创作 Agent 工作台</h1>
            <p className="text-sm leading-7" style={{ color: 'var(--text-muted)' }}>
              用自然语言提出章节写作、大纲设计或文案拆解任务。Agent 会先生成可审阅计划，只有确认后才执行写入类工具。
            </p>
          </div>
          <div className="panel p-5 flex flex-col justify-between" style={{ background: 'rgba(0,0,0,0.22)' }}>
            <div className="text-xs font-bold mb-3" style={{ color: 'var(--text-dim)', letterSpacing: '0.16em' }}>CURRENT RUN</div>
            <StatusBadge status={currentRun?.status ?? 'idle'} />
            <div className="mt-4 text-xs break-all" style={{ color: 'var(--text-dim)' }}>Run ID：{currentRun?.id ?? '尚未创建'}</div>
            {actionMessage && <div className="mt-3 text-sm" style={{ color: '#ccfbf1' }}>{actionMessage}</div>}
            {error && <div className="mt-3 text-sm" style={{ color: 'var(--status-err)' }}>{error}</div>}
          </div>
        </header>

        <section className="grid gap-5 xl:grid-cols-[430px_1fr]">
          <div className="space-y-5">
            <AgentInputBox goal={goal} loading={loading} canReplan={canReplan} hasCurrentRun={!!currentRun} onGoalChange={setGoal} onSubmit={handleSubmit} onReplan={handleReplan} onRefresh={async () => { if (currentRun) await refresh(currentRun.id); }} />
            <RunHistoryPanel runs={runHistory} currentRunId={currentRun?.id} loading={loading} onRefresh={async () => { await listByProject(projectId); }} onSelect={async (id) => { await refresh(id); }} />
          </div>

          <div className="space-y-5">
            <PlanPanel run={currentRun} plan={plan} />
            <div className="grid gap-5 lg:grid-cols-2">
              <TimelinePanel steps={currentRun?.steps ?? []} plan={plan} approvedStepNos={approvedStepNos} onToggleApproval={(stepNo) => setApprovedStepNos((current) => (current.includes(stepNo) ? current.filter((item) => item !== stepNo) : [...current, stepNo].sort((a, b) => a - b)))} />
              <ArtifactPanel run={currentRun} query={artifactQuery} onQueryChange={setArtifactQuery} />
            </div>
            <AgentApprovalDialog canAct={canAct} canRetry={canRetry} loading={loading} status={currentRun?.status} hasCurrentRun={!!currentRun} onCancel={async () => { if (currentRun) await cancel(currentRun.id); }} onRetry={handleRetry} onAct={handleAct} />
            <ResultPanel output={currentRun?.output} error={currentRun?.error} />
          </div>
        </section>
      </div>
    </div>
  );
}

function RunHistoryPanel({ runs, currentRunId, loading, onRefresh, onSelect }: { runs: AgentRunListItem[]; currentRunId?: string; loading: boolean; onRefresh: () => void | Promise<void>; onSelect: (id: string) => void | Promise<void> }) {
  return <section className="panel p-5"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>历史 Run</h2><button type="button" disabled={loading} onClick={() => void onRefresh()} className="px-3 py-2 text-xs" style={{ borderRadius: '0.7rem', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', background: 'transparent' }}>刷新历史</button></div>{runs.length ? <div className="space-y-2">{runs.slice(0, 8).map((run) => <button key={run.id} type="button" onClick={() => void onSelect(run.id)} className="block w-full p-3 text-left" style={{ borderRadius: '0.85rem', border: `1px solid ${run.id === currentRunId ? 'rgba(103,232,249,0.45)' : 'var(--border-dim)'}`, background: run.id === currentRunId ? 'rgba(6,182,212,0.10)' : 'rgba(255,255,255,0.02)' }}><div className="flex items-center justify-between gap-2"><span className="text-xs font-bold" style={{ color: 'var(--text-main)' }}>{run.taskType ?? run.agentType ?? 'agent_run'}</span><span className="text-[11px]" style={{ color: run.status === 'failed' ? '#fb7185' : run.status === 'succeeded' ? '#86efac' : '#fbbf24' }}>{run.status}</span></div><div className="mt-2 line-clamp-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{run.goal}</div><div className="mt-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>{formatDate(run.updatedAt ?? run.createdAt)} · {run.id.slice(0, 8)}</div></button>)}</div> : <EmptyText text="暂无历史 Run。" />}</section>;
}

function formatDate(value?: string) {
  if (!value) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'succeeded' ? '#86efac' : status === 'failed' ? '#fb7185' : status === 'waiting_approval' ? '#fbbf24' : '#67e8f9';
  return <div className="inline-flex w-fit items-center gap-2 px-3 py-2 text-xs font-black" style={{ borderRadius: '999px', color, border: `1px solid ${color}55`, background: `${color}14`, letterSpacing: '0.12em', textTransform: 'uppercase' }}><span style={{ width: 8, height: 8, borderRadius: 99, background: color, boxShadow: `0 0 14px ${color}` }} />{status}</div>;
}

function PlanPanel({ run, plan }: { run: AgentRun | null; plan?: AgentPlanPayload }) {
  const plans = [...(run?.plans ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  const diff = buildPlanVersionDiff(plans);
  return <section className="panel p-5"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>计划简报</h2>{plans.length > 1 && <div className="flex flex-wrap gap-2">{plans.slice(0, 4).map((item, index) => <span key={item.id} className="px-2 py-1 text-[10px]" style={{ borderRadius: '999px', border: `1px solid ${index === 0 ? 'rgba(103,232,249,0.45)' : 'var(--border-dim)'}`, color: index === 0 ? '#67e8f9' : 'var(--text-dim)' }}>{planVersionLabel(item)}</span>)}</div>}</div>{plan ? <><p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{plan.summary}</p>{diff && <div className="mb-4 grid gap-2 md:grid-cols-3"><Metric label="新增步骤" value={diff.added} tone={diff.added ? 'warn' : undefined} /><Metric label="移除步骤" value={diff.removed} tone={diff.removed ? 'warn' : undefined} /><Metric label="审批变化" value={diff.approvalChanged} tone={diff.approvalChanged ? 'danger' : 'ok'} /></div>}<div className="grid gap-3 md:grid-cols-2"><ListBlock title="假设" items={plan.assumptions ?? []} /><ListBlock title="风险/规则" items={plan.risks ?? []} /></div></> : <EmptyText text="提交任务后，这里会显示 Agent 的理解、假设和风险。" />}</section>;
}

function buildPlanVersionDiff(plans: NonNullable<AgentRun['plans']>) {
  if (plans.length < 2) return null;
  const [latest, previous] = plans;
  const latestSteps = latest.plan?.steps ?? [];
  const previousSteps = previous.plan?.steps ?? [];
  const latestKeys = new Set(latestSteps.map((step) => `${step.stepNo}:${step.tool ?? ''}`));
  const previousKeys = new Set(previousSteps.map((step) => `${step.stepNo}:${step.tool ?? ''}`));
  const added = [...latestKeys].filter((key) => !previousKeys.has(key)).length;
  const removed = [...previousKeys].filter((key) => !latestKeys.has(key)).length;
  const approvalChanged = Math.abs((latest.plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? []).length - (previous.plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? []).length);
  return { added, removed, approvalChanged };
}

function TimelinePanel({ steps, plan, approvedStepNos, onToggleApproval }: { steps: AgentRunStepRecord[]; plan?: AgentPlanPayload; approvedStepNos: number[]; onToggleApproval: (stepNo: number) => void }) {
  const planSteps = plan?.steps ?? [];
  return <section className="panel p-5"><h2 className="text-sm font-bold mb-4" style={{ color: 'var(--text-main)' }}>执行时间线</h2><div className="space-y-3">{planSteps.length ? planSteps.map((step) => { const record = steps.find((item) => item.stepNo === step.stepNo); const approved = approvedStepNos.includes(step.stepNo); return <div key={step.stepNo} className="p-3" style={{ borderRadius: '0.9rem', border: `1px solid ${step.requiresApproval ? 'rgba(251,191,36,0.38)' : 'var(--border-dim)'}`, background: record ? 'rgba(6,182,212,0.06)' : step.requiresApproval ? 'rgba(251,191,36,0.06)' : 'rgba(255,255,255,0.02)' }}><div className="flex items-center justify-between gap-3"><div className="text-sm font-semibold" style={{ color: 'var(--text-main)' }}>{step.stepNo}. {step.name}</div><span className="text-xs" style={{ color: step.requiresApproval ? '#fbbf24' : 'var(--text-dim)' }}>{record?.status ?? (step.requiresApproval ? '需审批' : '待执行')}</span></div>{step.requiresApproval && <div className="mt-2 text-[11px] leading-5" style={{ color: '#fbbf24' }}>风险提示：此步骤可能写入草稿、事实层、记忆或项目资料；取消勾选则后端不会把该步骤视为已审批。</div>}<div className="mt-2 flex items-center justify-between gap-3"><div className="text-xs" style={{ color: 'var(--text-muted)' }}>{step.tool}</div>{step.requiresApproval && <label className="inline-flex items-center gap-2 text-xs" style={{ color: approved ? '#86efac' : 'var(--text-dim)' }}><input type="checkbox" checked={approved} onChange={() => onToggleApproval(step.stepNo)} />审批此步</label>}</div></div>; }) : <EmptyText text="暂无步骤。" />}</div></section>;
}

function ArtifactPanel({ run, query, onQueryChange }: { run: AgentRun | null; query: string; onQueryChange: (value: string) => void }) {
  const artifacts = dedupeArtifacts(run?.artifacts ?? []);
  const filteredArtifacts = filterArtifacts(artifacts, query);
  return <section className="panel p-5"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>产物预览</h2><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索产物/JSON…" className="px-3 py-2 text-xs outline-none" style={{ width: 160, borderRadius: '0.7rem', border: '1px solid var(--border-dim)', background: 'rgba(0,0,0,0.2)', color: 'var(--text-main)' }} /></div>{filteredArtifacts.length ? <div className="space-y-3">{filteredArtifacts.map((artifact) => <ArtifactCard key={artifact.id} artifactType={artifact.artifactType} title={artifact.title} content={artifact.content} />)}</div> : <EmptyText text={artifacts.length ? '没有匹配的产物。' : '计划产物和预览会在这里展开。'} />}</section>;
}

function filterArtifacts(artifacts: NonNullable<AgentRun['artifacts']>, query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return artifacts;
  return artifacts.filter((artifact) => `${artifact.artifactType ?? ''}\n${artifact.title ?? ''}\n${safeJson(artifact.content)}`.toLowerCase().includes(keyword));
}

function dedupeArtifacts(artifacts: NonNullable<AgentRun['artifacts']>) {
  const seen = new Set<string>();
  // 按类型与标题保留最新产物，避免 Plan/Act 或多次 replan 后重复卡片淹没用户。
  return [...artifacts].reverse().filter((artifact) => { const key = `${artifact.artifactType ?? ''}:${artifact.title ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; }).reverse();
}

function ArtifactCard({ artifactType, title, content }: { artifactType?: string; title?: string; content?: unknown }) {
  return <details className="p-3" style={{ borderRadius: '0.9rem', border: '1px solid var(--border-dim)', background: 'rgba(0,0,0,0.18)' }}><summary className="cursor-pointer text-sm" style={{ color: 'var(--text-main)' }}>{title ?? artifactType ?? 'Artifact'}<span className="ml-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>点击展开/折叠原始 JSON</span></summary><div className="mt-3"><TypedArtifactPreview artifactType={artifactType} content={content} /><details className="mt-3"><summary className="cursor-pointer text-xs" style={{ color: 'var(--text-dim)' }}>原始 JSON</summary><pre className="mt-3 text-xs whitespace-pre-wrap overflow-auto max-h-72" style={{ color: 'var(--text-dim)', borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>{safeJson(content)}</pre></details></div></details>;
}

/** 按 AgentArtifact 类型提供业务化摘要，避免用户只能阅读大段 JSON。 */
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

function OutlinePreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const volume = asRecord(data?.volume);
  const chapters = asArray(data?.chapters);
  const totalExpectedWordCount = chapters.reduce<number>((sum, item) => sum + numberValue(asRecord(item)?.expectedWordCount), 0);
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-3"><Metric label="卷" value={textValue(volume?.title, '未命名卷')} /><Metric label="章节数" value={chapters.length} /><Metric label="总目标字数" value={totalExpectedWordCount} /></div><div className="space-y-2">{chapters.slice(0, 5).map((item, index) => { const chapter = asRecord(item); return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>{numberValue(chapter?.chapterNo, index + 1)}. {textValue(chapter?.title, '未命名章节')}</b> — {textValue(chapter?.objective ?? chapter?.outline, '暂无目标')}</div>; })}</div></div>;
}

function ValidationSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const issues = asArray(data?.issues);
  const hasError = issues.some((item) => asRecord(item)?.severity === 'error');
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-3"><Metric label="状态" value={data?.valid === false ? '需复核' : '可继续'} tone={hasError ? 'danger' : issues.length ? 'warn' : 'ok'} /><Metric label="问题数" value={numberValue(data?.issueCount, issues.length)} /><Metric label="来源风险" value={asArray(data?.sourceRisks).length} /></div><div className="space-y-2">{issues.slice(0, 5).map((item, index) => { const issue = asRecord(item); return <div key={index} className="text-xs leading-5" style={{ color: issue?.severity === 'error' ? '#fb7185' : '#fbbf24' }}>[{textValue(issue?.severity)}] {textValue(issue?.message)}</div>; })}{!issues.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>未发现阻断性问题。</div>}</div></div>;
}

function ProjectProfileSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="space-y-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}><Metric label="标题" value={textValue(data?.title, '未命名项目')} /><div>{textValue(data?.logline ?? data?.synopsis ?? data?.outline, '暂无简介')}</div></div>;
}

function ArraySummary({ content, label, primaryKey, secondaryKey }: { content: unknown; label: string; primaryKey: string; secondaryKey: string }) {
  const items = asArray(content);
  return <div className="space-y-3"><Metric label={`${label}数量`} value={items.length} /><div className="flex flex-wrap gap-2">{items.slice(0, 12).map((item, index) => { const record = asRecord(item); return <span key={index} className="px-2 py-1 text-xs" style={{ borderRadius: '999px', border: '1px solid var(--border-dim)', color: 'var(--text-muted)' }}>{textValue(record?.[primaryKey], `${label}${index + 1}`)}{record?.[secondaryKey] ? ` · ${textValue(record[secondaryKey])}` : ''}</span>; })}</div></div>;
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
  const retrieval = asRecord(data?.retrievalDiagnostics);
  const warnings = [...asArray(preflight?.warnings), ...asArray(retrieval?.warnings)];
  const blocked = preflight?.valid === false || retrieval?.qualityStatus === 'blocked';
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-3"><Metric label="Preflight" value={preflight?.valid === false ? '未通过' : '通过'} tone={preflight?.valid === false ? 'danger' : warnings.length ? 'warn' : 'ok'} /><Metric label="召回方式" value={textValue(retrieval?.searchMethod, '未知')} tone={retrieval?.searchMethod === 'keyword_fallback' ? 'warn' : 'ok'} /><Metric label="质量分" value={numberValue(retrieval?.qualityScore).toFixed(2)} tone={blocked ? 'danger' : warnings.length ? 'warn' : 'ok'} /></div><div className="space-y-1">{warnings.slice(0, 5).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {textValue(item)}</div>)}{!warnings.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>生成前检查与召回质量均正常。</div>}</div></div>;
}

function ChapterPolishSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="grid gap-2 md:grid-cols-3"><Metric label="Draft ID" value={textValue(data?.draftId)} /><Metric label="原字数" value={numberValue(data?.originalWordCount)} /><Metric label="润色字数" value={numberValue(data?.polishedWordCount)} /></div>;
}

function ChapterContextSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const chapter = asRecord(data?.chapter);
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-3"><Metric label="章节" value={`${numberValue(chapter?.chapterNo)} · ${textValue(chapter?.title, '未命名')}`} /><Metric label="角色" value={asArray(data?.characters).length} /><Metric label="记忆片段" value={asArray(data?.memoryChunks).length} /></div><div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(chapter?.objective ?? chapter?.outline, '暂无章节目标')}</div></div>;
}

function FactExtractionSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const events = asArray(data?.events);
  const states = asArray(data?.characterStates);
  const foreshadows = asArray(data?.foreshadows);
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-3"><Metric label="剧情事件" value={numberValue(data?.createdEvents, events.length)} /><Metric label="角色状态" value={numberValue(data?.createdCharacterStates, states.length)} /><Metric label="伏笔" value={numberValue(data?.createdForeshadows, foreshadows.length)} /></div><div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(data?.summary, '暂无章节摘要')}</div><div className="space-y-1">{events.slice(0, 3).map((item, index) => { const event = asRecord(item); return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>{textValue(event?.title, `事件${index + 1}`)}</b> — {textValue(event?.description, '暂无描述')}</div>; })}</div></div>;
}

function MemoryReviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const decisions = asArray(data?.decisions);
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-4"><Metric label="已复核" value={numberValue(data?.reviewedCount)} /><Metric label="确认" value={numberValue(data?.confirmedCount)} tone="ok" /><Metric label="拒绝" value={numberValue(data?.rejectedCount)} tone={numberValue(data?.rejectedCount) ? 'warn' : undefined} /><Metric label="跳过" value={numberValue(data?.skippedCount)} /></div><div className="space-y-1">{decisions.slice(0, 4).map((item, index) => { const decision = asRecord(item); const action = textValue(decision?.action, 'unknown'); return <div key={index} className="text-xs leading-5" style={{ color: action === 'confirm' ? '#86efac' : '#fbbf24' }}>[{action}] {textValue(decision?.reason, '暂无理由')}</div>; })}{!decisions.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无待复核记忆。</div>}</div></div>;
}

function AutoRepairSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const skipped = data?.skipped === true;
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-3"><Metric label="状态" value={skipped ? '已跳过' : '已修复'} tone={skipped ? 'warn' : 'ok'} /><Metric label="修复问题" value={numberValue(data?.repairedIssueCount)} /><Metric label="修复后字数" value={numberValue(data?.repairedWordCount)} /></div><div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{skipped ? `原因：${textValue(data?.reason, '无可修复问题')}` : textValue(data?.summary, '已创建修复草稿')}</div></div>;
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'danger' }) {
  const color = tone === 'danger' ? '#fb7185' : tone === 'warn' ? '#fbbf24' : tone === 'ok' ? '#86efac' : '#67e8f9';
  return <div className="p-2" style={{ borderRadius: '0.75rem', border: `1px solid ${color}33`, background: `${color}10` }}><div className="text-[10px] font-bold" style={{ color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div><div className="mt-1 text-xs font-bold break-all" style={{ color }}>{value}</div></div>;
}

function ResultPanel({ output, error }: { output?: unknown; error?: unknown }) {
  return <section className="panel p-5"><h2 className="text-sm font-bold mb-3" style={{ color: 'var(--text-main)' }}>最终报告</h2>{error ? <pre className="text-xs whitespace-pre-wrap" style={{ color: 'var(--status-err)' }}>{safeJson(error)}</pre> : output ? <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-96" style={{ color: 'var(--text-muted)' }}>{safeJson(output)}</pre> : <EmptyText text="执行完成后会展示 draftId、校验结果、记忆回写和下一步建议。" />}</section>;
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return <div className="p-3" style={{ borderRadius: '0.9rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-dim)' }}><div className="text-xs font-bold mb-2" style={{ color: 'var(--text-dim)' }}>{title}</div><ul className="space-y-2">{items.length ? items.map((item) => <li key={item} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>• {item}</li>) : <li className="text-xs" style={{ color: 'var(--text-dim)' }}>—</li>}</ul></div>;
}

function EmptyText({ text }: { text: string }) {
  return <div className="text-sm py-8 text-center" style={{ color: 'var(--text-dim)' }}>{text}</div>;
}