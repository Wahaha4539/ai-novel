'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AgentAuditEvent,
  AgentRunArtifact,
  AgentPlanPayload,
  AgentPlanStep,
  AgentRun,
  AgentRunStepRecord,
  ReplanClarificationChoice,
} from '../../hooks/useAgentRun';
import { AgentApprovalDialog } from './AgentApprovalDialog';
import { AgentArtifactPanel } from './AgentArtifactPanel';
import { AgentAuditPanel } from './AgentAuditPanel';
import { AgentObservationPanel } from './AgentObservationPanel';
import { AgentResultPanel } from './AgentResultPanel';
import {
  EmptyText,
  StatusBadge,
  agentToolUiExplanation,
  asRecord,
  formatDate,
  safeJson,
  type ProjectImportAssetType,
} from './AgentSharedWidgets';
import {
  chapterNosFromPlanStep,
  chapterRangeLabel,
  formatChapterProgress,
  outlineChapterProgress,
} from './agentBatchPlanView';

type PhaseKey = 'plan' | 'todo' | 'execute' | 'summary';
type PhaseState = 'pending' | 'active' | 'done' | 'blocked';

interface AgentMissionWindowProps {
  currentRun: AgentRun | null;
  plan?: AgentPlanPayload;
  activePlanVersion: number;
  approvedStepNos: number[];
  canAct: boolean;
  canRetry: boolean;
  loading: boolean;
  riskSummary: string[];
  artifactQuery: string;
  auditEvents: AgentAuditEvent[];
  onToggleApproval: (stepNo: number) => void;
  onArtifactQueryChange: (value: string) => void;
  onCancel: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onAct: () => void | Promise<void>;
  onAnswerClarification: (choice: ReplanClarificationChoice) => void | Promise<void>;
  onRequestWorldbuildingPersistSelection: (titles: string[]) => void | Promise<void>;
  onRequestImportTargetRegeneration: (assetType: ProjectImportAssetType) => void | Promise<void>;
}

const PHASE_LABELS: Record<PhaseKey, { title: string; caption: string }> = {
  plan: { title: '规划', caption: '理解目标' },
  todo: { title: '待办', caption: '确认步骤' },
  execute: { title: '执行', caption: '调用工具' },
  summary: { title: '总结', caption: '交付结果' },
};

const STATUS_LABELS: Record<string, string> = {
  planning: '规划中',
  waiting_approval: '待确认',
  waiting_review: '待复核',
  acting: '执行中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  idle: '未开始',
};

function statusLabel(status?: string) {
  return status ? (STATUS_LABELS[status] ?? status) : STATUS_LABELS.idle;
}

function isFinishedStatus(status?: string) {
  return status === 'succeeded' || status === 'skipped';
}

function isActiveStatus(status?: string) {
  return status === 'running' || status === 'acting' || status === 'planning';
}

function isFailedStatus(status?: string) {
  return status === 'failed';
}

function findStepRecord(records: AgentRunStepRecord[], stepNo: number, planVersion: number) {
  const matching = records.filter((item) => item.stepNo === stepNo && (item.planVersion ?? 1) === planVersion);
  return matching.find((item) => item.mode === 'act') ?? matching.find((item) => item.mode === 'plan') ?? matching[0];
}

function findLatestFailedStepRecord(records: AgentRunStepRecord[], planVersion: number) {
  return records
    .filter((item) => (item.planVersion ?? 1) === planVersion && isFailedStatus(item.status))
    .sort((left, right) => {
      const rightTime = new Date(right.finishedAt ?? right.startedAt ?? 0).getTime();
      const leftTime = new Date(left.finishedAt ?? left.startedAt ?? 0).getTime();
      if (rightTime !== leftTime) return rightTime - leftTime;
      return right.stepNo - left.stepNo;
    })[0];
}

function findExecutionStepRecord(records: AgentRunStepRecord[], stepNo: number, planVersion: number) {
  const matching = records.filter((item) => item.stepNo === stepNo && (item.planVersion ?? 1) === planVersion);
  return matching.find((item) => item.mode === 'act') ?? matching.find((item) => item.mode !== 'plan');
}

function shouldUseFallbackTodoRecord(status?: string) {
  return status === 'acting' || status === 'running' || status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function findTodoStepRecord(records: AgentRunStepRecord[], stepNo: number, planVersion: number, runStatus?: string) {
  return findExecutionStepRecord(records, stepNo, planVersion) ?? (shouldUseFallbackTodoRecord(runStatus) ? findStepRecord(records, stepNo, planVersion) : undefined);
}

function buildPhaseStates(run: AgentRun | null, plan?: AgentPlanPayload): Record<PhaseKey, PhaseState> {
  const status = run?.status;
  const hasPlan = Boolean(plan);
  return {
    plan: status === 'planning' ? 'active' : hasPlan ? 'done' : 'pending',
    todo: status === 'waiting_approval' || status === 'waiting_review' ? 'active' : ['acting', 'running', 'succeeded', 'failed'].includes(status ?? '') ? 'done' : 'pending',
    execute: status === 'acting' || status === 'running' ? 'active' : status === 'succeeded' ? 'done' : status === 'failed' ? 'blocked' : 'pending',
    summary: status === 'succeeded' ? 'done' : status === 'failed' || status === 'cancelled' ? 'blocked' : 'pending',
  };
}

function progressPercent(run: AgentRun | null, plan?: AgentPlanPayload, activePlanVersion = 1) {
  const status = run?.status;
  if (!run) return 0;
  if (status === 'succeeded') return 100;
  if (status === 'failed' || status === 'cancelled') return 100;

  const planSteps = plan?.steps ?? [];
  if (!planSteps.length) return status === 'planning' ? 18 : 8;

  const completedCount = planSteps.filter((step) => {
    const record = findStepRecord(run.steps ?? [], step.stepNo, activePlanVersion);
    return isFinishedStatus(record?.status);
  }).length;

  const base = status === 'waiting_approval' || status === 'waiting_review' ? 38 : status === 'acting' || status === 'running' ? 52 : 24;
  const stepProgress = Math.round((completedCount / planSteps.length) * 48);
  return Math.min(96, Math.max(base, base + stepProgress));
}

function displayValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} 项`;
  const record = asRecord(value);
  if (!record) return safeJson(value);
  const countKeys = ['createdCount', 'updatedCount', 'issueCount', 'acceptedCount', 'wordCount'];
  const matched = countKeys.find((key) => typeof record[key] === 'number');
  if (matched) return `${record[matched]} (${matched})`;
  return '已生成';
}

function truncateText(value: string, maxLength = 140) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function compactValue(value: unknown, maxLength = 140): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return truncateText(value, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const sample = value.slice(0, 3).map((item) => compactValue(item, 56)).filter((item) => item !== '—');
    return sample.length ? `${value.length} 项：${sample.join('；')}` : `${value.length} 项`;
  }
  const record = asRecord(value);
  if (!record) return truncateText(safeJson(value), Math.max(maxLength, 180));
  const countKeys = ['createdCount', 'updatedCount', 'issueCount', 'acceptedCount', 'wordCount'];
  const matched = countKeys.find((key) => typeof record[key] === 'number');
  if (matched) return `${record[matched]} (${matched})`;
  const entries = Object.entries(record).filter(([, item]) => item !== undefined && item !== null && item !== '');
  if (!entries.length) return '空对象';
  return entries.slice(0, 3).map(([key, item]) => `${key}: ${compactValue(item, 72)}`).join('；');
}

function previewRows(value: unknown) {
  if (value === undefined || value === null || value === '') return [];
  const record = asRecord(value);
  if (!record || Array.isArray(value)) return [{ key: Array.isArray(value) ? 'items' : 'value', value: compactValue(value) }];
  return Object.entries(record)
    .filter(([, item]) => item !== undefined && item !== null && item !== '')
    .slice(0, 5)
    .map(([key, item]) => ({ key, value: compactValue(item) }));
}

function durationText(startedAt?: string, finishedAt?: string, status?: string) {
  if (!startedAt) return '—';
  const started = new Date(startedAt).getTime();
  const finished = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return '—';
  const ms = finished - started;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  const text = seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return !finishedAt && isActiveStatus(status) ? `${text} / 进行中` : text;
}

function resultRows(output: unknown) {
  const record = asRecord(output);
  if (!record) return [];
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 6)
    .map(([key, value]) => ({ key, value: displayValue(value) }));
}

function latestArtifactTitle(run: AgentRun | null) {
  const artifact = [...(run?.artifacts ?? [])].reverse()[0];
  return artifact?.title ?? artifact?.artifactType ?? '—';
}

function stepStatusTone(status?: string, waitingApproval?: boolean) {
  if (isFailedStatus(status)) return 'danger';
  if (isFinishedStatus(status)) return 'ok';
  if (isActiveStatus(status)) return 'active';
  if (waitingApproval) return 'warn';
  return 'muted';
}

function stepStatusText(record: AgentRunStepRecord | undefined, requiresApproval: boolean, approved: boolean) {
  if (record?.status) return statusLabel(record.status);
  if (requiresApproval) return approved ? '已勾选' : '待审批';
  return '待执行';
}

function todoItemState(record: AgentRunStepRecord | undefined, requiresApproval: boolean, approved: boolean) {
  if (isFinishedStatus(record?.status)) return 'done';
  if (isFailedStatus(record?.status)) return 'danger';
  if (isActiveStatus(record?.status)) return 'active';
  if (requiresApproval && approved) return 'approved';
  if (requiresApproval) return 'review';
  return 'pending';
}

function todoItemMark(state: string, stepNo: number) {
  if (state === 'done' || state === 'approved') return '✓';
  if (state === 'active') return '…';
  if (state === 'danger') return '!';
  return stepNo;
}

function toolCallName(step: AgentRunStepRecord) {
  return step.tool ?? step.toolName ?? 'tool';
}

function artifactsForStep(artifacts: AgentRunArtifact[], stepNo: number) {
  return artifacts.filter((artifact) => artifact.sourceStepNo === stepNo);
}

function artifactSummary(artifacts: AgentRunArtifact[]) {
  if (!artifacts.length) return '—';
  if (artifacts.length === 1) return artifacts[0].title ?? artifacts[0].artifactType ?? '1 个产物';
  return `${artifacts.length} 个产物`;
}

function expectedArtifactSummary(artifacts: AgentRunArtifact[], expectedOutput?: string) {
  const actualSummary = artifactSummary(artifacts);
  return actualSummary === '—' ? expectedOutput ?? '—' : actualSummary;
}

function llmCallText(step: AgentRunStepRecord, usesLlm?: boolean) {
  const cost = step.metadata?.executionCost;
  const callCount = typeof cost?.llmCallCount === 'number' ? cost.llmCallCount : undefined;
  const model = cost?.model ?? cost?.models?.[0] ?? cost?.llmCalls?.find((item) => item.model)?.model;
  if (callCount !== undefined) {
    return callCount > 0 ? `LLM ${callCount} 次${model ? ` · ${model}` : ''}` : '系统处理 · 不调用 LLM';
  }
  if (usesLlm === true) return '会调用 LLM';
  if (usesLlm === false) return '系统处理 · 不调用 LLM';
  return '按工具实现决定';
}

function phaseProgressText(step: AgentRunStepRecord) {
  const pieces = [];
  if (step.phase) pieces.push(step.phase);
  if (typeof step.progressCurrent === 'number' && typeof step.progressTotal === 'number') pieces.push(`${step.progressCurrent}/${step.progressTotal}`);
  if (step.timeoutAt) pieces.push(`超时点 ${formatDate(step.timeoutAt)}`);
  return pieces.join(' · ');
}

function stepErrorText(step: AgentRunStepRecord) {
  if (step.errorCode === 'TOOL_STUCK_TIMEOUT') return '系统检测到步骤卡住';
  if (step.errorCode === 'TOOL_PHASE_TIMEOUT') return '步骤阶段超过预期时间';
  if (step.errorCode === 'RUN_DEADLINE_EXCEEDED') return 'AgentRun 超过系统执行期限';
  return step.errorCode ?? '';
}

function SummaryRows({ value, emptyText }: { value: unknown; emptyText: string }) {
  const rows = previewRows(value);
  if (!rows.length) return <div className="agent-tool-call-empty">{emptyText}</div>;
  return (
    <dl className="agent-tool-call-preview">
      {rows.map((row) => (
        <div key={row.key}>
          <dt title={row.key}>{row.key}</dt>
          <dd title={row.value}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AgentTodoListPanel({
  planSteps,
  runSteps,
  activePlanVersion,
  runStatus,
  approvedStepNos,
  canApprove,
  loading,
  onToggleApproval,
}: {
  planSteps: AgentPlanStep[];
  runSteps: AgentRunStepRecord[];
  activePlanVersion: number;
  runStatus?: string;
  approvedStepNos: number[];
  canApprove: boolean;
  loading: boolean;
  onToggleApproval: (stepNo: number) => void;
}) {
  const completedCount = planSteps.filter((step) => isFinishedStatus(findTodoStepRecord(runSteps, step.stepNo, activePlanVersion, runStatus)?.status)).length;
  const totalCount = planSteps.length;
  const chapterProgress = useMemo(
    () => outlineChapterProgress(planSteps, runSteps, activePlanVersion),
    [activePlanVersion, planSteps, runSteps],
  );
  const [isOpen, setIsOpen] = useState(totalCount > 0);

  useEffect(() => {
    if (totalCount > 0) setIsOpen(true);
  }, [totalCount]);

  return (
    <details className="agent-todo-list" open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary className="agent-todo-list__summary">
        <span className="agent-todo-list__title">Agent&apos;s todo List</span>
        <span className="agent-todo-list__count">
          {chapterProgress ? `章节 ${formatChapterProgress(chapterProgress)}` : `${completedCount}/${totalCount || 0}`}
        </span>
        <span className="agent-todo-list__chevron">⌄</span>
      </summary>

      {chapterProgress && (
        <div className="agent-outline-progress">
          <span>已生成章节</span>
          <strong>{formatChapterProgress(chapterProgress)}</strong>
          <em>{chapterProgress.batchCount ? `${chapterProgress.batchCount} 个批次` : `${chapterProgress.singleChapterCount} 个章节步骤`}</em>
        </div>
      )}

      {planSteps.length ? (
        <ol className="agent-todo-list__items">
          {planSteps.map((step) => {
            const record = findTodoStepRecord(runSteps, step.stepNo, activePlanVersion, runStatus);
            const approved = approvedStepNos.includes(step.stepNo);
            const state = todoItemState(record, Boolean(step.requiresApproval), approved);
            const canToggleApproval = Boolean(canApprove && step.requiresApproval && !isFinishedStatus(record?.status) && !isActiveStatus(record?.status) && !isFailedStatus(record?.status));
            const explanation = agentToolUiExplanation(step.tool);
            const chapterNos = chapterNosFromPlanStep(step);
            const rangeLabel = chapterRangeLabel(step);
            return (
              <li key={step.stepNo} className={`agent-todo-list__item agent-todo-list__item--${state}`}>
                {step.requiresApproval && canApprove ? (
                  <button
                    type="button"
                    className="agent-todo-list__marker agent-todo-list__marker--button"
                    onClick={() => onToggleApproval(step.stepNo)}
                    disabled={loading || !canToggleApproval}
                    aria-pressed={approved}
                    aria-label={`${approved ? '取消勾选' : '勾选'}审批步骤 ${step.stepNo}`}
                  >
                    {todoItemMark(state, step.stepNo)}
                  </button>
                ) : (
                  <span className="agent-todo-list__marker" aria-hidden="true">{todoItemMark(state, step.stepNo)}</span>
                )}
                <span className="agent-todo-list__copy">
                  <strong>步骤 {step.stepNo}: {step.name ?? step.tool ?? '未命名步骤'}</strong>
                  <small>{step.tool ?? '未绑定工具'}</small>
                  {explanation && <small className="agent-todo-list__hint">产出：{explanation.output}；前端：{explanation.frontendSurface}</small>}
                  {chapterNos.length > 0 && (
                    <span className="agent-chapter-chip-row" aria-label={`${rangeLabel}目标章节`}>
                      {chapterNos.map((chapterNo) => <span key={chapterNo}>第 {chapterNo} 章</span>)}
                    </span>
                  )}
                </span>
                <span className="agent-todo-list__status">{stepStatusText(record, Boolean(step.requiresApproval), approved)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="agent-todo-list__empty">
          <EmptyText text={loading ? '正在生成待办列表…' : '提交任务后显示 Agent 的 todo list。'} />
        </div>
      )}
    </details>
  );
}

function ToolCallsPanel({ steps, artifacts }: { steps: AgentRunStepRecord[]; artifacts: AgentRunArtifact[] }) {
  const toolSteps = steps.filter((step) => step.stepNo > 0);
  return (
    <section className="agent-tool-calls" aria-label="Tool Calls">
      <div className="agent-tool-calls__head">
        <div>
          <span>Tool Calls</span>
          <strong>工具调用明细</strong>
          <small>每一行说明工具用途、生成内容、调用方式，以及会落到哪个前端模块。</small>
        </div>
        <em>{toolSteps.length} calls</em>
      </div>
      {toolSteps.length ? (
        <div className="agent-tool-call-list">
          {toolSteps.map((step) => {
            const stepArtifacts = artifactsForStep(artifacts, step.stepNo);
            const tone = stepStatusTone(step.status);
            const toolName = toolCallName(step);
            const explanation = agentToolUiExplanation(toolName);
            return (
              <details key={step.id} className={`agent-tool-call agent-tool-call--${tone}`}>
                <summary className="agent-tool-call__summary">
                  <span className="agent-tool-call__no">{step.stepNo}</span>
                  <span className="agent-tool-call__main">
                    <span className="agent-tool-call__tool" title={toolName}>{toolName}</span>
                    <span className="agent-tool-call__purpose" title={explanation?.purpose}>{explanation?.purpose ?? step.name ?? '工具调用'}</span>
                  </span>
                  <span className="agent-tool-call__surface" title={explanation?.frontendSurface ?? '—'}>{explanation?.frontendSurface ?? '—'}</span>
                  <span className="agent-tool-call__status">{statusLabel(step.status)}</span>
                  <span className="agent-tool-call__duration">{durationText(step.startedAt, step.finishedAt, step.status)}</span>
                  <span className="agent-tool-call__artifact" title={expectedArtifactSummary(stepArtifacts, explanation?.output)}>{expectedArtifactSummary(stepArtifacts, explanation?.output)}</span>
                  <span className="agent-tool-call__chevron">›</span>
                </summary>
                <div className="agent-tool-call__body">
                  <div className="agent-tool-call-route">
                    <div>
                      <span>生成内容</span>
                      <strong>{explanation?.output ?? expectedArtifactSummary(stepArtifacts)}</strong>
                    </div>
                    <div>
                      <span>前端对应</span>
                      <strong>{explanation?.frontendSurface ?? '未标注前端落点'}</strong>
                    </div>
                    <div>
                      <span>调用方式</span>
                      <strong>{llmCallText(step, explanation?.usesLlm)}</strong>
                    </div>
                  </div>
                  <div className="agent-tool-call-detail">
                    <h4>入参摘要</h4>
                    <SummaryRows value={step.input} emptyText="没有记录入参。" />
                  </div>
                  <div className="agent-tool-call-detail">
                    <h4>输出摘要</h4>
                    <SummaryRows value={step.output} emptyText="没有记录输出。" />
                  </div>
                  <div className="agent-tool-call-detail">
                    <h4>错误</h4>
                    {step.error ? <pre className="agent-tool-call-error">{safeJson(step.error)}</pre> : <div className="agent-tool-call-empty">无错误。</div>}
                  </div>
                  <div className="agent-tool-call-detail agent-tool-call-detail--raw">
                    <h4>原始 JSON</h4>
                    <pre>{safeJson({ input: step.input, output: step.output, error: step.error, artifacts: stepArtifacts.map((artifact) => ({ id: artifact.id, title: artifact.title, artifactType: artifact.artifactType, status: artifact.status })) })}</pre>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <EmptyText text="确认执行后，每一次工具调用都会显示在这里。" />
      )}
    </section>
  );
}

export function AgentMissionWindow({
  currentRun,
  plan,
  activePlanVersion,
  approvedStepNos,
  canAct,
  canRetry,
  loading,
  riskSummary,
  artifactQuery,
  auditEvents,
  onToggleApproval,
  onArtifactQueryChange,
  onCancel,
  onRetry,
  onAct,
  onAnswerClarification,
  onRequestWorldbuildingPersistSelection,
  onRequestImportTargetRegeneration,
}: AgentMissionWindowProps) {
  const planSteps = plan?.steps ?? [];
  const runSteps = currentRun?.steps ?? [];
  const artifacts = currentRun?.artifacts ?? [];
  const phaseStates = buildPhaseStates(currentRun, plan);
  const progress = progressPercent(currentRun, plan, activePlanVersion);
  const completedSteps = planSteps.filter((step) => isFinishedStatus(findStepRecord(runSteps, step.stepNo, activePlanVersion)?.status)).length;
  const missionChapterProgress = useMemo(
    () => outlineChapterProgress(planSteps, runSteps, activePlanVersion),
    [activePlanVersion, planSteps, runSteps],
  );
  const failedStepRecord = findLatestFailedStepRecord(runSteps, activePlanVersion);
  const failedStep = planSteps.find((step) => step.stepNo === failedStepRecord?.stepNo)
    ?? planSteps.find((step) => isFailedStatus(findStepRecord(runSteps, step.stepNo, activePlanVersion)?.status));
  const failedStepLabel = failedStep ? `步骤 ${failedStep.stepNo}: ${failedStep.name ?? failedStep.tool ?? '未命名步骤'}` : undefined;
  const outputRows = resultRows(currentRun?.output);
  const status = currentRun?.status ?? 'idle';
  const shouldShowApproval = Boolean(currentRun && canAct);

  return (
    <section className="agent-mission-window" aria-label="Agent 任务执行窗口">
      <div className="agent-mission-window__topbar">
        <div className="agent-mission-window__identity">
          <div className="agent-mission-window__eyebrow">Agent Work Window</div>
          <h2>任务执行窗口</h2>
          <p>{currentRun?.goal ?? '新任务会在这里形成规划、待办、执行和总结。'}</p>
        </div>
        <div className="agent-mission-window__status">
          <StatusBadge status={status} />
          <span>{statusLabel(status)}</span>
        </div>
      </div>

      <div className="agent-mission-phases">
        {(Object.keys(PHASE_LABELS) as PhaseKey[]).map((key, index) => (
          <div key={key} className={`agent-mission-phase agent-mission-phase--${phaseStates[key]}`}>
            <span className="agent-mission-phase__mark">{phaseStates[key] === 'done' ? '✓' : index + 1}</span>
            <span className="agent-mission-phase__copy">
              <strong>{PHASE_LABELS[key].title}</strong>
              <small>{PHASE_LABELS[key].caption}</small>
            </span>
          </div>
        ))}
      </div>

      <div className="agent-mission-progress" aria-label={`执行进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <AgentTodoListPanel
        key={`${currentRun?.id ?? 'empty'}-${activePlanVersion}`}
        planSteps={planSteps}
        runSteps={runSteps}
        activePlanVersion={activePlanVersion}
        runStatus={currentRun?.status}
        approvedStepNos={approvedStepNos}
        canApprove={canAct}
        loading={loading}
        onToggleApproval={onToggleApproval}
      />

      <div className="agent-mission-grid">
        <article className="agent-mission-card agent-mission-card--plan">
          <div className="agent-mission-card__head">
            <span>规划</span>
            <strong>{plan ? `v${activePlanVersion}` : '—'}</strong>
          </div>
          {plan ? (
            <>
              <p className="agent-mission-plan-summary">{plan.userVisiblePlan?.summary ?? plan.summary ?? '计划已生成。'}</p>
              {plan.understanding && <p className="agent-mission-plan-understanding">{plan.understanding}</p>}
              <div className="agent-mission-metrics">
                <div>
                  <span>步骤</span>
                  <strong>{planSteps.length}</strong>
                </div>
                <div>
                  <span>置信度</span>
                  <strong>{typeof plan.confidence === 'number' ? `${Math.round(plan.confidence * 100)}%` : '—'}</strong>
                </div>
                <div>
                  <span>风险</span>
                  <strong>{plan.riskReview?.riskLevel ?? '—'}</strong>
                </div>
                {missionChapterProgress && (
                  <div>
                    <span>章节进度</span>
                    <strong>{formatChapterProgress(missionChapterProgress)}</strong>
                  </div>
                )}
              </div>
              {(plan.assumptions?.length || plan.riskReview?.reasons?.length || plan.risks?.length) && (
                <div className="agent-mission-note-list">
                  {(plan.riskReview?.reasons?.length ? plan.riskReview.reasons : plan.risks ?? plan.assumptions ?? []).slice(0, 3).map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <EmptyText text={loading ? '正在生成规划…' : '提交任务后显示 Agent 的理解和计划。'} />
          )}
        </article>

        <article className="agent-mission-card agent-mission-card--execute">
          <div className="agent-mission-card__head">
            <span>执行进度</span>
            <strong>{completedSteps}/{planSteps.length || runSteps.length || 0}</strong>
          </div>
          {runSteps.length ? (
            <div className="agent-mission-runlog">
              {runSteps
                .filter((step) => step.stepNo > 0)
                .slice(0, 8)
                .map((step) => {
                  const tone = stepStatusTone(step.status);
                  const toolName = toolCallName(step);
                  const explanation = agentToolUiExplanation(toolName);
                  const stepArtifacts = artifactsForStep(artifacts, step.stepNo);
                  return (
                    <details key={step.id ?? `${step.mode}-${step.planVersion}-${step.stepNo}`} className={`agent-mission-runlog__item agent-mission-runlog__item--${tone}`}>
                      <summary className="agent-mission-runlog__summary">
                        <span className="agent-mission-runlog__dot" />
                        <span className="agent-mission-runlog__copy">
                          <strong>{step.name ?? `步骤 ${step.stepNo}`}</strong>
                          <small>
                            {statusLabel(step.status)} · {toolName}{step.phase ? ` · ${step.phase}` : ''}
                          </small>
                          {step.phaseMessage && <small className="agent-mission-runlog__route">{step.phaseMessage}</small>}
                          {explanation && <small className="agent-mission-runlog__route">{explanation.output} · {explanation.frontendSurface}</small>}
                        </span>
                        <span className="agent-mission-runlog__detail-label">展开详情</span>
                        {step.finishedAt && <time>{formatDate(step.finishedAt)}</time>}
                        <span className="agent-mission-runlog__chevron">›</span>
                      </summary>
                      <div className="agent-mission-runlog__detail">
                        <div className="agent-mission-runlog__route-grid">
                          <div>
                            <span>生成内容</span>
                            <strong>{explanation?.output ?? expectedArtifactSummary(stepArtifacts)}</strong>
                          </div>
                          <div>
                            <span>前端对应</span>
                            <strong>{explanation?.frontendSurface ?? '未标注前端落点'}</strong>
                          </div>
                          <div>
                            <span>耗时</span>
                            <strong>{durationText(step.startedAt, step.finishedAt, step.status)}</strong>
                          </div>
                          <div>
                            <span>阶段</span>
                            <strong>{phaseProgressText(step) || '—'}</strong>
                          </div>
                          <div>
                            <span>错误码</span>
                            <strong>{stepErrorText(step) || '—'}</strong>
                          </div>
                        </div>
                        <div className="agent-mission-runlog__detail-grid">
                          <div className="agent-tool-call-detail">
                            <h4>入参摘要</h4>
                            <SummaryRows value={step.input} emptyText="没有记录入参。" />
                          </div>
                          <div className="agent-tool-call-detail">
                            <h4>输出摘要</h4>
                            <SummaryRows value={step.output} emptyText="没有记录输出。" />
                          </div>
                          <div className="agent-tool-call-detail">
                            <h4>错误</h4>
                            {step.error ? <pre className="agent-tool-call-error">{safeJson(step.error)}</pre> : <div className="agent-tool-call-empty">无错误。</div>}
                          </div>
                        </div>
                        <details className="agent-mission-runlog__raw">
                          <summary>原始记录</summary>
                          <pre>{safeJson({ stepNo: step.stepNo, tool: toolName, phase: step.phase, input: step.input, output: step.output, error: step.error, metadata: step.metadata })}</pre>
                        </details>
                      </div>
                    </details>
                  );
                })}
            </div>
          ) : planSteps.length ? (
            <div className="agent-mission-queue">
              {planSteps.slice(0, 6).map((step) => (
                <span key={step.stepNo}>{step.stepNo}. {step.name ?? step.tool}</span>
              ))}
            </div>
          ) : (
            <EmptyText text={loading ? '正在准备执行记录…' : '确认执行后显示工具调用进度。'} />
          )}
        </article>

        <article className={`agent-mission-card agent-mission-card--summary ${currentRun?.status === 'failed' ? 'agent-mission-card--danger' : ''}`}>
          <div className="agent-mission-card__head">
            <span>最后总结</span>
            <strong>{latestArtifactTitle(currentRun)}</strong>
          </div>
          {currentRun?.error ? (
            <div className="agent-mission-error">
              <strong>{failedStep ? `失败步骤：${failedStep.name ?? failedStep.stepNo}` : '执行失败'}</strong>
              <pre>{safeJson(currentRun.error)}</pre>
              {canRetry && failedStepRecord?.mode === 'plan' && (
                <div className="agent-mission-resume">
                  <span>可从{failedStepLabel ?? '失败步骤'}重新生成预览，写入仍会停在审批前。</span>
                  <button type="button" onClick={() => void onRetry()} disabled={loading}>
                    从失败步骤重新开始
                  </button>
                </div>
              )}
            </div>
          ) : outputRows.length ? (
            <dl className="agent-mission-result-list">
              {outputRows.map((row) => (
                <div key={row.key}>
                  <dt>{row.key}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="agent-mission-summary-empty">
              <strong>{statusLabel(status)}</strong>
              <span>{currentRun ? `${currentRun.artifacts?.length ?? 0} 个产物，${runSteps.length} 条工具记录` : '尚未开始'}</span>
            </div>
          )}
        </article>
      </div>

      <ToolCallsPanel steps={runSteps} artifacts={artifacts} />

      <AgentObservationPanel run={currentRun} loading={loading} onAnswerClarification={onAnswerClarification} />

      {shouldShowApproval && (
        <AgentApprovalDialog
          canAct={canAct}
          canRetry={canRetry}
          loading={loading}
          status={currentRun?.status}
          hasCurrentRun={!!currentRun}
          plan={plan}
          riskSummary={riskSummary}
          failedStepLabel={failedStepLabel}
          failedStepMode={failedStepRecord?.mode}
          onCancel={onCancel}
          onRetry={onRetry}
          onAct={onAct}
        />
      )}

      <details className="agent-mission-advanced">
        <summary>
          <span>产物、审计与原始输出</span>
          <strong>{(currentRun?.artifacts?.length ?? 0) + auditEvents.length}</strong>
        </summary>
        <div className="agent-mission-advanced__body">
          <AgentArtifactPanel
            run={currentRun}
            query={artifactQuery}
            onQueryChange={onArtifactQueryChange}
            onRequestWorldbuildingPersistSelection={onRequestWorldbuildingPersistSelection}
            onRequestImportTargetRegeneration={onRequestImportTargetRegeneration}
            actionDisabled={loading}
          />
          <AgentAuditPanel events={auditEvents} />
          <AgentResultPanel output={currentRun?.output} error={currentRun?.error} />
        </div>
      </details>
    </section>
  );
}
