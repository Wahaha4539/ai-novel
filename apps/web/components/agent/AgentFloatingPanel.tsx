'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AgentPageContext, type AgentRunStepRecord, useAgentRun } from '../../hooks/useAgentRun';
import { getCreativeDocumentExtension, uploadCreativeDocument } from '../../lib/uploadCreativeDocument';
import { AgentInputBox, type AgentInputSubmitOptions, type ChatMessage, type CreativeDocumentAttachmentItem } from './AgentInputBox';
import { AgentMissionWindow } from './AgentMissionWindow';
import { AgentRunHistoryPanel } from './AgentRunHistoryPanel';
import { PROJECT_IMPORT_ASSET_LABELS, StatusBadge, approvalRiskSummary, latestPlan, latestPlanVersion, type ProjectImportAssetType } from './AgentSharedWidgets';

type PanelTab = 'task' | 'detail' | 'history';
type AgentMode = 'plan' | 'act';

interface AgentFloatingPanelProps {
  projectId: string;
  selectedChapterId?: string;
  pageContext?: AgentPageContext;
  onRefresh?: () => void | Promise<void>;
  onClose: () => void;
  /** 复用外部已创建的 useAgentRun 实例，避免重复状态 */
  agentHook: ReturnType<typeof useAgentRun>;
  /** 圆球位置，用于计算面板弹出方向 */
  orbPosition: { x: number; y: number };
}

/** Tab 配置 */
const TABS: { key: PanelTab; label: string }[] = [
  { key: 'task', label: '任务' },
  { key: 'detail', label: '执行窗口' },
  { key: 'history', label: '历史' },
];

function areSameStepNos(left: number[], right: number[]) {
  return left.length === right.length && left.every((stepNo, index) => stepNo === right[index]);
}

/**
 * Agent 悬浮详情面板。
 * 从圆球旁弹出，按 Tab 分为"任务输入"、"执行详情"、"历史"三个区域。
 * 面板位置根据圆球所在象限动态计算，确保始终在视口内。
 */
export function AgentFloatingPanel({
  projectId,
  selectedChapterId,
  pageContext: externalPageContext,
  onRefresh,
  onClose,
  agentHook,
  orbPosition,
}: AgentFloatingPanelProps) {
  const {
    currentRun, runHistory, auditEvents, loading, error,
    actionMessage, createPlan, interpretMessage, act, retry, replan, answerClarification, refresh,
    cancel, listByProject, loadAudit, startNewSession,
  } = agentHook;

  const [activeTab, setActiveTab] = useState<PanelTab>('task');
  const [goal, setGoal] = useState('');
  const [approvedStepNos, setApprovedStepNos] = useState<number[]>([]);
  const [artifactQuery, setArtifactQuery] = useState('');
  // Plan 模式：生成计划后等待审批；Act 模式：生成计划后自动执行全部步骤
  const [agentMode, setAgentMode] = useState<AgentMode>('plan');
  /** 聊天消息历史 — 记录用户发送的指令和 Agent 的回复 */
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [creativeDocumentAttachments, setCreativeDocumentAttachments] = useState<CreativeDocumentAttachmentItem[]>([]);
  /** 自增 ID 计数器，保证消息唯一性 */
  const msgIdCounter = useRef(0);
  const attachmentIdCounter = useRef(0);

  const plan = useMemo(() => latestPlan(currentRun), [currentRun]);
  const activePlanVersion = useMemo(() => latestPlanVersion(currentRun), [currentRun]);
  const approvalStepNos = useMemo(
    () => plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [],
    [plan],
  );

  // 审批/执行/重试条件
  const canAct = !!currentRun && (currentRun.status === 'waiting_approval' || currentRun.status === 'waiting_review');
  const canRetry = !!currentRun && currentRun.status === 'failed';
  const canReplan = !!currentRun && !['planning', 'acting', 'running'].includes(currentRun.status);
  const riskSummary = useMemo(() => approvalRiskSummary(plan, approvedStepNos), [plan, approvedStepNos]);
  const uploadedCreativeDocumentAttachments = useMemo(
    () => creativeDocumentAttachments.flatMap((item) => (item.status === 'uploaded' && item.attachment ? [item.attachment] : [])),
    [creativeDocumentAttachments],
  );
  const hasUploadingCreativeDocument = creativeDocumentAttachments.some((item) => item.status === 'uploading');
  const approvedScope = useMemo(() => {
    // 全选审批项表示整份计划已审批；不传具体 step 范围，避免新增后置 Tool 后 retry 被旧范围卡住。
    if (approvalStepNos.length && approvalStepNos.every((stepNo) => approvedStepNos.includes(stepNo))) return undefined;
    return approvedStepNos.length ? approvedStepNos : undefined;
  }, [approvalStepNos, approvedStepNos]);
  const pageContext = useMemo(
    () => ({
      currentProjectId: projectId,
      currentChapterId: selectedChapterId,
      sourcePage: 'agent_floating_panel',
      ...(externalPageContext ?? {}),
    }),
    [projectId, selectedChapterId, externalPageContext],
  );

  // 项目切换时拉取最近 AgentRun
  useEffect(() => {
    void listByProject(projectId);
  }, [listByProject, projectId]);

  // 默认勾选计划要求审批的步骤
  useEffect(() => {
    setApprovedStepNos((current) => (areSameStepNos(current, approvalStepNos) ? current : approvalStepNos));
  }, [approvalStepNos]);

  // ── 事件处理 ──

  const handleAct = useCallback(async () => {
    if (!currentRun) return;
    await act(currentRun.id, approvedScope);
    await onRefresh?.();
  }, [currentRun, act, approvedScope, onRefresh]);

  /** 向聊天历史追加一条消息 */
  const pushMessage = useCallback((role: ChatMessage['role'], content: string) => {
    msgIdCounter.current += 1;
    const msg: ChatMessage = { id: `msg-${msgIdCounter.current}`, role, content, timestamp: Date.now() };
    setChatHistory((prev) => [...prev, msg]);
  }, []);

  const handleSubmit = useCallback(async (submitOptions?: AgentInputSubmitOptions) => {
    const message = goal.trim();
    if (!message || loading) return;
    if (hasUploadingCreativeDocument) {
      pushMessage('system', '创意文档仍在上传中，请稍后再发送。');
      return;
    }
    const requestContext = submitOptions?.requestedAssetTypes?.length || submitOptions?.importPreviewMode
      ? { ...pageContext, ...(submitOptions.requestedAssetTypes?.length ? { requestedAssetTypes: submitOptions.requestedAssetTypes } : {}), ...(submitOptions.importPreviewMode ? { importPreviewMode: submitOptions.importPreviewMode } : {}) }
      : pageContext;
    // 立即将用户消息推入聊天历史并清空输入框，模拟即时发送效果
    pushMessage('user', message);
    if (uploadedCreativeDocumentAttachments.length) {
      pushMessage('system', `已导入创意文档：${uploadedCreativeDocumentAttachments.map((item) => item.fileName).join('、')}`);
    }
    setGoal('');
    // 等待审批时先请求 LLM 判定用户回复意图；只有 LLM 明确判定为确认时才执行写入类工具。
    if (canAct && currentRun) {
      const intent = await interpretMessage(currentRun.id, message);
      if (intent.shouldExecute) {
        pushMessage('agent', '已确认执行，正在调用工具…');
        setActiveTab('detail');
        await handleAct();
        return;
      }
      const run = await createPlan(projectId, message, requestContext, uploadedCreativeDocumentAttachments);
      if (run?.id) {
        pushMessage('agent', '已收到新任务，正在生成计划…');
        setActiveTab('detail');
      }
      return;
    }

    const run = await createPlan(projectId, message, requestContext, uploadedCreativeDocumentAttachments);
    if (run) {
      pushMessage('agent', '已收到任务，正在生成计划…');
    }
    setActiveTab('detail');
    // Act 模式：计划生成后自动审批执行全部步骤，跳过人工审批环节。
    if (agentMode === 'act' && run?.id && (run.status === 'waiting_approval' || run.status === 'waiting_review')) {
      const allStepNos = run.plans
        ?.flatMap((p) => (p.plan?.steps ?? p.steps ?? []).map((s) => s.stepNo))
        .filter((n): n is number => typeof n === 'number') ?? [];
      await act(run.id, allStepNos.length ? allStepNos : undefined);
      await onRefresh?.();
    }
  }, [goal, loading, hasUploadingCreativeDocument, uploadedCreativeDocumentAttachments, canAct, currentRun, interpretMessage, handleAct, createPlan, projectId, pageContext, agentMode, act, onRefresh, pushMessage]);

  const handleCreativeDocumentSelect = useCallback(async (file: File) => {
    attachmentIdCounter.current += 1;
    const localId = `creative-doc-${Date.now().toString(36)}-${attachmentIdCounter.current}`;
    const draftAttachment: CreativeDocumentAttachmentItem = {
      id: localId,
      fileName: file.name,
      extension: getCreativeDocumentExtension(file.name) ?? undefined,
      size: file.size,
      status: 'uploading',
    };
    setCreativeDocumentAttachments([draftAttachment]);

    try {
      const attachment = await uploadCreativeDocument(file);
      setCreativeDocumentAttachments((current) =>
        current.map((item) =>
          item.id === localId
            ? {
                ...item,
                fileName: attachment.fileName,
                extension: attachment.extension,
                size: attachment.size,
                status: 'uploaded',
                attachment,
                error: undefined,
              }
            : item,
        ),
      );
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : '创意文档上传失败，请稍后重试。';
      setCreativeDocumentAttachments((current) =>
        current.map((item) => (item.id === localId ? { ...item, status: 'failed', error: message } : item)),
      );
    }
  }, []);

  const handleCreativeDocumentRemove = useCallback((id: string) => {
    setCreativeDocumentAttachments((current) => current.filter((item) => item.id !== id));
  }, []);

  const handleRetry = useCallback(async () => {
    if (!currentRun) return;
    await retry(currentRun.id, approvedScope);
    await onRefresh?.();
  }, [currentRun, retry, approvedScope, onRefresh]);

  const handleReplan = useCallback(async () => {
    if (!currentRun) return;
    await replan(currentRun.id, goal.trim() || undefined);
    await listByProject(projectId);
  }, [currentRun, replan, goal, listByProject, projectId]);

  const handleClarification = useCallback(async (choice: Parameters<typeof answerClarification>[1]) => {
    if (!currentRun) return;
    await answerClarification(currentRun.id, choice);
    await listByProject(projectId);
    setActiveTab('detail');
  }, [answerClarification, currentRun, listByProject, projectId]);

  const handleWorldbuildingPersistSelection = useCallback(async (titles: string[]) => {
    if (!currentRun || !titles.length) return;
    // Artifact 勾选只表达“用户选择了哪些标题”，实际 persist_worldbuilding 仍通过重新规划和审批执行。
    const message = [
      `用户已在世界观预览中选择要写入的设定条目：${titles.join('、')}。`,
      `系统上下文 selectedTitles：${JSON.stringify(titles)}`,
      '请基于当前世界观预览和校验结果重新生成可审批计划；persist_worldbuilding 必须使用这些 selectedTitles，只写入被选择条目，不要绕过 validate_worldbuilding 或审批。',
    ].join('\n');
    pushMessage('user', `选择写入世界观设定：${titles.join('、')}`);
    await replan(currentRun.id, message, { worldbuildingSelection: { selectedTitles: titles } });
    await listByProject(projectId);
    setActiveTab('detail');
  }, [currentRun, listByProject, projectId, pushMessage, replan]);

  const handleImportTargetRegeneration = useCallback(async (assetType: ProjectImportAssetType) => {
    if (!currentRun) return;
    const label = PROJECT_IMPORT_ASSET_LABELS[assetType] ?? assetType;
    pushMessage('user', `重新生成${label}`);
    await replan(currentRun.id, `用户请求只重新生成${label}预览；保留其他已选择目标产物预览，写入仍需审批。`, { importTargetRegeneration: { assetType } });
    await listByProject(projectId);
    setActiveTab('detail');
  }, [currentRun, listByProject, projectId, pushMessage, replan]);

  const handleToggleApproval = useCallback((stepNo: number) => {
    setApprovedStepNos((current) =>
      current.includes(stepNo) ? current.filter((n) => n !== stepNo) : [...current, stepNo].sort((a, b) => a - b),
    );
  }, []);

  /**
   * 新增会话只重置前端工作区上下文，后端 Run 历史仍保留在“历史”页中可重新选择。
   * 这样用户可以在待审批/已完成 Run 之外，快速开始一条干净的新聊天线。
   */
  const handleNewSession = useCallback(() => {
    startNewSession();
    setGoal('');
    setApprovedStepNos([]);
    setArtifactQuery('');
    setChatHistory([]);
    setCreativeDocumentAttachments([]);
    setActiveTab('task');
  }, [startNewSession]);

  // ── 面板定位 ──
  // 根据圆球位置决定面板在左上/左下/右上/右下弹出
  const panelStyle = useMemo(() => {
    const panelWidth = Math.min(860, Math.max(420, window.innerWidth - 32));
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
            Agent 工作台
            <StatusBadge status={currentRun?.status ?? 'idle'} />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="agent-new-session-btn"
              onClick={handleNewSession}
              disabled={loading}
              title="清空当前聊天上下文并开始新会话"
            >
              <span aria-hidden="true">＋</span>
              新会话
            </button>
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
              canAct={canAct}
              plan={plan}
              runSteps={currentRun?.steps ?? []}
              activePlanVersion={activePlanVersion}
              runStatus={currentRun?.status}
              actionMessage={actionMessage}
              currentRunGoal={currentRun?.goal}
              riskSummary={riskSummary}
              chatHistory={chatHistory}
              creativeDocumentAttachments={creativeDocumentAttachments}
              onGoalChange={setGoal}
              onSubmit={handleSubmit}
              onReplan={handleReplan}
              onRefresh={async () => { if (currentRun) await refresh(currentRun.id); }}
              onCreativeDocumentSelect={handleCreativeDocumentSelect}
              onCreativeDocumentRemove={handleCreativeDocumentRemove}
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
              onAnswerClarification={handleClarification}
              onRequestWorldbuildingPersistSelection={handleWorldbuildingPersistSelection}
              onRequestImportTargetRegeneration={handleImportTargetRegeneration}
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
  canAct?: boolean; plan?: ReturnType<typeof latestPlan>; currentRunGoal?: string; riskSummary?: string[];
  runSteps?: AgentRunStepRecord[];
  activePlanVersion?: number;
  runStatus?: string;
  actionMessage?: string;
  chatHistory?: ChatMessage[];
  creativeDocumentAttachments?: CreativeDocumentAttachmentItem[];
  onGoalChange: (v: string) => void; onSubmit: (options?: AgentInputSubmitOptions) => void | Promise<void>;
  onReplan: () => void | Promise<void>; onRefresh: () => void | Promise<void>;
  onCreativeDocumentSelect?: (file: File) => void | Promise<void>;
  onCreativeDocumentRemove?: (id: string) => void;
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
  onAnswerClarification: (choice: Parameters<ReturnType<typeof useAgentRun>['answerClarification']>[1]) => void | Promise<void>;
  onRequestWorldbuildingPersistSelection: (titles: string[]) => void | Promise<void>;
  onRequestImportTargetRegeneration: (assetType: ProjectImportAssetType) => void | Promise<void>;
}) {
  return (
    <AgentMissionWindow
      currentRun={props.currentRun}
      plan={props.plan}
      activePlanVersion={props.activePlanVersion}
      approvedStepNos={props.approvedStepNos}
      canAct={props.canAct}
      canRetry={props.canRetry}
      loading={props.loading}
      riskSummary={props.riskSummary}
      artifactQuery={props.artifactQuery}
      auditEvents={props.auditEvents}
      onToggleApproval={props.onToggleApproval}
      onArtifactQueryChange={props.onArtifactQueryChange}
      onCancel={props.onCancel}
      onRetry={props.onRetry}
      onAct={props.onAct}
      onAnswerClarification={props.onAnswerClarification}
      onRequestWorldbuildingPersistSelection={props.onRequestWorldbuildingPersistSelection}
      onRequestImportTargetRegeneration={props.onRequestImportTargetRegeneration}
    />
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
