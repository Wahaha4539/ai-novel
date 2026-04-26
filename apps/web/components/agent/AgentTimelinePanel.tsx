'use client';

import { AgentPlanPayload, AgentRunStepRecord } from '../../hooks/useAgentRun';
import { EmptyText } from './AgentSharedWidgets';

interface AgentTimelinePanelProps {
  steps: AgentRunStepRecord[];
  plan?: AgentPlanPayload;
  planVersion: number;
  approvedStepNos: number[];
  onToggleApproval: (stepNo: number) => void;
}

/** 执行时间线面板：按 Plan 步骤展示执行状态与审批勾选 */
export function AgentTimelinePanel({ steps, plan, planVersion, approvedStepNos, onToggleApproval }: AgentTimelinePanelProps) {
  const planSteps = plan?.steps ?? [];

  return (
    <section className="agent-panel-section">
      <h2 className="text-sm font-bold mb-4" style={{ color: 'var(--text-main)' }}>执行时间线</h2>
      <div className="space-y-3">
        {planSteps.length ? planSteps.map((step) => {
          const sameStepRecords = steps.filter((item) => item.stepNo === step.stepNo && (item.planVersion ?? 1) === planVersion);
          const record = sameStepRecords.find((item) => item.mode === 'act') ?? sameStepRecords.find((item) => item.mode === 'plan');
          const approved = approvedStepNos.includes(step.stepNo);
          return (
            <div key={step.stepNo} className="p-3" style={{ borderRadius: '0.9rem', border: `1px solid ${step.requiresApproval ? 'rgba(251,191,36,0.38)' : 'var(--border-dim)'}`, background: record ? 'rgba(6,182,212,0.06)' : step.requiresApproval ? 'rgba(251,191,36,0.06)' : 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-main)' }}>{step.stepNo}. {step.name}</div>
                <span className="text-xs" style={{ color: step.requiresApproval ? '#fbbf24' : 'var(--text-dim)' }}>{record?.status ?? (step.requiresApproval ? '需审批' : '待执行')}{record?.mode ? ` · ${record.mode}` : ''}</span>
              </div>
              {step.requiresApproval && <div className="mt-2 text-[11px] leading-5" style={{ color: '#fbbf24' }}>风险提示：此步骤可能写入草稿、事实层、记忆或项目资料；取消勾选则后端不会把该步骤视为已审批。</div>}
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{step.tool}</div>
                {step.requiresApproval && <label className="inline-flex items-center gap-2 text-xs" style={{ color: approved ? '#86efac' : 'var(--text-dim)' }}><input type="checkbox" checked={approved} onChange={() => onToggleApproval(step.stepNo)} />审批此步</label>}
              </div>
            </div>
          );
        }) : <EmptyText text="暂无步骤。" />}
      </div>
    </section>
  );
}
