'use client';

import { AgentPlanPayload, AgentPlanRecord, AgentRun } from '../../hooks/useAgentRun';
import { EmptyText, ListBlock, Metric, normalizePlan, planVersionLabel } from './AgentSharedWidgets';

// ────────────────────────────────────────────
// Plan 版本 diff 对比
// ────────────────────────────────────────────

/** 对比最新两版 Plan 的步骤差异，提供新增/移除/审批变化计数 */
function buildPlanVersionDiff(plans: NonNullable<AgentRun['plans']>) {
  if (plans.length < 2) return null;
  const [latest, previous] = plans;
  const latestPlanPayload = normalizePlan(latest);
  const previousPlanPayload = normalizePlan(previous);
  const latestSteps = latestPlanPayload.steps ?? [];
  const previousSteps = previousPlanPayload.steps ?? [];
  const latestKeys = new Set(latestSteps.map((step) => `${step.stepNo}:${step.tool ?? ''}`));
  const previousKeys = new Set(previousSteps.map((step) => `${step.stepNo}:${step.tool ?? ''}`));
  const added = [...latestKeys].filter((key) => !previousKeys.has(key)).length;
  const removed = [...previousKeys].filter((key) => !latestKeys.has(key)).length;
  const approvalChanged = Math.abs(
    (latestPlanPayload.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? []).length -
    (previousPlanPayload.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? []).length,
  );
  return { added, removed, approvalChanged };
}

// ────────────────────────────────────────────
// PlanPanel 组件
// ────────────────────────────────────────────

interface AgentPlanPanelProps {
  run: AgentRun | null;
  plan?: AgentPlanPayload;
}

/** 计划简报面板：展示 Plan 摘要、假设/风险、版本 diff 指标 */
export function AgentPlanPanel({ run, plan }: AgentPlanPanelProps) {
  const plans = [...(run?.plans ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  const diff = buildPlanVersionDiff(plans);

  return (
    <section className="agent-panel-section">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>计划简报</h2>
        {/* 多版本时展示版本切换标签 */}
        {plans.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {plans.slice(0, 4).map((item: AgentPlanRecord, index: number) => (
              <span
                key={item.id}
                className="px-2 py-1 text-[10px]"
                style={{
                  borderRadius: '999px',
                  border: `1px solid ${index === 0 ? 'rgba(103,232,249,0.45)' : 'var(--border-dim)'}`,
                  color: index === 0 ? '#67e8f9' : 'var(--text-dim)',
                }}
              >
                {planVersionLabel(item)}
              </span>
            ))}
          </div>
        )}
      </div>

      {plan ? (
        <>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{plan.summary}</p>
          {/* Plan 版本差异指标 */}
          {diff && (
            <div className="mb-4 grid gap-2 md:grid-cols-3">
              <Metric label="新增步骤" value={diff.added} tone={diff.added ? 'warn' : undefined} />
              <Metric label="移除步骤" value={diff.removed} tone={diff.removed ? 'warn' : undefined} />
              <Metric label="审批变化" value={diff.approvalChanged} tone={diff.approvalChanged ? 'danger' : 'ok'} />
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <ListBlock title="假设" items={plan.assumptions ?? []} />
            <ListBlock title="风险/规则" items={plan.risks ?? []} />
          </div>
        </>
      ) : (
        <EmptyText text="提交任务后，这里会显示 Agent 的理解、假设和风险。" />
      )}
    </section>
  );
}
