'use client';

import { useEffect, useState } from 'react';

interface AgentApprovalDialogProps {
  canAct: boolean;
  canRetry: boolean;
  loading: boolean;
  status?: string;
  hasCurrentRun: boolean;
  riskSummary?: string[];
  onCancel: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onAct: () => void | Promise<void>;
}

/**
 * AgentApprovalDialog 集中展示写入审批、取消和失败重试操作。
 * 使用 agent-panel-section 保持与其他面板一致的卡片风格，
 * 按钮使用 CSS 类以统一主题适配。
 */
export function AgentApprovalDialog({ canAct, canRetry, loading, status, hasCurrentRun, riskSummary = [], onCancel, onRetry, onAct }: AgentApprovalDialogProps) {
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const requiresSecondConfirm = canAct || canRetry;
  const [secondConfirmed, setSecondConfirmed] = useState(false);

  useEffect(() => {
    setSecondConfirmed(false);
  }, [status, riskSummary.join('\n')]);

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
          审批控制台
        </h2>
        {canAct && (
          <span className="agent-approval-ready-dot" aria-label="等待审批">
            <span className="agent-approval-ready-dot__pulse" />
          </span>
        )}
      </div>

      {/* 说明文字 */}
      <p className="text-xs leading-5 mb-3" style={{ color: 'var(--text-muted)' }}>
        确认后会执行计划中的写入、校验或记忆回写步骤；此操作同时作为高风险/事实覆盖/删除类副作用的二次确认。
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
          <span>我已阅读风险提示，并确认允许执行高风险、事实层覆盖或删除类副作用步骤。</span>
        </label>
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
          {status === 'waiting_review' ? '补充确认' : '失败重试'}
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
            status === 'waiting_review' ? '✓ 二次确认并继续' : '✓ 确认执行'
          )}
        </button>
      </div>
    </section>
  );
}