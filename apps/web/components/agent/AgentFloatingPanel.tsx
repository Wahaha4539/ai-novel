'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentRun } from '../../hooks/useAgentRun';
import { AgentInputBox } from './AgentInputBox';
import { AgentApprovalDialog } from './AgentApprovalDialog';
import { AgentPlanPanel } from './AgentPlanPanel';
import { AgentTimelinePanel } from './AgentTimelinePanel';
import { AgentArtifactPanel } from './AgentArtifactPanel';
import { AgentAuditPanel } from './AgentAuditPanel';
import { AgentResultPanel } from './AgentResultPanel';
import { AgentRunHistoryPanel } from './AgentRunHistoryPanel';
import { StatusBadge, approvalRiskSummary, latestPlan, latestPlanVersion } from './AgentSharedWidgets';

type PanelTab = 'task' | 'detail' | 'history';
type AgentMode = 'plan' | 'act';

interface AgentFloatingPanelProps {
  projectId: string;
  selectedChapterId?: string;
  onRefresh?: () => void | Promise<void>;
  onClose: () => void;
  /** 复用外部已创建的 useAgentRun 实例，避免重复状态 */
  agentHook: ReturnType<typeof useAgentRun>;
  /** 圆球位置，用于计算面板弹出方向 */
  orbPosition: { x: number; y: number };
}

/** Tab 配置 */
const TABS: { key: PanelTab; label: string }[] = [
  { key: 'task', label: '📝 任务' },
  { key: 'detail', label: '⚙️ 详情' },
  { key: 'history', label: '📋 历史' },
];

/**
 * Agent 悬浮详情面板。
 * 从圆球旁弹出，按 Tab 分为"任务输入"、"执行详情"、"历史"三个区域。
 * 面板位置根据圆球所在象限动态计算，确保始终在视口内。
 */
export function AgentFloatingPanel({
  projectId,
  selectedChapterId,
  onRefresh,
  onClose,
  agentHook,
  orbPosition,
}: AgentFloatingPanelProps) {
  const {
    currentRun, runHistory, auditEvents, loading, error,
    actionMessage, createPlan, act, retry, replan, refresh,
    cancel, listByProject, loadAudit,
  } = agentHook;

  const [activeTab, setActiveTab] = useState<PanelTab>('task');
  const [goal, setGoal] = useState('');
  const [approvedStepNos, setApprovedStepNos] = useState<number[]>([]);
  const [artifactQuery, setArtifactQuery] = useState('');
  // Plan 模式：生成计划后等待审批；Act 模式：生成计划后自动执行全部步骤
  const [agentMode, setAgentMode] = useState<AgentMode>('plan');

  const plan = latestPlan(currentRun);
  const activePlanVersion = latestPlanVersion(currentRun);
  const approvalStepNos = useMemo(
    () => plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [],
    [plan],
  );

  // 审批/执行/重试条件
  const canAct = !!currentRun && (currentRun.status === 'waiting_approval' || currentRun.status === 'waiting_review');
  const canRetry = !!currentRun && (currentRun.status === 'failed' || currentRun.status === 'waiting_review');
  const canReplan = !!currentRun && currentRun.status !== 'acting' && currentRun.status !== 'running';
  const riskSummary = useMemo(() => approvalRiskSummary(plan, approvedStepNos), [plan, approvedStepNos]);

  // 项目切换时拉取最近 AgentRun
  useEffect(() => {
    void listByProject(projectId);
  }, [listByProject, projectId]);

  // 默认勾选计划要求审批的步骤
  useEffect(() => {
    setApprovedStepNos(approvalStepNos);
  }, [approvalStepNos]);

  // ── 事件处理 ──

  const handleSubmit = useCallback(async () => {
    if (!goal.trim() || loading) return;
    const run = await createPlan(projectId, goal.trim(), selectedChapterId);
    setActiveTab('detail');
    // Act 模式：计划生成后自动审批执行全部步骤，跳过人工审批环节
    if (agentMode === 'act' && run?.id) {
      const allStepNos = run.plans
        ?.flatMap((p) => (p.plan?.steps ?? p.steps ?? []).map((s) => s.stepNo))
        .filter((n): n is number => typeof n === 'number') ?? [];
      await act(run.id, allStepNos.length ? allStepNos : undefined);
      await onRefresh?.();
    }
  }, [goal, loading, createPlan, projectId, selectedChapterId, agentMode, act, onRefresh]);

  const handleAct = useCallback(async () => {
    if (!currentRun) return;
    await act(currentRun.id, approvalStepNos.length ? approvedStepNos : undefined);
    await onRefresh?.();
  }, [currentRun, act, approvalStepNos, approvedStepNos, onRefresh]);

  const handleRetry = useCallback(async () => {
    if (!currentRun) return;
    await retry(currentRun.id, approvalStepNos.length ? approvedStepNos : undefined);
    await onRefresh?.();
  }, [currentRun, retry, approvalStepNos, approvedStepNos, onRefresh]);

  const handleReplan = useCallback(async () => {
    if (!currentRun) return;
    await replan(currentRun.id, goal.trim() || undefined);
    await listByProject(projectId);
  }, [currentRun, replan, goal, listByProject, projectId]);

  const handleToggleApproval = useCallback((stepNo: number) => {
    setApprovedStepNos((current) =>
      current.includes(stepNo) ? current.filter((n) => n !== stepNo) : [...current, stepNo].sort((a, b) => a - b),
    );
  }, []);

  // ── 面板定位 ──
  // 根据圆球位置决定面板在左上/左下/右上/右下弹出
  const panelStyle = useMemo(() => {
    const panelWidth = 500;
    const panelMargin = 16;
    const orbCenterX = orbPosition.x + 30;
    const orbCenterY = orbPosition.y + 30;
    const style: React.CSSProperties = {};
    // 水平定位
    if (orbCenterX > window.innerWidth / 2) {
      style.right = Math.max(panelMargin, window.innerWidth - orbPosition.x + panelMargin);
    } else {
      style.left = Math.max(panelMargin, orbPosition.x + 60 + panelMargin);
    }
    // 垂直定位
    if (orbCenterY > window.innerHeight / 2) {
      style.bottom = Math.max(panelMargin, window.innerHeight - orbPosition.y - 60);
    } else {
      style.top = Math.max(panelMargin, orbPosition.y);
    }
    // 防止水平溢出
    if (style.left !== undefined && (style.left as number) + panelWidth > window.innerWidth) {
      style.left = Math.max(panelMargin, window.innerWidth - panelWidth - panelMargin);
    }
    return style;
  }, [orbPosition]);

  return (
    <>
      {/* 透明遮罩：点击关闭面板 */}
      <div className="agent-float-backdrop" onClick={onClose} />

      {/* 面板主体 */}
      <div className="agent-float-panel agent-float-panel--enter" style={panelStyle}>
        {/* 头部 */}
        <div className="agent-float-panel__header">
          <div className="agent-float-panel__title">
            <span>🧠</span>
            Agent 工作台
            <StatusBadge status={currentRun?.status ?? 'idle'} />
          </div>
          <div className="flex items-center gap-2">
            {/* Plan / Act 模式切换器 */}
            <AgentModeToggle mode={agentMode} onChange={setAgentMode} />
            <button type="button" className="agent-float-panel__close" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
        </div>

        {/* Tab 切换栏 */}
        <div className="agent-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`agent-tab ${activeTab === tab.key ? 'agent-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 状态栏 */}
        {(actionMessage || error) && (
          <div className="agent-float-panel__status">
            {error && <div className="text-xs" style={{ color: 'var(--status-err)' }}>{error}</div>}
            {actionMessage && !error && <div className="text-xs" style={{ color: 'var(--agent-text-accent)' }}>{actionMessage}</div>}
          </div>
        )}

        {/* 滚动内容区 */}
        <div className="agent-float-panel__body">
          {activeTab === 'task' && (
            <TaskTabContent
              goal={goal}
              loading={loading}
              canReplan={canReplan}
              hasCurrentRun={!!currentRun}
              onGoalChange={setGoal}
              onSubmit={handleSubmit}
              onReplan={handleReplan}
              onRefresh={async () => { if (currentRun) await refresh(currentRun.id); }}
            />
          )}

          {activeTab === 'detail' && (
            <DetailTabContent
              currentRun={currentRun}
              plan={plan}
              activePlanVersion={activePlanVersion}
              approvedStepNos={approvedStepNos}
              canAct={canAct}
              canRetry={canRetry}
              loading={loading}
              riskSummary={riskSummary}
              artifactQuery={artifactQuery}
              auditEvents={auditEvents}
              onToggleApproval={handleToggleApproval}
              onArtifactQueryChange={setArtifactQuery}
              onCancel={async () => { if (currentRun) await cancel(currentRun.id); }}
              onRetry={handleRetry}
              onAct={handleAct}
            />
          )}

          {activeTab === 'history' && (
            <HistoryTabContent
              runs={runHistory}
              currentRunId={currentRun?.id}
              loading={loading}
              projectId={projectId}
              onRefresh={async () => { await listByProject(projectId); }}
              onSelect={async (id) => { await refresh(id); await loadAudit(id); setActiveTab('detail'); }}
            />
          )}
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────
// Tab 内容子组件 — 保持主组件行数精简
// ────────────────────────────────────────────

/** 任务输入 Tab */
function TaskTabContent(props: {
  goal: string; loading: boolean; canReplan: boolean; hasCurrentRun: boolean;
  onGoalChange: (v: string) => void; onSubmit: () => void | Promise<void>;
  onReplan: () => void | Promise<void>; onRefresh: () => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <AgentInputBox {...props} />
    </div>
  );
}

/** 执行详情 Tab */
function DetailTabContent(props: {
  currentRun: ReturnType<typeof useAgentRun>['currentRun'];
  plan: ReturnType<typeof latestPlan>;
  activePlanVersion: number;
  approvedStepNos: number[];
  canAct: boolean; canRetry: boolean; loading: boolean;
  riskSummary: string[];
  artifactQuery: string;
  auditEvents: ReturnType<typeof useAgentRun>['auditEvents'];
  onToggleApproval: (stepNo: number) => void;
  onArtifactQueryChange: (v: string) => void;
  onCancel: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onAct: () => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <AgentPlanPanel run={props.currentRun} plan={props.plan} />
      <AgentTimelinePanel
        steps={props.currentRun?.steps ?? []}
        plan={props.plan}
        planVersion={props.activePlanVersion}
        approvedStepNos={props.approvedStepNos}
        onToggleApproval={props.onToggleApproval}
      />
      <AgentApprovalDialog
        canAct={props.canAct}
        canRetry={props.canRetry}
        loading={props.loading}
        status={props.currentRun?.status}
        hasCurrentRun={!!props.currentRun}
        riskSummary={props.riskSummary}
        onCancel={props.onCancel}
        onRetry={props.onRetry}
        onAct={props.onAct}
      />
      <AgentArtifactPanel run={props.currentRun} query={props.artifactQuery} onQueryChange={props.onArtifactQueryChange} />
      <AgentAuditPanel events={props.auditEvents} />
      <AgentResultPanel output={props.currentRun?.output} error={props.currentRun?.error} />
    </div>
  );
}

/** 历史记录 Tab */
function HistoryTabContent(props: {
  runs: ReturnType<typeof useAgentRun>['runHistory'];
  currentRunId?: string; loading: boolean; projectId: string;
  onRefresh: () => void | Promise<void>;
  onSelect: (id: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <AgentRunHistoryPanel
        runs={props.runs}
        currentRunId={props.currentRunId}
        loading={props.loading}
        onRefresh={props.onRefresh}
        onSelect={props.onSelect}
      />
    </div>
  );
}

// ────────────────────────────────────────────
// Plan / Act 模式切换器
// ────────────────────────────────────────────

/**
 * 胶囊型分段控件：Plan（先审批再执行）/ Act（生成即执行）。
 * 滑块通过 CSS transform 跟随活动项平移，营造流畅切换手感。
 */
function AgentModeToggle({ mode, onChange }: { mode: AgentMode; onChange: (m: AgentMode) => void }) {
  const isAct = mode === 'act';
  return (
    <div className="agent-mode-toggle" role="radiogroup" aria-label="Agent 执行模式">
      {/* 滑块指示器 */}
      <span
        className="agent-mode-toggle__slider"
        style={{ transform: isAct ? 'translateX(100%)' : 'translateX(0)' }}
      />
      <button
        type="button"
        role="radio"
        aria-checked={!isAct}
        className={`agent-mode-toggle__btn ${!isAct ? 'agent-mode-toggle__btn--active' : ''}`}
        onClick={() => onChange('plan')}
      >
        Plan
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={isAct}
        className={`agent-mode-toggle__btn ${isAct ? 'agent-mode-toggle__btn--active' : ''}`}
        onClick={() => onChange('act')}
      >
        Act
      </button>
    </div>
  );
}
