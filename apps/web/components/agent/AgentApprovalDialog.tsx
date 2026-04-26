'use client';

interface AgentApprovalDialogProps {
  canAct: boolean;
  canRetry: boolean;
  loading: boolean;
  status?: string;
  hasCurrentRun: boolean;
  onCancel: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onAct: () => void | Promise<void>;
}

/** AgentApprovalDialog 集中展示写入审批、取消和失败重试操作。 */
export function AgentApprovalDialog({ canAct, canRetry, loading, status, hasCurrentRun, onCancel, onRetry, onAct }: AgentApprovalDialogProps) {
  return (
    <div className="panel p-5 flex flex-wrap items-center justify-between gap-4" style={{ borderColor: canAct ? 'rgba(34,197,94,0.35)' : 'var(--border-dim)' }}>
      <div>
        <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>审批控制台</div>
        <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>确认后会执行计划中的写入、校验或记忆回写步骤；此操作同时作为高风险/事实覆盖/删除类副作用的二次确认。</div>
      </div>
      <div className="flex gap-3">
        {hasCurrentRun && <button onClick={() => void onCancel()} disabled={loading || status === 'succeeded'} className="px-4 py-3 text-sm" style={{ borderRadius: '0.8rem', border: '1px solid var(--status-err)', color: 'var(--status-err)', background: 'transparent', opacity: status === 'succeeded' ? 0.5 : 1 }}>取消</button>}
        {hasCurrentRun && <button onClick={() => void onRetry()} disabled={!canRetry || loading} className="px-4 py-3 text-sm font-bold" style={{ borderRadius: '0.8rem', border: '1px solid rgba(251,191,36,0.45)', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', opacity: !canRetry || loading ? 0.5 : 1 }}>失败重试</button>}
        <button onClick={() => void onAct()} disabled={!canAct || loading} className="px-5 py-3 text-sm font-bold" style={{ borderRadius: '0.8rem', border: 'none', color: '#03140b', background: 'linear-gradient(135deg, #86efac, #22d3ee)', opacity: !canAct || loading ? 0.5 : 1 }}>确认执行</button>
      </div>
    </div>
  );
}