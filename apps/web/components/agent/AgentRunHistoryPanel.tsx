'use client';

import { AgentRunListItem } from '../../hooks/useAgentRun';
import { EmptyText, formatDate } from './AgentSharedWidgets';

interface AgentRunHistoryPanelProps {
  runs: AgentRunListItem[];
  currentRunId?: string;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  onSelect: (id: string) => void | Promise<void>;
}

/** 状态对应的颜色与标签 */
function statusMeta(status?: string): { color: string; label: string } {
  if (status === 'succeeded') return { color: '#22c55e', label: '成功' };
  if (status === 'failed')    return { color: '#ef4444', label: '失败' };
  if (status === 'cancelled') return { color: 'var(--text-dim)', label: '已取消' };
  if (status === 'waiting_approval' || status === 'waiting_review') return { color: '#f59e0b', label: '待审批' };
  if (status === 'acting' || status === 'running') return { color: 'var(--agent-accent)', label: '执行中' };
  return { color: 'var(--agent-text-label)', label: status ?? 'idle' };
}

/** 历史 Run 列表面板：展示最近 8 条 AgentRun，支持点选切换 */
export function AgentRunHistoryPanel({ runs, currentRunId, loading, onRefresh, onSelect }: AgentRunHistoryPanelProps) {
  return (
    <section className="agent-panel-section">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>历史 Run</h2>
        <button
          type="button"
          disabled={loading}
          onClick={() => void onRefresh()}
          className="agent-approval-btn agent-approval-btn--ghost"
          style={{ padding: '0.35rem 0.75rem', fontSize: '0.72rem', borderColor: 'var(--agent-border)' }}
        >
          🔄 刷新
        </button>
      </div>
      {runs.length ? (
        <div className="space-y-2">
          {runs.slice(0, 8).map((run) => {
            const isCurrent = run.id === currentRunId;
            const meta = statusMeta(run.status);
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => void onSelect(run.id)}
                className="agent-history-item"
                style={{
                  borderColor: isCurrent ? 'color-mix(in srgb, var(--agent-accent) 45%, var(--agent-border))' : undefined,
                  background: isCurrent ? 'color-mix(in srgb, var(--agent-accent) 8%, transparent)' : undefined,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold" style={{ color: 'var(--text-main)' }}>
                    {run.taskType ?? run.agentType ?? 'agent_run'}
                  </span>
                  {/* 状态标签 */}
                  <span
                    className="agent-history-item__status"
                    style={{ color: meta.color, borderColor: `${meta.color}44`, background: `${meta.color}12` }}
                  >
                    <span className="agent-history-item__dot" style={{ background: meta.color }} />
                    {meta.label}
                  </span>
                </div>
                <div className="mt-2 line-clamp-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{run.goal}</div>
                <div className="mt-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                  {formatDate(run.updatedAt ?? run.createdAt)} · {run.id.slice(0, 8)}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyText text="暂无历史 Run。" />
      )}
    </section>
  );
}
