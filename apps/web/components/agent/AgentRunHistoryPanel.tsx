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
          className="px-3 py-2 text-xs"
          style={{ borderRadius: '0.7rem', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', background: 'transparent' }}
        >
          刷新历史
        </button>
      </div>
      {runs.length ? (
        <div className="space-y-2">
          {runs.slice(0, 8).map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => void onSelect(run.id)}
              className="block w-full p-3 text-left"
              style={{
                borderRadius: '0.85rem',
                border: `1px solid ${run.id === currentRunId ? 'rgba(103,232,249,0.45)' : 'var(--border-dim)'}`,
                background: run.id === currentRunId ? 'rgba(6,182,212,0.10)' : 'rgba(255,255,255,0.02)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold" style={{ color: 'var(--text-main)' }}>{run.taskType ?? run.agentType ?? 'agent_run'}</span>
                <span className="text-[11px]" style={{ color: run.status === 'failed' ? '#fb7185' : run.status === 'succeeded' ? '#86efac' : '#fbbf24' }}>{run.status}</span>
              </div>
              <div className="mt-2 line-clamp-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{run.goal}</div>
              <div className="mt-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>{formatDate(run.updatedAt ?? run.createdAt)} · {run.id.slice(0, 8)}</div>
            </button>
          ))}
        </div>
      ) : (
        <EmptyText text="暂无历史 Run。" />
      )}
    </section>
  );
}
