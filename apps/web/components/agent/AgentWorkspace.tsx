'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentRun } from '../../hooks/useAgentRun';
import { getCreativeDocumentExtension, uploadCreativeDocument } from '../../lib/uploadCreativeDocument';
import { AgentInputBox, type AgentInputSubmitOptions, type ChatMessage, type CreativeDocumentAttachmentItem } from './AgentInputBox';
import { AgentMissionWindow } from './AgentMissionWindow';
import { AgentRunHistoryPanel } from './AgentRunHistoryPanel';
import { PROJECT_IMPORT_ASSET_LABELS, StatusBadge, approvalRiskSummary, latestPlan, latestPlanVersion, type ProjectImportAssetType } from './AgentSharedWidgets';

interface AgentWorkspaceProps {
  projectId: string;
  selectedChapterId?: string;
  onRefresh?: () => void | Promise<void>;
}

function areSameStepNos(left: number[], right: number[]) {
  return left.length === right.length && left.every((stepNo, index) => stepNo === right[index]);
}

/**
 * Agent Workspace 全屏布局组件（备用入口）。
 * 主入口已迁移至 AgentFloatingOrb，此组件保留以支持全屏 Agent 视图场景。
 */
export function AgentWorkspace({ projectId, selectedChapterId, onRefresh }: AgentWorkspaceProps) {
  const { currentRun, runHistory, auditEvents, loading, error, actionMessage, createPlan, interpretMessage, act, retry, replan, answerClarification, refresh, cancel, listByProject, loadAudit, startNewSession } = useAgentRun();
  const [goal, setGoal] = useState('');
  const [approvedStepNos, setApprovedStepNos] = useState<number[]>([]);
  const [artifactQuery, setArtifactQuery] = useState('');
  /** 聊天消息历史 */
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [creativeDocumentAttachments, setCreativeDocumentAttachments] = useState<CreativeDocumentAttachmentItem[]>([]);
  const refreshedRunKeyRef = useRef<string | null>(null);
  const msgIdCounter = useRef(0);
  const attachmentIdCounter = useRef(0);
  const plan = useMemo(() => latestPlan(currentRun), [currentRun]);
  const activePlanVersion = useMemo(() => latestPlanVersion(currentRun), [currentRun]);
  const approvalStepNos = useMemo(() => plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [], [plan]);
  const canAct = !!currentRun && (currentRun.status === 'waiting_approval' || currentRun.status === 'waiting_review');
  const canRetry = !!currentRun && currentRun.status === 'failed';
  const canReplan = !!currentRun && !['planning', 'acting', 'running'].includes(currentRun.status);
  const riskSummary = useMemo(
    () => (canAct || canRetry ? approvalRiskSummary(plan, approvedStepNos) : []),
    [canAct, canRetry, plan, approvedStepNos],
  );
  const uploadedCreativeDocumentAttachments = useMemo(
    () => creativeDocumentAttachments.flatMap((item) => (item.status === 'uploaded' && item.attachment ? [item.attachment] : [])),
    [creativeDocumentAttachments],
  );
  const hasUploadingCreativeDocument = creativeDocumentAttachments.some((item) => item.status === 'uploading');
  const approvedScope = useMemo(() => {
    // 全部要求审批的步骤均已勾选时，不传具体范围，让后端按“整份计划已审批”处理。
    // 这样可避免新增后置质量门禁后，旧审批范围导致 retry/act 误判后续 Tool 未审批。
    if (approvalStepNos.length && approvalStepNos.every((stepNo) => approvedStepNos.includes(stepNo))) return undefined;
    return approvedStepNos.length ? approvedStepNos : undefined;
  }, [approvalStepNos, approvedStepNos]);
  const pageContext = useMemo(() => ({ currentProjectId: projectId, currentChapterId: selectedChapterId, sourcePage: 'agent_workspace' }), [projectId, selectedChapterId]);

  useEffect(() => { void listByProject(projectId); }, [listByProject, projectId]);
  useEffect(() => {
    if (!canAct) {
      setApprovedStepNos((current) => (current.length ? [] : current));
      return;
    }
    setApprovedStepNos((current) => (areSameStepNos(current, approvalStepNos) ? current : approvalStepNos));
  }, [approvalStepNos, canAct]);

  useEffect(() => {
    if (!currentRun || currentRun.status !== 'succeeded') return;
    const refreshKey = `${currentRun.id}:${currentRun.updatedAt ?? ''}`;
    if (refreshedRunKeyRef.current === refreshKey) return;
    refreshedRunKeyRef.current = refreshKey;
    void onRefresh?.();
  }, [currentRun?.id, currentRun?.status, currentRun?.updatedAt, onRefresh]);

  const handleAct = useCallback(async () => { if (!currentRun) return; await act(currentRun.id, approvedScope); await onRefresh?.(); }, [currentRun, act, approvedScope, onRefresh]);

  /** 向聊天历史追加消息 */
  const pushMessage = useCallback((role: ChatMessage['role'], content: string) => {
    msgIdCounter.current += 1;
    setChatHistory((prev) => [...prev, { id: `msg-${msgIdCounter.current}`, role, content, timestamp: Date.now() }]);
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
    // 立即推入用户消息并清空输入框
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
        await handleAct();
        return;
      }
      const run = await createPlan(projectId, message, requestContext, uploadedCreativeDocumentAttachments);
      if (run) pushMessage('agent', '已收到新任务，正在生成计划…');
      return;
    }
    const run = await createPlan(projectId, message, requestContext, uploadedCreativeDocumentAttachments);
    if (run) pushMessage('agent', '已收到任务，正在生成计划…');
  }, [goal, loading, hasUploadingCreativeDocument, uploadedCreativeDocumentAttachments, canAct, currentRun, interpretMessage, handleAct, createPlan, projectId, pageContext, pushMessage]);

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
  const handleRetry = useCallback(async () => { if (!currentRun) return; await retry(currentRun.id, approvedScope); await onRefresh?.(); }, [currentRun, retry, approvedScope, onRefresh]);
  const handleReplan = useCallback(async () => { if (!currentRun) return; await replan(currentRun.id, goal.trim() || undefined); await listByProject(projectId); }, [currentRun, replan, goal, listByProject, projectId]);
  const handleClarification = useCallback(async (choice: Parameters<typeof answerClarification>[1]) => {
    if (!currentRun) return;
    await answerClarification(currentRun.id, choice);
    await listByProject(projectId);
  }, [answerClarification, currentRun, listByProject, projectId]);

  const handleWorldbuildingPersistSelection = useCallback(async (titles: string[]) => {
    if (!currentRun || !titles.length) return;
    // 复用安全的 replan 入口表达用户显式选择；真正写入仍由新计划审批后执行，避免 Artifact 按钮直接绕过审批。
    const message = [
      `用户已在世界观预览中选择要写入的设定条目：${titles.join('、')}。`,
      `系统上下文 selectedTitles：${JSON.stringify(titles)}`,
      '请基于当前世界观预览和校验结果重新生成可审批计划；persist_worldbuilding 必须使用这些 selectedTitles，只写入被选择条目，不要绕过 validate_worldbuilding 或审批。',
    ].join('\n');
    pushMessage('user', `选择写入世界观设定：${titles.join('、')}`);
    await replan(currentRun.id, message, { worldbuildingSelection: { selectedTitles: titles } });
    await listByProject(projectId);
  }, [currentRun, listByProject, projectId, pushMessage, replan]);

  const handleImportTargetRegeneration = useCallback(async (assetType: ProjectImportAssetType) => {
    if (!currentRun) return;
    const label = PROJECT_IMPORT_ASSET_LABELS[assetType] ?? assetType;
    pushMessage('user', `重新生成${label}`);
    await replan(currentRun.id, `用户请求只重新生成${label}预览；保留其他已选择目标产物预览，写入仍需审批。`, { importTargetRegeneration: { assetType } });
    await listByProject(projectId);
  }, [currentRun, listByProject, projectId, pushMessage, replan]);

  /** 新增会话：清空当前全屏工作台的本地输入、聊天记录和选中 Run，不影响后端历史。 */
  const handleNewSession = useCallback(() => {
    startNewSession();
    setGoal('');
    setApprovedStepNos([]);
    setArtifactQuery('');
    setChatHistory([]);
    setCreativeDocumentAttachments([]);
  }, [startNewSession]);

  return (
    <div className="agent-workspace-stage">
      <div className="agent-workspace-window">
        <header className="agent-workspace-window__header">
          <div>
            <div className="agent-workspace-window__eyebrow">Agent Ops Console</div>
            <h1>创作 Agent 工作台</h1>
            <p>每个任务都会沉淀为规划、待办、执行和总结，写入类步骤仍保留确认边界。</p>
          </div>
          <div className="agent-workspace-window__meta">
            <StatusBadge status={currentRun?.status ?? 'idle'} />
            <span>Run ID：{currentRun?.id ?? '尚未创建'}</span>
            <span>上下文：项目 {projectId.slice(0, 8)}{selectedChapterId ? ` · 章节 ${selectedChapterId.slice(0, 8)}` : ' · 全书范围'}</span>
            <button type="button" className="agent-new-session-btn" onClick={handleNewSession} disabled={loading} title="清空当前聊天上下文并开始新会话">
              <span aria-hidden="true">＋</span>
              新会话
            </button>
          </div>
        </header>

        {(actionMessage || error) && (
          <div className={`agent-workspace-window__notice ${error ? 'agent-workspace-window__notice--error' : ''}`}>
            {error || actionMessage}
          </div>
        )}

        <section className="agent-workspace-window__body">
          <aside className="agent-workspace-window__chat">
            <AgentInputBox
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
            <AgentRunHistoryPanel
              runs={runHistory}
              currentRunId={currentRun?.id}
              loading={loading}
              onRefresh={async () => { await listByProject(projectId); }}
              onSelect={async (id) => { await refresh(id); await loadAudit(id); }}
            />
          </aside>

          <AgentMissionWindow
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
            onToggleApproval={(stepNo) => setApprovedStepNos((current) => (current.includes(stepNo) ? current.filter((item) => item !== stepNo) : [...current, stepNo].sort((a, b) => a - b)))}
            onArtifactQueryChange={setArtifactQuery}
            onCancel={async () => { if (currentRun) await cancel(currentRun.id); }}
            onRetry={handleRetry}
            onAct={handleAct}
            onAnswerClarification={handleClarification}
            onRequestWorldbuildingPersistSelection={handleWorldbuildingPersistSelection}
            onRequestImportTargetRegeneration={handleImportTargetRegeneration}
          />
        </section>
      </div>
    </div>
  );
}
