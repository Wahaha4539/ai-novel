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
            <div className="stat-card">
              <div className="stat-card__label">新增问题</div>
              <div className="stat-card__value" style={{ color: 'var(--accent-cyan)' }}>{validationRunResult.createdCount}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">替换旧问题</div>
              <div className="stat-card__value">{validationRunResult.deletedCount}</div>
            </div>
          </div>
          <div className="space-y-2">
            {validationRunResult.issues.slice(0, 5).map((issue, index) => (
              <div key={`${issue.issueType}-${index}`} className="list-card">
                <div className="flex items-center gap-2 mb-2">
                  <StatusBadge value={issue.severity} />
                  <span className="text-heading font-medium text-sm">{issue.issueType}</span>
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
