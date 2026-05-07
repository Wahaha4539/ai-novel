'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentPlanPayload } from '../../hooks/useAgentRun';
import { planWriteInfo } from './AgentSharedWidgets';

interface AgentApprovalDialogProps {
  canAct: boolean;
  canRetry: boolean;
  loading: boolean;
  status?: string;
  hasCurrentRun: boolean;
  plan?: AgentPlanPayload;
  riskSummary?: string[];
  failedStepLabel?: string;
  failedStepMode?: string;
  onCancel: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onAct: () => void | Promise<void>;
}

/**
 * AgentApprovalDialog 集中展示写入审批、取消和失败重试操作。
 * 使用 agent-panel-section 保持与其他面板一致的卡片风格，
 * 按钮使用 CSS 类以统一主题适配。
 */
export function AgentApprovalDialog({ canAct, canRetry, loading, status, hasCurrentRun, plan, riskSummary = [], failedStepLabel, failedStepMode, onCancel, onRetry, onAct }: AgentApprovalDialogProps) {
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const retryPreviewOnly = canRetry && failedStepMode === 'plan';
  const requiresSecondConfirm = canAct || (canRetry && !retryPreviewOnly);
  const [secondConfirmed, setSecondConfirmed] = useState(false);
  const writeInfo = useMemo(() => planWriteInfo(plan), [plan]);
  const scopeText = writeInfo.projectImportAssetLabels.length ? writeInfo.projectImportAssetLabels.join('、') : '当前导入预览中的项目资产';
  const writeStepText = writeInfo.writeToolLabels.length ? writeInfo.writeToolLabels.join('、') : '写入步骤';
  const approvalTitle = retryPreviewOnly ? '失败步骤恢复' : writeInfo.hasWriteSteps ? '写入确认' : '审批控制台';
  const approvalDescription = writeInfo.hasProjectImportWrite
    ? `这是写入确认。确认后会把导入预览写入当前项目：${scopeText}。未被选择的目标产物不会写入。`
    : writeInfo.hasWriteSteps
      ? `这是写入确认。确认后会执行当前计划中的写入步骤：${writeStepText}。`
      : writeInfo.requiredStepNos.length
        ? '当前计划需要审批，但不包含项目资产写入步骤。确认后只会执行已勾选的校验、分析或高风险步骤，不会写入项目资产。'
        : '当前计划没有待确认的写入步骤；可以查看预览结果，或重新规划。';
  const checkboxLabel = writeInfo.hasProjectImportWrite
    ? '我确认将上述目标产物写入当前项目。'
    : writeInfo.hasWriteSteps
      ? '我确认执行上述写入步骤。'
      : '我确认继续执行当前需审批步骤。';
  const confirmationSignature = [status, failedStepLabel, failedStepMode, writeInfo.writeTools.join(','), writeInfo.projectImportAssetLabels.join(','), riskSummary.join('\n')].join('|');
  const retryDescription = retryPreviewOnly
    ? `会复用已完成步骤，从${failedStepLabel ?? '失败步骤'}重新生成预览；写入步骤仍会停在审批前。`
    : failedStepLabel
      ? `会复用已完成步骤，并从${failedStepLabel}继续执行。`
      : '会复用已完成步骤，并从失败步骤继续执行。';

  useEffect(() => {
    setSecondConfirmed(false);
  }, [confirmationSignature]);

  const actionDisabled = loading || (requiresSecondConfirm && !secondConfirmed);
  /** 没有任何可操作项时隐藏整个区域 */
  if (!hasCurrentRun) return null;

  return (
    <section
      className="agent-panel-section"
      style={{
        borderColor: canAct ? 'color-mix(in srgb, var(--agent-accent) 40%, var(--agent-border))' : undefined,
      }}
    >
      {/* 标题行 — 标题 + 状态指示 */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>
          {approvalTitle}
        </h2>
        {canAct && (
          <span className="agent-approval-ready-dot" aria-label="等待审批">
            <span className="agent-approval-ready-dot__pulse" />
          </span>
        )}
      </div>

      {/* 说明文字 */}
      <p className="text-xs leading-5 mb-3" style={{ color: 'var(--text-muted)' }}>
        {canRetry ? retryDescription : approvalDescription}
      </p>

      {/* 显式二次确认入口：避免把普通“执行”误解为已确认事实层覆盖/删除风险。 */}
      {requiresSecondConfirm && (
        <label className="mb-3 flex items-start gap-2 text-xs leading-5" style={{ color: secondConfirmed ? '#86efac' : 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={secondConfirmed}
            onChange={(event) => setSecondConfirmed(event.target.checked)}
            disabled={loading}
            className="mt-1"
          />
          <span>{checkboxLabel}</span>
        </label>
      )}

      {writeInfo.hasWriteSteps && (
        <div className="mb-3 grid gap-2 text-xs leading-5">
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--agent-border)', background: 'var(--agent-glass)', color: 'var(--text-muted)' }}>
            写入步骤：<span style={{ color: 'var(--text-main)' }}>{writeStepText}</span>
          </div>
          {writeInfo.hasProjectImportWrite && (
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--agent-border)', background: 'var(--agent-glass)', color: 'var(--text-muted)' }}>
              目标产物：<span style={{ color: 'var(--text-main)' }}>{scopeText}</span>
            </div>
          )}
        </div>
      )}

      {/* 风险摘要清单 */}
      {riskSummary.length > 0 && (
        <ul className="agent-approval-risks">
          {riskSummary.map((item) => (
            <li key={item}>
              <span className="agent-approval-risks__icon" aria-hidden="true">⚠</span>
              {item}
            </li>
          ))}
        </ul>
      )}

      {/* 操作按钮组 — 统一圆角胶囊样式 */}
      <div className="agent-approval-actions">
        <button
          type="button"
          onClick={() => void onCancel()}
          disabled={loading || terminal}
          className="agent-approval-btn agent-approval-btn--ghost agent-approval-btn--danger"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void onRetry()}
          disabled={!canRetry || actionDisabled}
          className="agent-approval-btn agent-approval-btn--ghost agent-approval-btn--warn"
        >
          {status === 'waiting_review' ? '补充确认' : retryPreviewOnly ? '从失败步骤重新开始' : '从失败步骤继续执行'}
        </button>
        <button
          type="button"
          onClick={() => void onAct()}
          disabled={!canAct || actionDisabled}
          className="agent-approval-btn agent-approval-btn--primary"
        >
          {loading ? (
            <>
              <span className="agent-approval-btn__spinner" aria-hidden="true" />
              执行中…
            </>
          ) : (
            status === 'waiting_review' ? '✓ 二次确认并继续' : writeInfo.hasWriteSteps ? '✓ 确认写入' : '✓ 确认执行'
          )}
        </button>
      </div>
    </section>
  );
}
