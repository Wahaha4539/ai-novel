'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentRun } from '../../hooks/useAgentRun';
import { AgentApprovalDialog } from './AgentApprovalDialog';
import { AgentInputBox } from './AgentInputBox';
import { AgentPlanPanel } from './AgentPlanPanel';
import { AgentTimelinePanel } from './AgentTimelinePanel';
import { AgentArtifactPanel } from './AgentArtifactPanel';
import { AgentAuditPanel } from './AgentAuditPanel';
import { AgentResultPanel } from './AgentResultPanel';
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
  const { currentRun, runHistory, auditEvents, loading, error, actionMessage, createPlan, act, retry, replan, refresh, cancel, listByProject, loadAudit } = useAgentRun();
  const [goal, setGoal] = useState('');
  const [approvedStepNos, setApprovedStepNos] = useState<number[]>([]);
  const [artifactQuery, setArtifactQuery] = useState('');
  const plan = latestPlan(currentRun);
  const activePlanVersion = latestPlanVersion(currentRun);
  const approvalStepNos = useMemo(() => plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [], [plan]);
  const canAct = !!currentRun && (currentRun.status === 'waiting_approval' || currentRun.status === 'waiting_review');
  const canRetry = !!currentRun && (currentRun.status === 'failed' || currentRun.status === 'waiting_review');
  const canReplan = !!currentRun && currentRun.status !== 'acting' && currentRun.status !== 'running';
  const riskSummary = useMemo(() => approvalRiskSummary(plan, approvedStepNos), [plan, approvedStepNos]);

  useEffect(() => { void listByProject(projectId); }, [listByProject, projectId]);
  useEffect(() => { setApprovedStepNos(approvalStepNos); }, [approvalStepNos]);

  const handleSubmit = useCallback(async () => { if (!goal.trim() || loading) return; await createPlan(projectId, goal.trim(), selectedChapterId); }, [goal, loading, createPlan, projectId, selectedChapterId]);
  const handleAct = useCallback(async () => { if (!currentRun) return; await act(currentRun.id, approvalStepNos.length ? approvedStepNos : undefined); await onRefresh?.(); }, [currentRun, act, approvalStepNos, approvedStepNos, onRefresh]);
  const handleRetry = useCallback(async () => { if (!currentRun) return; await retry(currentRun.id, approvalStepNos.length ? approvedStepNos : undefined); await onRefresh?.(); }, [currentRun, retry, approvalStepNos, approvedStepNos, onRefresh]);
  const handleReplan = useCallback(async () => { if (!currentRun) return; await replan(currentRun.id, goal.trim() || undefined); await listByProject(projectId); }, [currentRun, replan, goal, listByProject, projectId]);

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
            {actionMessage && <div className="mt-3 text-sm" style={{ color: '#ccfbf1' }}>{actionMessage}</div>}
            {error && <div className="mt-3 text-sm" style={{ color: 'var(--status-err)' }}>{error}</div>}
          </div>
        </header>

        <section className="grid gap-5 xl:grid-cols-[430px_1fr]">
          <div className="space-y-5">
            <AgentInputBox goal={goal} loading={loading} canReplan={canReplan} hasCurrentRun={!!currentRun} onGoalChange={setGoal} onSubmit={handleSubmit} onReplan={handleReplan} onRefresh={async () => { if (currentRun) await refresh(currentRun.id); }} />
            <AgentRunHistoryPanel runs={runHistory} currentRunId={currentRun?.id} loading={loading} onRefresh={async () => { await listByProject(projectId); }} onSelect={async (id) => { await refresh(id); await loadAudit(id); }} />
          </div>
          <div className="space-y-5">
            <AgentPlanPanel run={currentRun} plan={plan} />
            <div className="grid gap-5 lg:grid-cols-2">
              <AgentTimelinePanel steps={currentRun?.steps ?? []} plan={plan} planVersion={activePlanVersion} approvedStepNos={approvedStepNos} onToggleApproval={(stepNo) => setApprovedStepNos((current) => (current.includes(stepNo) ? current.filter((item) => item !== stepNo) : [...current, stepNo].sort((a, b) => a - b)))} />
              <AgentArtifactPanel run={currentRun} query={artifactQuery} onQueryChange={setArtifactQuery} />
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