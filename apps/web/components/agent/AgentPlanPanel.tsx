'use client';

import { AgentPlanPayload, AgentPlanRecord, AgentRun } from '../../hooks/useAgentRun';
import { EmptyText, ListBlock, Metric, normalizePlan, planVersionLabel, projectImportTargetSources } from './AgentSharedWidgets';

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

/** 从 agent_plan_preview Artifact 合并 V2 字段，弥补 AgentPlan 表只存摘要/步骤的兼容限制。 */
function enrichPlanFromPreviewArtifact(run: AgentRun | null, plan?: AgentPlanPayload): AgentPlanPayload | undefined {
  if (!plan) return undefined;
  const preview = [...(run?.artifacts ?? [])].reverse().find((artifact) => artifact.artifactType === 'agent_plan_preview');
  const content = preview?.content && typeof preview.content === 'object' ? (preview.content as AgentPlanPayload) : undefined;
  return content ? { ...plan, ...content, steps: plan.steps ?? content.steps, requiredApprovals: plan.requiredApprovals ?? content.requiredApprovals } : plan;
}

/** 计划简报面板：展示 Agent 理解、假设、缺失信息、风险和用户可读步骤。 */
export function AgentPlanPanel({ run, plan }: AgentPlanPanelProps) {
  const plans = [...(run?.plans ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  const diff = buildPlanVersionDiff(plans);
  const displayPlan = enrichPlanFromPreviewArtifact(run, plan);
  const importTargetSources = projectImportTargetSources(displayPlan);

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

      {displayPlan ? (
        <>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{displayPlan.userVisiblePlan?.summary ?? displayPlan.summary}</p>
          <div className="mb-4 grid gap-2 md:grid-cols-3">
            <Metric label="任务类型" value={run?.taskType ?? '未识别'} />
            <Metric label="置信度" value={typeof displayPlan.confidence === 'number' ? `${Math.round(displayPlan.confidence * 100)}%` : '—'} tone={typeof displayPlan.confidence === 'number' && displayPlan.confidence >= 0.85 ? 'ok' : undefined} />
            <Metric label="风险等级" value={displayPlan.riskReview?.riskLevel ?? '—'} tone={displayPlan.riskReview?.riskLevel === 'high' ? 'danger' : displayPlan.riskReview?.riskLevel === 'medium' ? 'warn' : 'ok'} />
          </div>
          {importTargetSources.length > 0 && (
            <div className="mb-4 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--agent-border)', background: 'var(--agent-glass)' }}>
              <div className="mb-2 text-xs font-bold" style={{ color: 'var(--agent-text-label)' }}>目标产物来源</div>
              <div className="flex flex-wrap gap-2">
                {importTargetSources.map((source) => (
                  <span
                    key={source.assetType}
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs"
                    style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)', background: 'rgba(15,23,42,0.18)' }}
                  >
                    <span style={{ color: 'var(--text-main)' }}>{source.label}</span>由
                    <code className="text-[11px]" style={{ color: '#67e8f9' }}>{source.tool}</code>
                    生成
                  </span>
                ))}
              </div>
            </div>
          )}
          {displayPlan.understanding && (
            <div className="mb-4 p-3" style={{ borderRadius: '0.75rem', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(103,232,249,0.22)' }}>
              <div className="text-xs font-bold mb-2" style={{ color: '#67e8f9' }}>Agent 的理解</div>
              <div className="text-xs leading-6" style={{ color: 'var(--text-muted)' }}>{displayPlan.understanding}</div>
            </div>
          )}
          {/* Plan 版本差异指标 */}
          {diff && (
            <div className="mb-4 grid gap-2 md:grid-cols-3">
              <Metric label="新增步骤" value={diff.added} tone={diff.added ? 'warn' : undefined} />
              <Metric label="移除步骤" value={diff.removed} tone={diff.removed ? 'warn' : undefined} />
              <Metric label="审批变化" value={diff.approvalChanged} tone={diff.approvalChanged ? 'danger' : 'ok'} />
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <ListBlock title="假设" items={displayPlan.assumptions ?? []} />
            <ListBlock title="用户可读步骤" items={displayPlan.userVisiblePlan?.bullets ?? []} />
            <ListBlock title="缺失信息" items={(displayPlan.missingInfo ?? []).map((item) => `${item.field ?? '未知字段'}：${item.reason ?? ''}${item.resolverTool ? `（可由 ${item.resolverTool} 解析）` : ''}`)} />
            <ListBlock title="需要的上下文" items={(displayPlan.requiredContext ?? []).map((item) => `${item.name ?? '上下文'}：${item.reason ?? ''}`)} />
            <ListBlock title="风险/规则" items={displayPlan.riskReview?.reasons?.length ? displayPlan.riskReview.reasons : (displayPlan.risks ?? [])} />
          </div>
          {displayPlan.riskReview?.approvalMessage && <p className="mt-3 text-xs leading-5" style={{ color: '#fef3c7' }}>{displayPlan.riskReview.approvalMessage}</p>}
        </>
      ) : (
        <EmptyText text="提交任务后，这里会显示 Agent 的理解、假设和风险。" />
      )}
    </section>
  );
}
