import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ValidationRunResult } from '../types/dashboard';

interface Props {
  selectedProjectId: string;
  loading: boolean;
  validationRunResult: ValidationRunResult | null;
  onRunValidation: () => void;
}

export function ValidationConsolePanel({ selectedProjectId, loading, validationRunResult, onRunValidation }: Props) {
  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.1s', animationFillMode: 'both' }}>
      <SectionHeader title="事实校验器" desc="运行 Phase 4 前置硬规则：时间线、死亡角色、伏笔首次出现。" />
      <div className="mt-5 flex flex-wrap gap-3">
        <button className="btn" disabled={!selectedProjectId || loading} onClick={onRunValidation}>
          运行硬规则校验
        </button>
      </div>
      {validationRunResult ? (
        <div className="mt-5 space-y-3">
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="p-3" style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '12px', border: '1px solid var(--border-light)', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)' }}>
              <div className="text-xs" style={{ color: 'var(--text-dim)' }}>新增问题</div>
              <div className="mt-1 text-xl font-bold" style={{ color: 'var(--accent-cyan)' }}>{validationRunResult.createdCount}</div>
            </div>
            <div className="p-3" style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '12px', border: '1px solid var(--border-light)', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)' }}>
              <div className="text-xs" style={{ color: 'var(--text-dim)' }}>替换旧问题</div>
              <div className="mt-1 text-xl font-bold" style={{ color: 'var(--text-main)' }}>{validationRunResult.deletedCount}</div>
            </div>
          </div>
          <div className="space-y-2">
            {validationRunResult.issues.slice(0, 5).map((issue, index) => (
              <div key={`${issue.issueType}-${index}`} className="list-card">
                <div className="flex items-center gap-2 mb-2">
                  <StatusBadge value={issue.severity} />
                  <span className="text-white font-medium text-sm">{issue.issueType}</span>
                </div>
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{issue.message}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-5 text-sm list-card-empty">
          运行后将展示本轮校验生成的问题摘要。
        </p>
      )}
    </article>
  );
}
