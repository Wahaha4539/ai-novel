'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentRun } from '../../hooks/useAgentRun';
import { getCreativeDocumentExtension, uploadCreativeDocument } from '../../lib/uploadCreativeDocument';
import { AgentApprovalDialog } from './AgentApprovalDialog';
import { AgentInputBox, type ChatMessage, type CreativeDocumentAttachmentItem } from './AgentInputBox';
import { AgentPlanPanel } from './AgentPlanPanel';
import { AgentTimelinePanel } from './AgentTimelinePanel';
import { AgentArtifactPanel } from './AgentArtifactPanel';
import { AgentAuditPanel } from './AgentAuditPanel';
import { AgentResultPanel } from './AgentResultPanel';
import { AgentObservationPanel } from './AgentObservationPanel';
import { AgentRunHistoryPanel } from './AgentRunHistoryPanel';
import { StatusBadge, approvalRiskSummary, latestPlan, latestPlanVersion } from './AgentSharedWidgets';

interface AgentWorkspaceProps {
  projectId: string;
  selectedChapterId?: string;
  onRefresh?: () => void | Promise<void>;
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
  const msgIdCounter = useRef(0);
  const attachmentIdCounter = useRef(0);
  const plan = latestPlan(currentRun);
  const activePlanVersion = latestPlanVersion(currentRun);
  const approvalStepNos = useMemo(() => plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [], [plan]);
  const canAct = !!currentRun && (currentRun.status === 'waiting_approval' || currentRun.status === 'waiting_review');
  const canRetry = !!currentRun && currentRun.status === 'failed';
  const canReplan = !!currentRun && currentRun.status !== 'acting' && currentRun.status !== 'running';
  const riskSummary = useMemo(() => approvalRiskSummary(plan, approvedStepNos), [plan, approvedStepNos]);
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
  useEffect(() => { setApprovedStepNos(approvalStepNos); }, [approvalStepNos]);

  const handleAct = useCallback(async () => { if (!currentRun) return; await act(currentRun.id, approvedScope); await onRefresh?.(); }, [currentRun, act, approvedScope, onRefresh]);

  /** 向聊天历史追加消息 */
  const pushMessage = useCallback((role: ChatMessage['role'], content: string) => {
    msgIdCounter.current += 1;
    setChatHistory((prev) => [...prev, { id: `msg-${msgIdCounter.current}`, role, content, timestamp: Date.now() }]);
  }, []);

  const handleSubmit = useCallback(async () => {
    const message = goal.trim();
    if (!message || loading) return;
    if (hasUploadingCreativeDocument) {
      pushMessage('system', '创意文档仍在上传中，请稍后再发送。');
      return;
    }
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
      const run = await createPlan(projectId, message, pageContext, uploadedCreativeDocumentAttachments);
      if (run) pushMessage('agent', '已收到新任务，正在生成计划…');
      return;
    }
    const run = await createPlan(projectId, message, pageContext, uploadedCreativeDocumentAttachments);
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
    <div className="h-full overflow-hidden" style={{ background: 'radial-gradient(circle at 20% 0%, rgba(6,182,212,0.13), transparent 32%), radial-gradient(circle at 90% 10%, rgba(245,158,11,0.10), transparent 26%), var(--bg-primary)' }}>
      <div className="h-full overflow-y-auto px-8 py-7">
        <header className="mb-7 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="panel p-6" style={{ borderColor: 'rgba(6,182,212,0.22)', background: 'linear-gradient(135deg, rgba(5,10,18,0.78), rgba(15,23,42,0.48))' }}>
            <div className="text-xs font-bold mb-3" style={{ color: '#67e8f9', letterSpacing: '0.24em', textTransform: 'uppercase' }}>AGENT OPS CONSOLE</div>
            <h1 className="text-3xl font-black mb-3" style={{ color: 'var(--text-main)' }}>创作 Agent 工作台</h1>
            <p className="text-sm leading-7" style={{ color: 'var(--text-muted)' }}>用自然语言提出章节写作、大纲设计或文案拆解任务。Agent 会先生成可审阅计划，只有确认后才执行写入类工具。</p>
          </div>
          <div className="panel p-5 flex flex-col justify-between" style={{ background: 'rgba(0,0,0,0.22)' }}>
            <div className="text-xs font-bold mb-3" style={{ color: 'var(--text-dim)', letterSpacing: '0.16em' }}>CURRENT RUN</div>
            <StatusBadge status={currentRun?.status ?? 'idle'} />
            <div className="mt-4 text-xs break-all" style={{ color: 'var(--text-dim)' }}>Run ID：{currentRun?.id ?? '尚未创建'}</div>
            <button type="button" className="agent-new-session-btn mt-4 w-fit" onClick={handleNewSession} disabled={loading} title="清空当前聊天上下文并开始新会话">
              <span aria-hidden="true">＋</span>
              新增会话
            </button>
            {actionMessage && <div className="mt-3 text-sm" style={{ color: '#ccfbf1' }}>{actionMessage}</div>}
            {error && <div className="mt-3 text-sm" style={{ color: 'var(--status-err)' }}>{error}</div>}
            <div className="mt-4 rounded-xl border px-3 py-2 text-xs leading-5" style={{ borderColor: 'var(--agent-border)', color: 'var(--text-dim)', background: 'var(--agent-glass)' }}>
              当前上下文：项目 {projectId.slice(0, 8)}{selectedChapterId ? ` · 当前章节 ${selectedChapterId.slice(0, 8)}` : ' · 未选中章节'}
            </div>
          </div>
        </header>

        <section className="grid gap-5 xl:grid-cols-[430px_1fr]">
          <div className="space-y-5">
            <AgentInputBox goal={goal} loading={loading} canReplan={canReplan} hasCurrentRun={!!currentRun} canAct={canAct} plan={plan} currentRunGoal={currentRun?.goal} riskSummary={riskSummary} chatHistory={chatHistory} creativeDocumentAttachments={creativeDocumentAttachments} onGoalChange={setGoal} onSubmit={handleSubmit} onReplan={handleReplan} onRefresh={async () => { if (currentRun) await refresh(currentRun.id); }} onCreativeDocumentSelect={handleCreativeDocumentSelect} onCreativeDocumentRemove={handleCreativeDocumentRemove} />
            <AgentRunHistoryPanel runs={runHistory} currentRunId={currentRun?.id} loading={loading} onRefresh={async () => { await listByProject(projectId); }} onSelect={async (id) => { await refresh(id); await loadAudit(id); }} />
          </div>
          <div className="space-y-5">
            <AgentPlanPanel run={currentRun} plan={plan} />
            <AgentObservationPanel run={currentRun} loading={loading} onAnswerClarification={handleClarification} />
            <div className="grid gap-5 lg:grid-cols-2">
              <AgentTimelinePanel steps={currentRun?.steps ?? []} plan={plan} planVersion={activePlanVersion} approvedStepNos={approvedStepNos} onToggleApproval={(stepNo) => setApprovedStepNos((current) => (current.includes(stepNo) ? current.filter((item) => item !== stepNo) : [...current, stepNo].sort((a, b) => a - b)))} />
              <AgentArtifactPanel run={currentRun} query={artifactQuery} onQueryChange={setArtifactQuery} onRequestWorldbuildingPersistSelection={handleWorldbuildingPersistSelection} actionDisabled={loading} />
            </div>
            <AgentAuditPanel events={auditEvents} />
            <AgentApprovalDialog canAct={canAct} canRetry={canRetry} loading={loading} status={currentRun?.status} hasCurrentRun={!!currentRun} riskSummary={riskSummary} onCancel={async () => { if (currentRun) await cancel(currentRun.id); }} onRetry={handleRetry} onAct={handleAct} />
            <AgentResultPanel output={currentRun?.output} error={currentRun?.error} />
          </div>
        </section>
      </div>
    </div>
  );
}
